import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  createAgentActivityObserver,
  DEFAULT_STALL_MS,
  type ActivitySnapshot,
} from './activity.js';

// SDKMessage shape builders — mirror the union members the observer cares
// about (assistant content blocks; everything else is just a liveness tick).
function asstTool(name: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'thinking' },
        { type: 'tool_use', name },
      ],
    },
  } as unknown as SDKMessage;
}
function asstText(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  } as unknown as SDKMessage;
}
function streamEvent(): SDKMessage {
  return { type: 'stream_event' } as unknown as SDKMessage;
}
function resultMsg(): SDKMessage {
  return { type: 'result', subtype: 'success', session_id: 's' } as unknown as SDKMessage;
}

describe('createAgentActivityObserver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('first message of a turn emits working with the trailing tool name', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage('coder', asstTool('Bash'));
    expect(emits).toHaveLength(1);
    expect(emits[0]).toMatchObject({ agentName: 'coder', phase: 'working', currentTool: 'Bash' });
    expect(typeof emits[0]!.turnStartedAt).toBe('number');
  });

  test('text-only / stream_event keep working and do not emit idle', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage('coder', asstText('reasoning'));
    vi.advanceTimersByTime(1100); // pass the 1s debounce window
    obs.onMessage('coder', streamEvent());
    expect(emits.every((e) => e.phase === 'working')).toBe(true);
    // assistant text → no tool; stream_event carries the tool forward (none).
    expect(emits.at(-1)!.currentTool).toBeUndefined();
  });

  test('tool name updates as the agent moves between tools', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage('coder', asstTool('Read'));
    obs.onMessage('coder', asstTool('Bash')); // tool edge → emits despite <1s
    const tools = emits.filter((e) => e.phase === 'working').map((e) => e.currentTool);
    expect(tools).toEqual(['Read', 'Bash']);
  });

  test('no message for the stall window emits exactly one stalled', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage('coder', asstTool('Bash'));
    vi.advanceTimersByTime(DEFAULT_STALL_MS + 50);
    const stalls = emits.filter((e) => e.phase === 'stalled');
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({ agentName: 'coder', currentTool: 'Bash' });
    // Not re-armed: more idle time does not produce a second stall.
    vi.advanceTimersByTime(DEFAULT_STALL_MS * 2);
    expect(emits.filter((e) => e.phase === 'stalled')).toHaveLength(1);
  });

  test('a message before the stall window re-arms and never emits stalled', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage('coder', asstTool('Bash'));
    vi.advanceTimersByTime(DEFAULT_STALL_MS - 1000);
    obs.onMessage('coder', streamEvent()); // re-arms the timer
    vi.advanceTimersByTime(DEFAULT_STALL_MS - 1000);
    expect(emits.some((e) => e.phase === 'stalled')).toBe(false);
  });

  test('stalled then a later message recovers to working', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage('coder', asstTool('Bash'));
    vi.advanceTimersByTime(DEFAULT_STALL_MS + 50);
    obs.onMessage('coder', asstText('back'));
    expect(emits.map((e) => e.phase)).toEqual(['working', 'stalled', 'working']);
  });

  test('onTurnEnd emits idle, clears the slot, and the next turn is fresh', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage('coder', asstTool('Bash'));
    const firstStart = emits[0]!.turnStartedAt;
    vi.advanceTimersByTime(5000);
    obs.onTurnEnd('coder');
    expect(emits.at(-1)).toMatchObject({ agentName: 'coder', phase: 'idle' });

    vi.advanceTimersByTime(5000);
    obs.onMessage('coder', asstText('next turn'));
    const restart = emits.at(-1)!;
    expect(restart.phase).toBe('working');
    expect(restart.turnStartedAt).toBeGreaterThan(firstStart);
    // The cleared slot means the old stall timer can't fire anymore.
    vi.advanceTimersByTime(DEFAULT_STALL_MS * 3);
    expect(emits.filter((e) => e.phase === 'stalled')).toHaveLength(1); // only the new turn's
  });

  test('onTurnEnd with no in-flight turn is a no-op (no idle emit)', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onTurnEnd('ghost');
    expect(emits).toHaveLength(0);
  });

  test('debounce: identical (phase,tool) ticks within 1s do not re-emit', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage('coder', asstTool('Bash'));
    obs.onMessage('coder', asstTool('Bash')); // same tool, <1s
    obs.onMessage('coder', asstTool('Bash'));
    expect(emits.filter((e) => e.phase === 'working')).toHaveLength(1);
    vi.advanceTimersByTime(1100);
    obs.onMessage('coder', asstTool('Bash')); // now past throttle → re-emit
    expect(emits.filter((e) => e.phase === 'working')).toHaveLength(2);
  });

  test('dispose clears pending timers (no stalled after teardown)', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage('coder', asstTool('Bash'));
    obs.dispose();
    vi.advanceTimersByTime(DEFAULT_STALL_MS * 2);
    expect(emits.some((e) => e.phase === 'stalled')).toBe(false);
  });

  test('two agents are tracked independently', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage('coder', asstTool('Bash'));
    obs.onMessage('reviewer', asstTool('Read'));
    obs.onTurnEnd('coder');
    expect(emits.find((e) => e.agentName === 'reviewer')).toMatchObject({
      phase: 'working',
      currentTool: 'Read',
    });
    // reviewer still in-flight → its stall timer still fires.
    vi.advanceTimersByTime(DEFAULT_STALL_MS + 50);
    expect(emits.some((e) => e.agentName === 'reviewer' && e.phase === 'stalled')).toBe(true);
    expect(emits.some((e) => e.agentName === 'coder' && e.phase === 'stalled')).toBe(false);
    obs.dispose();
  });

  test('ignores result/system tick types for tool derivation but treats them as liveness', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage('coder', asstTool('Bash'));
    vi.advanceTimersByTime(1100);
    obs.onMessage('coder', resultMsg()); // liveness tick, tool carried forward
    const last = emits.at(-1)!;
    expect(last.phase).toBe('working');
    expect(last.currentTool).toBe('Bash');
  });
});
