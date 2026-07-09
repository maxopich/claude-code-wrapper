import { describe, expect, test } from 'vitest';
import { formatElapsed } from './format';
import {
  activeAgent,
  initialState,
  pendingToolName,
  reduce,
  sessionPhase,
  type MessageView,
  type MultiAgentEventView,
  type MultiAgentRun,
  type SessionView,
} from './store';

const PID = 1;

function sess(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    projectId: PID,
    status: 'running',
    messages: [],
    streamingText: '',
    runStartedAt: Date.now(),
    heldMessages: [],
    ...over,
  };
}

const asstText = (t: string): MessageView => ({
  kind: 'assistant',
  id: 'a',
  blocks: [{ type: 'text', text: t }],
});
const asstToolUse = (name: string): MessageView => ({
  kind: 'assistant',
  id: 'a',
  blocks: [
    { type: 'text', text: 'let me check' },
    { type: 'tool_use', id: 't1', name, input: {} },
  ],
});
const toolResult: MessageView = {
  kind: 'system',
  id: 'r',
  subtype: 'tool_result',
  text: 'ok',
};

describe('formatElapsed', () => {
  test('M:SS and clamping', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(7_000)).toBe('0:07');
    expect(formatElapsed(107_000)).toBe('1:47');
    expect(formatElapsed(723_000)).toBe('12:03');
    expect(formatElapsed(-5_000)).toBe('0:00');
    expect(formatElapsed(Number.NaN)).toBe('0:00');
  });
  test('rolls into H:MM:SS past an hour', () => {
    expect(formatElapsed(3_600_000)).toBe('1:00:00');
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
  });
});

describe('sessionPhase', () => {
  test('terminal + idle states', () => {
    expect(sessionPhase(sess({ status: 'error' }), false)).toBe('error');
    expect(sessionPhase(sess({ status: 'done' }), false)).toBe('done');
    expect(sessionPhase(sess({ status: 'idle' }), false)).toBe('idle');
  });

  test('isLive backstops the optimistic status', () => {
    // status not running but server says the session is live → still active.
    expect(sessionPhase(sess({ status: 'idle' }), true)).toBe('thinking');
  });

  test('thinking: running with no streaming text and no pending tool', () => {
    expect(sessionPhase(sess(), false)).toBe('thinking');
    expect(sessionPhase(sess({ messages: [asstText('hi')] }), false)).toBe('thinking');
  });

  test('streaming wins over everything but permission/terminal', () => {
    expect(sessionPhase(sess({ streamingText: 'partial' }), false)).toBe('streaming');
  });

  test('tool-running between tool_use and its tool_result', () => {
    expect(sessionPhase(sess({ messages: [asstToolUse('Bash')] }), false)).toBe('tool-running');
    // resolved once the tool_result system message lands → back to thinking
    expect(sessionPhase(sess({ messages: [asstToolUse('Bash'), toolResult] }), false)).toBe(
      'thinking',
    );
  });

  test('awaiting-permission for an undecided permission card', () => {
    const card: MessageView = {
      kind: 'permission_request',
      id: 'p',
      requestId: 'rq1',
      toolName: 'Write',
      input: {},
    };
    expect(sessionPhase(sess({ messages: [asstToolUse('Write'), card] }), false)).toBe(
      'awaiting-permission',
    );
    // once decided, the card no longer blocks the indicator
    expect(
      sessionPhase(
        sess({ messages: [asstToolUse('Write'), { ...card, decided: 'allow' }] }),
        false,
      ),
    ).toBe('tool-running');
  });
});

describe('pendingToolName', () => {
  test('reports the in-flight tool, undefined once resolved or absent', () => {
    expect(pendingToolName(sess({ messages: [asstToolUse('Bash')] }))).toBe('Bash');
    expect(pendingToolName(sess({ messages: [asstToolUse('Bash'), toolResult] }))).toBeUndefined();
    expect(pendingToolName(sess({ messages: [asstText('no tools here')] }))).toBeUndefined();
  });
});

