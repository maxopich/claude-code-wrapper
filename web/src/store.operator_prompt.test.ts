import { describe, expect, test } from 'vitest';
import { initialState, reduce, type AppState, type MessageView } from './store';

/**
 * `Cebab-ibb4`: a replayed prompt is the OPERATOR'S, not the tool's.
 *
 * The SDK puts tool_result blocks in `user` messages, so the reducer folds
 * every `user_message` into a tool-output card — correct, and measured across
 * nine session logs at the time. Then `persistOperatorPrompt` started writing
 * the operator's own prompt as a `type: 'user'` row so replay would stop
 * dropping it, on the stated premise that "the web store already renders it".
 * It rendered it as something the tool said: on replay the operator's question
 * and a grep's output were the same card with the same label, with no field
 * distinguishing them.
 *
 * Both directions are asserted, and the second is the one that matters more —
 * a marker that also fired on tool output would relabel every tool result in
 * every session as the operator's own words.
 */

const PID = 1;

function open(state: AppState = initialState, projectId = PID): AppState {
  return reduce(state, { type: 'select_project', projectId });
}

function started(state: AppState, sessionId: string, projectId = PID): AppState {
  return reduce(state, {
    type: 'server',
    msg: { type: 'session_started', sessionId, projectId, model: 'opus-5', tools: [] },
  });
}

function messages(s: AppState, sessionId: string, projectId = PID): MessageView[] {
  return s.sessionsByProject[projectId]?.[sessionId]?.messages ?? [];
}

/** The last message, which is the one each case just produced. */
function last(s: AppState, sessionId: string): MessageView | undefined {
  const ms = messages(s, sessionId);
  return ms[ms.length - 1];
}

describe('user_message with the operator-prompt marker', () => {
  test('replays as the operator’s own message, not as tool output', () => {
    let s = started(open(), 'sess-1');
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'user_message',
        sessionId: 'sess-1',
        uuid: 'row-9',
        blocks: [{ type: 'text', text: 'why did the build fail?' }],
        origin: 'operator_prompt',
      },
    });
    expect(last(s, 'sess-1')).toEqual({
      kind: 'user',
      id: 'row-9',
      text: 'why did the build fail?',
    });
  });

  test('keeps the persisted row’s uuid as the message id', () => {
    // A replay can run again over a bucket that already has rows; a stable id
    // is what lets React keep the row it has instead of remounting every
    // prompt in the session.
    const s = started(open(), 'sess-1');
    const send = (uuid: string) =>
      reduce(s, {
        type: 'server',
        msg: {
          type: 'user_message',
          sessionId: 'sess-1',
          uuid,
          blocks: [{ type: 'text', text: 'hello' }],
          origin: 'operator_prompt',
        },
      });
    expect(last(send('row-a'), 'sess-1')?.id).toBe('row-a');
    expect(last(send('row-b'), 'sess-1')?.id).toBe('row-b');
  });

  test('WITHOUT the marker it is still tool output — the fold is the default', () => {
    // The anti-vacuity half. If the new branch fired on every `user_message`,
    // every tool result in every replayed session would be relabelled as the
    // operator's own words, and the case above would still pass.
    let s = started(open(), 'sess-1');
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'user_message',
        sessionId: 'sess-1',
        uuid: 'row-9',
        blocks: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'PASS 41 tests' }],
      },
    });
    const m = last(s, 'sess-1');
    expect(m?.kind).toBe('system');
    expect(m?.kind === 'system' && m.subtype).toBe('tool_result');
  });

  test('an is_error tool result still carries its error flag', () => {
    // The marker branch returns early, so the flags computed below it must
    // still be reached by everything that is not a prompt.
    let s = started(open(), 'sess-1');
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'user_message',
        sessionId: 'sess-1',
        uuid: 'row-9',
        blocks: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'boom', is_error: true }],
      },
    });
    const m = last(s, 'sess-1');
    expect(m?.kind === 'system' && m.isError).toBe(true);
  });
});
