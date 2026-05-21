import { describe, expect, test } from 'vitest';
import {
  deriveLanes,
  isRealAgent,
  splitVisibleAndOverflow,
  LANE_CAP,
  type Lane,
} from './laneDerivation';
import type { MultiAgentEventView, MultiAgentRun } from '../../store';

function ev(
  id: number,
  source: string,
  destination: string,
  kind: MultiAgentEventView['kind'],
  text = '',
  ts = id * 100,
): MultiAgentEventView {
  return { eventId: id, ts, source, destination, kind, text };
}

function makeRun(opts: {
  participantAgentNames?: string[];
  events?: MultiAgentEventView[];
}): MultiAgentRun {
  return {
    sessionId: 'r1',
    mode: 'orchestrator',
    status: 'running',
    participants: [],
    participantAgentNames: opts.participantAgentNames ?? [],
    events: opts.events ?? [],
    lifecycle: 'persistent',
    awaitingContinue: false,
    pendingRetry: null,
    activity: null,
    hopBudget: 30,
    pauseOnMutation: false,
    mutationsAcknowledged: false,
    pendingMutation: null,
    mutations: [],
  } as unknown as MultiAgentRun;
}

describe('isRealAgent', () => {
  test('rejects chrome sentinels', () => {
    expect(isRealAgent('user')).toBe(false);
    expect(isRealAgent('_sink')).toBe(false);
    expect(isRealAgent('cebab')).toBe(false);
    expect(isRealAgent('')).toBe(false);
  });
  test('accepts real agent slugs', () => {
    expect(isRealAgent('orchestrator')).toBe(true);
    expect(isRealAgent('coder')).toBe(true);
  });
});

describe('deriveLanes', () => {
  test('seeds lanes from participantAgentNames even with no events', () => {
    const lanes = deriveLanes(
      makeRun({ participantAgentNames: ['orchestrator', 'coder', 'reviewer'] }),
    );
    expect(lanes.map((l) => l.agentName)).toEqual(['orchestrator', 'coder', 'reviewer']);
    expect(lanes.every((l) => l.eventCount === 0 && l.rows.length === 0)).toBe(true);
  });

  test('excludes chrome sentinels from the lane list', () => {
    const lanes = deriveLanes(
      makeRun({
        participantAgentNames: ['orchestrator', 'user', '_sink', 'cebab', 'coder'],
        events: [ev(1, 'cebab', 'orchestrator', 'prompt'), ev(2, 'orchestrator', 'user', 'final')],
      }),
    );
    expect(lanes.map((l) => l.agentName).sort()).toEqual(['coder', 'orchestrator']);
  });

  test('outgoing hop appears in sender lane only', () => {
    const lanes = deriveLanes(
      makeRun({
        participantAgentNames: ['orchestrator', 'coder'],
        events: [ev(1, 'orchestrator', 'coder', 'prompt')],
      }),
    );
    const orch = lanes.find((l) => l.agentName === 'orchestrator')!;
    const coder = lanes.find((l) => l.agentName === 'coder')!;
    expect(orch.rows.map((r) => r.direction)).toEqual(['outgoing']);
    expect(coder.rows.map((r) => r.direction)).toEqual(['incoming']);
    expect(orch.eventCount).toBe(1);
    expect(coder.eventCount).toBe(1);
  });

  test('chrome destination (user) renders as terminal in sender lane only', () => {
    const lanes = deriveLanes(
      makeRun({
        participantAgentNames: ['orchestrator'],
        events: [ev(1, 'orchestrator', 'user', 'final')],
      }),
    );
    const orch = lanes.find((l) => l.agentName === 'orchestrator')!;
    expect(orch.rows).toHaveLength(1);
    expect(orch.rows[0]!.direction).toBe('terminal');
    // user is NOT a lane, so no incoming row anywhere.
    expect(lanes.map((l) => l.agentName)).toEqual(['orchestrator']);
  });

  test('chain-mode _sink destination is terminal in sender lane only (no phantom _sink lane)', () => {
    const lanes = deriveLanes(
      makeRun({
        participantAgentNames: ['agent-a', 'agent-b'],
        events: [ev(1, 'agent-a', 'agent-b', 'reply'), ev(2, 'agent-b', '_sink', 'final')],
      }),
    );
    expect(lanes.map((l) => l.agentName).sort()).toEqual(['agent-a', 'agent-b']);
    const b = lanes.find((l) => l.agentName === 'agent-b')!;
    // b should have: incoming-from-a + terminal-to-sink
    expect(b.rows.map((r) => r.direction)).toEqual(['incoming', 'terminal']);
  });

  test('orders lanes by most-recent-activity desc', () => {
    const lanes = deriveLanes(
      makeRun({
        participantAgentNames: ['a', 'b', 'c'],
        events: [
          ev(1, 'a', 'b', 'reply', '', 100),
          ev(2, 'b', 'c', 'reply', '', 500),
          ev(3, 'a', 'c', 'reply', '', 1000),
        ],
      }),
    );
    // a: max ts 1000; b: max ts 500; c: max ts 1000 (most recent)
    // c & a both touched at ts=1000; participant order tiebreaks
    expect(lanes[0]!.agentName).toBe('a');
    expect(lanes[1]!.agentName).toBe('c');
    expect(lanes[2]!.agentName).toBe('b');
  });

  test('idle lanes (no activity) sort after active ones in roster order', () => {
    const lanes = deriveLanes(
      makeRun({
        participantAgentNames: ['orchestrator', 'idle-a', 'idle-b', 'active'],
        events: [ev(1, 'active', 'orchestrator', 'reply', '', 500)],
      }),
    );
    // active & orchestrator both ts=500, then idle-a, idle-b (roster order).
    expect(lanes.map((l) => l.agentName)).toEqual(['orchestrator', 'active', 'idle-a', 'idle-b']);
  });

  test('event counts include both outgoing and incoming sides', () => {
    const lanes = deriveLanes(
      makeRun({
        participantAgentNames: ['a', 'b'],
        events: [ev(1, 'a', 'b', 'reply'), ev(2, 'b', 'a', 'reply'), ev(3, 'a', 'b', 'reply')],
      }),
    );
    const a = lanes.find((l) => l.agentName === 'a')!;
    const b = lanes.find((l) => l.agentName === 'b')!;
    // Each hop counts once per lane it touches: a sees all 3, b sees all 3.
    expect(a.eventCount).toBe(3);
    expect(b.eventCount).toBe(3);
  });
});

describe('splitVisibleAndOverflow', () => {
  function makeLane(name: string): Lane {
    return { agentName: name, lastActivityTs: 0, eventCount: 0, rows: [] };
  }
  test('all-visible when ≤ LANE_CAP', () => {
    const lanes = ['a', 'b', 'c'].map(makeLane);
    const { visible, overflow } = splitVisibleAndOverflow(lanes);
    expect(visible).toHaveLength(3);
    expect(overflow).toHaveLength(0);
  });
  test('overflow when > LANE_CAP', () => {
    const lanes = Array.from({ length: LANE_CAP + 2 }, (_, i) => makeLane(`a${i}`));
    const { visible, overflow } = splitVisibleAndOverflow(lanes);
    expect(visible).toHaveLength(LANE_CAP);
    expect(overflow).toHaveLength(2);
    expect(overflow[0]!.agentName).toBe(`a${LANE_CAP}`);
  });
});