function ev(over: Partial<MultiAgentEventView>): MultiAgentEventView {
  return {
    eventId: 1,
    ts: Date.now(),
    source: 'cebab',
    destination: 'a',
    kind: 'prompt',
    text: '',
    ...over,
  };
}
function run(over: Partial<MultiAgentRun> = {}): MultiAgentRun {
  return {
    sessionId: 'm1',
    mode: 'chain',
    participantAgentNames: ['a', 'b', 'c'],
    status: 'running',
    events: [],
    iterationId: null,
    lifecycle: 'persistent',
    sessionFolder: '/tmp/m1',
    awaitingContinue: false,
    activity: null,
    hopBudget: 30,
    pendingRetry: null,
    pauseOnDangerous: false,
    executeMode: false,
    mutationsAcknowledged: false,
    mutations: [],
    pendingMutation: null,
    pendingQuestion: null,
    recoveryContext: null,
    routerDrops: [],
    participantControls: {},
    modelsByProject: {},
    ...over,
  };
}

describe('activeAgent', () => {
  test('null when not running or no events', () => {
    expect(activeAgent(run({ status: 'completed' }))).toBeNull();
    expect(activeAgent(run({ status: 'crashed' }))).toBeNull();
    expect(activeAgent(run({ events: [] }))).toBeNull();
  });

  test('chain linear handoff: last destination is the agent now computing', () => {
    expect(activeAgent(run({ events: [ev({ source: 'cebab', destination: 'a' })] }))).toBe('a');
    expect(
      activeAgent(
        run({
          events: [
            ev({ source: 'cebab', destination: 'a', kind: 'prompt' }),
            ev({ source: 'a', destination: 'b', kind: 'reply' }),
          ],
        }),
      ),
    ).toBe('b');
  });

  test('orchestrator re-activation: reply back to the hub re-marks the hub', () => {
    const r = run({
      mode: 'orchestrator',
      participantAgentNames: ['orchestrator', 'coder'],
      events: [
        ev({ source: 'cebab', destination: 'orchestrator', kind: 'prompt' }),
        ev({ source: 'orchestrator', destination: 'coder', kind: 'prompt' }),
        ev({ source: 'coder', destination: 'orchestrator', kind: 'reply' }),
      ],
    });
    expect(activeAgent(r)).toBe('orchestrator');
  });

  test('sentinel / error tails mean nobody is computing', () => {
    expect(
      activeAgent(run({ events: [ev({ source: 'c', destination: '_sink', kind: 'final' })] })),
    ).toBeNull();
    expect(
      activeAgent(
        run({
          mode: 'orchestrator',
          events: [ev({ source: 'orchestrator', destination: 'user', kind: 'final' })],
        }),
      ),
    ).toBeNull();
    expect(
      activeAgent(run({ events: [ev({ source: 'a', destination: 'b', kind: 'error' })] })),
    ).toBeNull();
  });
});

describe('store wiring / runStartedAt', () => {
  test('user_send anchors it, result clears it, migration preserves it', () => {
    let s = reduce(initialState, { type: 'select_project', projectId: PID });
    s = reduce(s, { type: 'user_send', text: 'hello' });
    const started = s.sessionsByProject[PID]![Object.keys(s.sessionsByProject[PID]!)[0]!]!;
    expect(typeof started.runStartedAt).toBe('number');

    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'real-1',
        projectId: PID,
        model: 'opus',
        tools: [],
      },
    });
    // migrated session keeps the original send-time anchor (wait started at send)
    expect(s.sessionsByProject[PID]!['real-1']!.runStartedAt).toBe(started.runStartedAt);

    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'result',
        sessionId: 'real-1',
        subtype: 'success',
        durationMs: 1,
        totalCostUsd: 0,
      },
    });
    expect(s.sessionsByProject[PID]!['real-1']!.runStartedAt).toBeNull();
  });
});
