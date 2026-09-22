import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  createAgentActivityObserver,
  DEFAULT_STALL_MS,
  type ActivitySnapshot,
} from './activity.js';

// SDKMessage shape builders — mirror the union members the observer cares
// about (assistant content blocks; everything else is just a liveness tick).
function asstTool(name: string, input?: unknown): SDKMessage {
  return {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'thinking' },
        { type: 'tool_use', name, input },
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
function systemInit(model: string): SDKMessage {
  return { type: 'system', subtype: 'init', model } as unknown as SDKMessage;
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

  // `Cebab-ut7`: the observer harvests the participant's model from the
  // `system/init` that opens every per-hop query() and carries it forward,
  // so the bus finally has a model signal on the wire.
  test('captures the model from system/init and carries it forward all turn', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    // A tick before init has no model yet — undefined, not a guess.
    obs.onMessage('coder', asstText('booting'));
    expect(emits.at(-1)!.model).toBeUndefined();
    // system/init arrives and is captured; it's a debounced liveness tick
    // (no phase/tool edge), so the value surfaces on the next emitted tick —
    // a tool edge here forces one, and it carries the model.
    obs.onMessage('coder', systemInit('claude-sonnet-4-5-20250929'));
    obs.onMessage('coder', asstTool('Bash')); // tool edge → emits
    expect(emits.at(-1)!.model).toBe('claude-sonnet-4-5-20250929');
    // The stall edge keeps it too — it's the same turn.
    vi.advanceTimersByTime(DEFAULT_STALL_MS + 50);
    expect(emits.at(-1)!).toMatchObject({ phase: 'stalled', model: 'claude-sonnet-4-5-20250929' });
  });

  // `Cebab-ygu.48`: the observer carries the operator-readable summary for the
  // trailing tool call — the "what is it working on" line — not just the bare
  // tool name. The formatter is the SHARED `toolActivity`, the same one the
  // single-agent chat renders, so the two surfaces cannot describe the same
  // tool call differently.
  test('carries the shared toolActivity summary for the trailing tool call', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage('coder', asstTool('Read', { file_path: '/repo/src/module_07.js' }));
    expect(emits.at(-1)).toMatchObject({
      phase: 'working',
      currentTool: 'Read',
      currentSummary: 'reading repo/src/module_07.js',
    });
  });

  test('a same-tool step to a new file emits promptly (summary edge, within throttle)', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    // A 15-file Read loop: the tool NAME never changes, so without a summary
    // edge each new file would wait out the 1s throttle. The summary must move
    // the line immediately even though `currentTool` stays `Read`.
    obs.onMessage('coder', asstTool('Read', { file_path: '/a.ts' }));
    obs.onMessage('coder', asstTool('Read', { file_path: '/b.ts' })); // <1s, same tool
    const summaries = emits.filter((e) => e.phase === 'working').map((e) => e.currentSummary);
    expect(summaries).toEqual(['reading a.ts', 'reading b.ts']);
  });

  test('a reasoning tick clears the summary along with the tool', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage('coder', asstTool('Grep', { pattern: 'refundCharge', path: 'src' }));
    expect(emits.at(-1)!.currentSummary).toBe('searching for refundCharge');
    obs.onMessage('coder', asstText('now reasoning')); // trailing text → no tool
    expect(emits.at(-1)).toMatchObject({ currentTool: undefined, currentSummary: undefined });
  });

  test('onTurnEnd idle clears the summary', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage('coder', asstTool('Read', { file_path: '/x.ts' }));
    obs.onTurnEnd('coder');
    expect(emits.at(-1)).toMatchObject({ phase: 'idle', currentSummary: undefined });
  });

  // `Cebab-ygu.48`: the summary is built from MODEL-WRITTEN tool input and is
  // rendered into a DOM text node, so the three cases below are the reason the
  // formatter is `toolActivity` and not `classifyToolCall(...).summary`. Each
  // one was MEASURED against the latter and failed: it escapes `\n` only, and
  // its `mcp__*` arm returns a raw JSON peek of the input. Swapping the
  // formatter back reddens all three.
  //
  // Assembled from char codes so this source file carries no literal control
  // characters — some of the tooling that reads it refuses them outright.
  const LINE_SEP = String.fromCharCode(0x2028);
  const BIDI_OVERRIDE = String.fromCharCode(0x202e);
  const CTRL_OR_FORMAT = new RegExp('[\\p{Cc}\\p{Cf}\\u2028\\u2029]', 'u');

  test('a line separator in a model-written path cannot forge a second clause', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage(
      'coder',
      asstTool('Read', { file_path: `/repo/a.ts${LINE_SEP}WORKING ON SOMETHING ELSE` }),
    );
    const summary = emits.at(-1)!.currentSummary!;
    expect(CTRL_OR_FORMAT.test(summary)).toBe(false);
    // Anti-vacuity: the injected words must not survive as their own clause.
    // Asserting only "no control chars" would pass on an implementation that
    // dropped the whole subject.
    expect(summary).toContain('a.ts');
  });

  test('a bidi override in a search pattern never reaches the wire', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage('coder', asstTool('Grep', { pattern: `x${BIDI_OVERRIDE}gnihtemos` }));
    const summary = emits.at(-1)!.currentSummary!;
    expect(CTRL_OR_FORMAT.test(summary)).toBe(false);
    expect(summary).toContain('searching for');
  });

  test('an MCP tool is NAMED, not dumped as its raw JSON input', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage(
      'coder',
      asstTool('mcp__linear__search_issues', { query: 'auth bug', teamId: 'abc-123' }),
    );
    const summary = emits.at(-1)!.currentSummary!;
    // The flattened one-string form the wire carries; the chat weights the two
    // halves differently and renders the server as a parenthetical. Same
    // formatter either way — that is the point of sharing it.
    expect(summary).toBe('calling search_issues linear');
    // The operator's own workload is MCP-heavy, so this is the common case and
    // not an edge one. A JSON peek here would put the tool's arguments — and
    // whatever the model wrote into them — on the status line.
    expect(summary).not.toContain('{');
    expect(summary).not.toContain('auth bug');
  });

  test('a long shell command is clipped, not shipped whole to every socket', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    const command = `find . -type f -name '*.ts' ${'-not -path ./node_modules/* '.repeat(8)}| wc -l`;
    obs.onMessage('coder', asstTool('Bash', { command }));
    const summary = emits.at(-1)!.currentSummary!;
    expect(command.length).toBeGreaterThan(200); // the input really is long
    expect(summary.length).toBeLessThanOrEqual(64);
    expect(summary.startsWith('running find . -type f')).toBe(true);
  });

  test('a malformed / empty init model never overwrites a real one, and idle carries it', () => {
    const emits: ActivitySnapshot[] = [];
    const obs = createAgentActivityObserver((s) => emits.push(s));
    obs.onMessage('coder', systemInit('claude-opus-4-1'));
    vi.advanceTimersByTime(1100);
    // An init with an empty model (malformed) is ignored, not adopted.
    obs.onMessage('coder', systemInit(''));
    expect(emits.at(-1)!.model).toBe('claude-opus-4-1');
    // Turn end still reports the model on its idle edge.
    obs.onTurnEnd('coder');
    expect(emits.at(-1)!).toMatchObject({ phase: 'idle', model: 'claude-opus-4-1' });
    // Next turn is fresh: model resets until its own init lands.
    obs.onMessage('coder', asstText('next turn'));
    expect(emits.at(-1)!.model).toBeUndefined();
  });
});
