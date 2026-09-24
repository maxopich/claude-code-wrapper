import { describe, expect, test } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import type { SessionView } from '../../store';
import { sessionPhase, pendingToolName } from '../../store';
import { assistantReducer } from './assistantReducer';

// Cebab-8x8.3.2: the pure message reducer for the floating assistant.
//
//   - session_started adopts (fresh) or migrates (keeps scrollback) the one
//     assistant session.
//   - Session-keyed messages self-gate on the adopted id — an unrelated
//     session's stream returns the SAME reference (no panel rerender).
//   - The 7-field SessionView it produces feeds sessionPhase()/pendingToolName()
//     verbatim, so the activity phase can't drift from the main chat.

const ASSISTANT_PID = 99;
const SID = 'sess-assistant-1';

function started(sessionId = SID, projectId = ASSISTANT_PID): ServerMsg {
  return { type: 'session_started', sessionId, projectId, model: 'claude-opus-4-8', tools: [] };
}

function adopt(): SessionView {
  const s = assistantReducer(null, started());
  if (!s) throw new Error('expected a session');
  return s;
}

describe('assistantReducer / session adoption', () => {
  test('session_started on a null state creates a fresh running SessionView', () => {
    const s = adopt();
    expect(s.id).toBe(SID);
    expect(s.projectId).toBe(ASSISTANT_PID);
    expect(s.status).toBe('running');
    expect(s.messages).toEqual([]);
    expect(s.streamingText).toBe('');
    expect(s.heldMessages).toEqual([]);
    expect(typeof s.runStartedAt).toBe('number');
  });

  test('session_started migrates an existing (optimistic) session, keeping messages', () => {
    // Simulate the optimistic pending session an operator's first send makes.
    const pending: SessionView = {
      id: 'assistant-pending',
      projectId: ASSISTANT_PID,
      status: 'running',
      messages: [{ kind: 'user', id: 'u1', text: 'hi' }],
      streamingText: '',
      runStartedAt: 123,
      heldMessages: [],
    };
    const migrated = assistantReducer(pending, started('real-sid'));
    expect(migrated?.id).toBe('real-sid');
    expect(migrated?.messages).toEqual([{ kind: 'user', id: 'u1', text: 'hi' }]);
    expect(migrated?.status).toBe('running');
  });
});

describe('assistantReducer / session-keyed message gating', () => {
  test('a message for a different session returns the SAME reference', () => {
    const s = adopt();
    const out = assistantReducer(s, {
      type: 'stream_delta',
      sessionId: 'some-other-session',
      uuid: 'x',
      delta: { kind: 'text', blockIndex: 0, text: 'nope' },
    });
    expect(out).toBe(s);
  });

  test('a session-keyed message before any session exists is a no-op', () => {
    const out = assistantReducer(null, {
      type: 'assistant_message',
      sessionId: SID,
      uuid: 'a1',
      blocks: [{ type: 'text', text: 'hi' }],
    });
    expect(out).toBeNull();
  });
});

describe('assistantReducer / streaming + finalization', () => {
  test('stream_delta text accumulates onto streamingText', () => {
    let s = adopt();
    s = assistantReducer(s, {
      type: 'stream_delta',
      sessionId: SID,
      uuid: 'a',
      delta: { kind: 'text', blockIndex: 0, text: 'Hel' },
    })!;
    s = assistantReducer(s, {
      type: 'stream_delta',
      sessionId: SID,
      uuid: 'a',
      delta: { kind: 'text', blockIndex: 0, text: 'lo' },
    })!;
    expect(s.streamingText).toBe('Hello');
    expect(sessionPhase(s, true)).toBe('streaming');
  });

  test('input_json deltas do not touch streamingText', () => {
    const s = adopt();
    const out = assistantReducer(s, {
      type: 'stream_delta',
      sessionId: SID,
      uuid: 'a',
      delta: { kind: 'input_json', blockIndex: 0, partialJson: '{"a":' },
    });
    expect(out).toBe(s);
  });

  test('assistant_message appends the finalized turn and clears the stream buffer', () => {
    let s = adopt();
    s = assistantReducer(s, {
      type: 'stream_delta',
      sessionId: SID,
      uuid: 'a',
      delta: { kind: 'text', blockIndex: 0, text: 'partial' },
    })!;
    s = assistantReducer(s, {
      type: 'assistant_message',
      sessionId: SID,
      uuid: 'msg-1',
      blocks: [{ type: 'text', text: 'done' }],
    })!;
    expect(s.streamingText).toBe('');
    expect(s.messages).toEqual([
      { kind: 'assistant', id: 'msg-1', blocks: [{ type: 'text', text: 'done' }] },
    ]);
  });
});

describe('assistantReducer / tool results (must render, incl. errors)', () => {
  test('a tool_result error arrives as a user_message and is stored as a system error card', () => {
    let s = adopt();
    // First an assistant tool_use so the tool name resolves.
    s = assistantReducer(s, {
      type: 'assistant_message',
      sessionId: SID,
      uuid: 'm1',
      blocks: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }],
    })!;
    s = assistantReducer(s, {
      type: 'user_message',
      sessionId: SID,
      uuid: 'u1',
      blocks: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'permission denied',
          is_error: true,
        },
      ],
    })!;
    const last = s.messages[s.messages.length - 1];
    expect(last.kind).toBe('system');
    if (last.kind === 'system') {
      expect(last.subtype).toBe('tool_result');
      expect(last.isError).toBe(true);
      expect(last.toolName).toBe('Bash');
      expect(last.text).toContain('permission denied');
    }
  });
});

describe('assistantReducer / turn end', () => {
  test('result success → done and clears runStartedAt/stream', () => {
    let s = adopt();
    s = assistantReducer(s, {
      type: 'result',
      sessionId: SID,
      subtype: 'success',
      durationMs: 10,
      totalCostUsd: 0.01,
    })!;
    expect(s.status).toBe('done');
    expect(s.runStartedAt).toBeNull();
    expect(s.streamingText).toBe('');
    expect(sessionPhase(s, false)).toBe('done');
  });

  test('result error subtype → error', () => {
    let s = adopt();
    s = assistantReducer(s, {
      type: 'result',
      sessionId: SID,
      subtype: 'error_during_execution',
      durationMs: 10,
      totalCostUsd: 0,
    })!;
    expect(s.status).toBe('error');
    expect(sessionPhase(s, false)).toBe('error');
  });
});

describe('assistantReducer / pendingToolName pairing is reused, not duplicated', () => {
  test('a trailing tool_use with no result reports tool-running', () => {
    let s = adopt();
    s = assistantReducer(s, {
      type: 'assistant_message',
      sessionId: SID,
      uuid: 'm1',
      blocks: [{ type: 'tool_use', id: 'tool-9', name: 'Read', input: {} }],
    })!;
    expect(sessionPhase(s, true)).toBe('tool-running');
    expect(pendingToolName(s)).toBe('Read');
  });
});

// Cebab-eo71: the reducer no longer ignores session_running / wrapper_error, so
// a failed turn ends with a visible outcome instead of spinning forever.
describe('assistantReducer / session_running framing', () => {
  function pending(): SessionView {
    return {
      id: 'assistant-pending',
      projectId: ASSISTANT_PID,
      status: 'running',
      messages: [{ kind: 'user', id: 'u1', text: 'how do I copy an agent?' }],
      streamingText: '',
      runStartedAt: 123,
      heldMessages: [],
    };
  }

  test('running:true adopts the id from the pending placeholder and keeps the message', () => {
    const migrated = assistantReducer(pending(), {
      type: 'session_running',
      projectId: ASSISTANT_PID,
      sessionId: SID,
      running: true,
    });
    expect(migrated?.id).toBe(SID);
    expect(migrated?.status).toBe('running');
    expect(migrated?.messages).toEqual([
      { kind: 'user', id: 'u1', text: 'how do I copy an agent?' },
    ]);
  });

  test('running:false while still running flips the session to done', () => {
    const s = adopt();
    expect(s.status).toBe('running');
    const done = assistantReducer(s, {
      type: 'session_running',
      projectId: ASSISTANT_PID,
      sessionId: SID,
      running: false,
    });
    expect(done?.status).toBe('done');
    expect(done?.runStartedAt).toBeNull();
  });

  test('running:false after a result leaves the ended status unchanged', () => {
    let s = adopt();
    s = assistantReducer(s, {
      type: 'result',
      sessionId: SID,
      subtype: 'success',
      durationMs: 5,
      totalCostUsd: 0.01,
    })!;
    expect(s.status).toBe('done');
    const out = assistantReducer(s, {
      type: 'session_running',
      projectId: ASSISTANT_PID,
      sessionId: SID,
      running: false,
    });
    // Same reference out — nothing changed, so the panel doesn't rerender.
    expect(out).toBe(s);
    expect(out?.status).toBe('done');
  });
});

describe('assistantReducer / wrapper_error ends the turn', () => {
  test('a process_crashed failure gives status error plus an error view', () => {
    let s = adopt();
    s = assistantReducer(s, {
      type: 'stream_delta',
      sessionId: SID,
      uuid: 'a',
      delta: { kind: 'text', blockIndex: 0, text: 'half an answer' },
    })!;
    const out = assistantReducer(s, {
      type: 'wrapper_error',
      sessionId: SID,
      kind: 'process_crashed',
      message: 'exit 1: boom',
    })!;
    expect(out.status).toBe('error');
    expect(out.runStartedAt).toBeNull();
    expect(out.streamingText).toBe('');
    const last = out.messages[out.messages.length - 1];
    expect(last.kind).toBe('error');
    if (last.kind === 'error') {
      expect(last.errorKind).toBe('process_crashed');
      expect(last.message).toBe('exit 1: boom');
    }
  });

  test('an aborted failure gives status done plus a neutral cancelled view', () => {
    const s = adopt();
    const out = assistantReducer(s, {
      type: 'wrapper_error',
      sessionId: SID,
      kind: 'aborted',
      message: 'the SDK abort text',
    })!;
    expect(out.status).toBe('done');
    expect(out.runStartedAt).toBeNull();
    const last = out.messages[out.messages.length - 1];
    expect(last.kind).toBe('cancelled');
    if (last.kind === 'cancelled') {
      // cancelledLine maps the non-"Turn cancelled:" text to the neutral line.
      expect(last.message).toBe('Stopped by you');
    }
  });
});
