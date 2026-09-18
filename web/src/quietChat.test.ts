import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { MessageView } from './store';
import {
  groupTurns,
  isPinnedInQuietView,
  quietMessages,
  readStoredQuiet,
  rendersAnything,
  writeStoredQuiet,
} from './quietChat';

/**
 * `Cebab-ibb4`: the quiet chat's two rules.
 *
 * The cases that matter are the two SPLIT orders and the pin table. Everything
 * else here is arithmetic.
 *
 * Turn splitting has two openers because a live turn and a replayed one arrive
 * in opposite orders — `user` then `system/init` live, `system/init` then
 * `user` on replay — and getting either wrong is invisible in the other. A
 * grouper that splits only on `user` puts a whole replayed session in one turn;
 * one that splits only on `init` tears every live prompt off the turn it
 * caused. Both orders are asserted, and so is the session shape that has
 * neither (an old replay, written before the prompt was persisted at all).
 */

const user = (id: string, text = 'what changed?'): MessageView => ({ kind: 'user', id, text });
const init = (id: string): MessageView => ({
  kind: 'system',
  id,
  subtype: 'init',
  text: 'session abc • model opus • 14 tools',
});
const text = (id: string, t: string): MessageView => ({
  kind: 'assistant',
  id,
  blocks: [{ type: 'text', text: t }],
});
const textThenCall = (id: string, t: string, tool = 'Bash'): MessageView => ({
  kind: 'assistant',
  id,
  blocks: [
    { type: 'text', text: t },
    { type: 'tool_use', id: `${id}-u`, name: tool, input: { command: 'npm test' } },
  ],
});
const callOnly = (id: string, tool = 'Read'): MessageView => ({
  kind: 'assistant',
  id,
  blocks: [{ type: 'tool_use', id: `${id}-u`, name: tool, input: {} }],
});
const toolOut = (id: string): MessageView => ({
  kind: 'system',
  id,
  subtype: 'tool_result',
  text: 'PASS 41 tests',
});
const hook = (id: string, subtype: 'hook_started' | 'hook_response'): MessageView => ({
  kind: 'system',
  id,
  subtype,
  text: subtype,
});
const noise = (id: string): MessageView => ({
  kind: 'system',
  id,
  subtype: 'thinking_tokens',
  text: 'thinking_tokens',
});
const result = (id: string, subtype = 'success'): MessageView => ({
  kind: 'result',
  id,
  subtype,
  cost: 0.12,
});

describe('groupTurns — the two opener orders', () => {
  /**
   * THE SHAPE A REAL TURN HAS, taken verbatim from a session JSONL rather than
   * imagined: two hook rows sit between the prompt and the init, and a
   * `task_summary` trails after the result. Both render nothing, so neither is
   * visible in the chat — which is exactly why the first version of the
   * splitter, which required the current turn to be one message long, put every
   * follow-up prompt in a turn of its own and its answer in the next. Two
   * messages the operator cannot see, and a live session found it on the second
   * prompt.
   */
  const realTurn = (n: number): MessageView[] => [
    user(`u${n}`, `prompt ${n}`),
    hook(`h${n}a`, 'hook_started'),
    hook(`h${n}b`, 'hook_response'),
    init(`i${n}`),
    textThenCall(`a${n}x`, 'let me look'),
    toolOut(`t${n}`),
    text(`a${n}`, `answer ${n}`),
    result(`r${n}`),
    noise(`s${n}`),
  ];

  test('REGRESSION: the rows between a prompt and its init do not split the turn', () => {
    const turns = groupTurns([...realTurn(1), ...realTurn(2)]);
    expect(turns.map((t) => t.id)).toEqual(['u1', 'u2']);
    expect(turns.map((t) => t.answerId)).toEqual(['a1', 'a2']);
    // …and every prompt still sits with the answer it got.
    for (const t of turns) {
      expect(quietMessages(t).map((m) => m.id)).toEqual([t.id, t.answerId]);
    }
  });

  test('the same shape replayed from history groups identically', () => {
    // `persistOperatorPrompt` takes the turn's FIRST seq, so a replayed turn
    // arrives in the same order as a live one. The `init` opener still has to
    // work on its own for sessions written before prompts were persisted —
    // that case is below.
    const turns = groupTurns([...realTurn(1), ...realTurn(2)]);
    expect(turns).toHaveLength(2);
  });

  test('LIVE: the prompt opens the turn and its own init does not split it off', () => {
    const turns = groupTurns([
      user('u1'),
      init('i1'),
      textThenCall('a1', 'let me look'),
      toolOut('t1'),
      text('a2', 'nothing changed'),
      result('r1'),
      user('u2'),
      init('i2'),
      text('a3', 'ok'),
      result('r2'),
    ]);
    expect(turns.map((t) => t.id)).toEqual(['u1', 'u2']);
    expect(turns[0].messages).toHaveLength(6);
  });

  test('REPLAY: init opens the turn and the persisted prompt does not split it off', () => {
    // The order `session_history_start` produces: the SDK's init row is the
    // first of each persisted turn, and `persistOperatorPrompt` writes the
    // prompt immediately after it.
    const turns = groupTurns([
      init('i1'),
      user('u1'),
      text('a1', 'first'),
      result('r1'),
      init('i2'),
      user('u2'),
      text('a2', 'second'),
      result('r2'),
    ]);
    expect(turns.map((t) => t.id)).toEqual(['i1', 'i2']);
    expect(turns[0].messages.map((m) => m.id)).toEqual(['i1', 'u1', 'a1', 'r1']);
  });

  test('a replay written before prompts were persisted still splits per turn', () => {
    // No `user` message exists anywhere in these — no ServerMsg produced one
    // before `Cebab-ibb4`. `init` alone has to carry the boundary.
    const turns = groupTurns([
      init('i1'),
      text('a1', 'first'),
      result('r1'),
      init('i2'),
      text('a2', 'second'),
      result('r2'),
    ]);
    expect(turns.map((t) => t.id)).toEqual(['i1', 'i2']);
  });

  test('two prompts in a row are two turns, not one', () => {
    // Overlapping sends queue, and the second turn is empty until its own
    // messages arrive. Folding them together would attribute the first turn's
    // answer to the second prompt.
    expect(groupTurns([user('u1'), user('u2'), text('a', 'x')]).map((t) => t.id)).toEqual([
      'u1',
      'u2',
    ]);
  });

  test('an empty message list is no turns, not one empty turn', () => {
    expect(groupTurns([])).toEqual([]);
  });
});

describe('groupTurns — which message is the answer', () => {
  test('the last assistant message carrying text', () => {
    const turns = groupTurns([
      user('u1'),
      textThenCall('a1', 'let me look'),
      toolOut('t1'),
      text('a2', 'the answer'),
      result('r1'),
    ]);
    expect(turns[0].answerId).toBe('a2');
  });

  test('a trailing tool_use-only message is NOT the answer', () => {
    // The `error_max_turns` shape: the turn stopped mid-call, so the last
    // thing the agent SAID is one message further back. Picking the trailing
    // message would collapse the turn to an empty bubble.
    const turns = groupTurns([
      user('u1'),
      text('a1', 'here is what I found so far'),
      toolOut('t1'),
      callOnly('a2'),
      result('r1', 'error_max_turns'),
    ]);
    expect(turns[0].answerId).toBe('a1');
  });

  test('whitespace-only text does not count as an answer', () => {
    const turns = groupTurns([user('u1'), text('a1', '   \n  '), result('r1')]);
    expect(turns[0].answerId).toBeNull();
  });

  test('a turn still running has no answer yet', () => {
    expect(groupTurns([user('u1'), callOnly('a1')])[0].answerId).toBeNull();
  });
});

describe('groupTurns — the count on the toggle', () => {
  test('counts exactly what expanding will reveal', () => {
    const messages = [
      user('u1'),
      init('i1'),
      textThenCall('a1', 'let me look'),
      toolOut('t1'),
      text('a2', 'the answer'),
      result('r1'),
    ];
    const turn = groupTurns(messages)[0];
    // Hidden and rendering: the preamble+call, the tool output, the result
    // footer. NOT the init banner, which draws nothing at all.
    expect(turn.hiddenCount).toBe(3);
    expect(turn.messages.length - quietMessages(turn).length).toBe(turn.hiddenCount + 1);
  });

  test('rows that render nothing are never counted', () => {
    // A real turn carries a pile of these — one `init` plus every
    // `thinking_tokens` / `task_started` row the SDK emits. Counting them
    // would put a number on the toggle that expanding cannot account for.
    const turn = groupTurns([
      user('u1'),
      init('i1'),
      noise('n1'),
      noise('n2'),
      text('a1', 'done'),
    ])[0];
    expect(turn.hiddenCount).toBe(0);
  });

  test('a turn with nothing to hide reports zero, so no toggle is drawn', () => {
    expect(groupTurns([user('u1'), text('a1', 'done')])[0].hiddenCount).toBe(0);
  });
});

describe('quietMessages — what a collapsed turn shows', () => {
  test('the prompt and the answer, and none of the work', () => {
    const turn = groupTurns([
      user('u1'),
      init('i1'),
      textThenCall('a1', 'let me look'),
      toolOut('t1'),
      text('a2', 'the answer'),
      result('r1'),
    ])[0];
    expect(quietMessages(turn).map((m) => m.id)).toEqual(['u1', 'a2']);
  });

  test('the answer is stripped to its text — no tool_use payload in the answer row', () => {
    // An assistant message is frequently `[text, tool_use]`. Rendering the
    // picked message whole would put a pretty-printed JSON blob inside the one
    // row that is meant to be the answer.
    const turn = groupTurns([user('u1'), textThenCall('a1', 'the answer')])[0];
    const answer = quietMessages(turn).find((m) => m.id === 'a1');
    expect(answer?.kind).toBe('assistant');
    expect(answer?.kind === 'assistant' && answer.blocks.map((b) => b.type)).toEqual(['text']);
  });

  test('a gate the turn is parked on stays, in place, BEFORE the answer', () => {
    const permission: MessageView = {
      kind: 'permission_request',
      id: 'p1',
      requestId: 'req-1',
      toolName: 'Bash',
      input: {},
    };
    const turn = groupTurns([
      user('u1'),
      textThenCall('a1', 'let me look'),
      permission,
      toolOut('t1'),
      text('a2', 'the answer'),
      result('r1'),
    ])[0];
    // Order is arrival order: a card always precedes the answer it gated, and
    // hoisting the answer would claim otherwise.
    expect(quietMessages(turn).map((m) => m.id)).toEqual(['u1', 'p1', 'a2']);
  });
});

/**
 * Every class, in one table the compiler checks.
 *
 * `Record<MessageView['kind'], …>` on BOTH sides — here and on `PINNED` in the
 * module — is the by-construction half: a new message kind fails to compile
 * until someone has decided which side of the collapse it falls on. The values
 * are the half a human has to get right, and the four `true`s are the ones with
 * consequences: hide a permission card or a parked question and the run waits
 * forever on an operator who was never asked.
 */
describe('isPinnedInQuietView — the classes the collapse may never swallow', () => {
  const ONE_OF_EACH: Record<MessageView['kind'], MessageView> = {
    user: user('u'),
    assistant: text('a', 'hello'),
    system: toolOut('t'),
    command_output: { kind: 'command_output', id: 'c', text: '/cost → $1.20' },
    result: result('r'),
    error: { kind: 'error', id: 'e', errorKind: 'auth_expired', message: 'boom' },
    permission_request: {
      kind: 'permission_request',
      id: 'p',
      requestId: 'req',
      toolName: 'Bash',
      input: {},
    },
    ask_user_question: {
      kind: 'ask_user_question',
      id: 'q',
      toolUseId: 'tu',
      agent: 'cebab',
      questions: [],
    },
  };

  const EXPECTED: Record<MessageView['kind'], boolean> = {
    user: true,
    assistant: false,
    system: false,
    command_output: true,
    result: false, // the success footer; every other subtype is asserted below
    error: true,
    permission_request: true,
    ask_user_question: true,
  };

  for (const kind of Object.keys(ONE_OF_EACH) as Array<MessageView['kind']>) {
    test(`${kind} is ${EXPECTED[kind] ? 'pinned' : 'collapsible'}`, () => {
      expect(isPinnedInQuietView(ONE_OF_EACH[kind])).toBe(EXPECTED[kind]);
    });
  }

  test('a non-success result is pinned — error_max_turns carries the Extend buttons', () => {
    // The sharpest case: hiding this card removes the only control that
    // resumes the work, and the turn looks like it simply stopped.
    for (const subtype of [
      'error_max_turns',
      'error_during_execution',
      'error_max_budget_usd',
      'error_max_structured_output_retries',
    ]) {
      expect(isPinnedInQuietView(result('r', subtype))).toBe(true);
    }
  });

  test('ANTI-VACUITY: the collapse really does remove things', () => {
    // Without this, a `PINNED` table of all-`true` would satisfy every case
    // above that asserts a pin, and the quiet view would be the full view.
    expect(Object.values(EXPECTED).filter((v) => !v).length).toBeGreaterThan(0);
  });
});

describe('rendersAnything — the shared rule MessageBlock returns null on', () => {
  test('tool output renders; the init banner and the event summaries do not', () => {
    expect(rendersAnything(toolOut('t'))).toBe(true);
    expect(rendersAnything(init('i'))).toBe(false);
    expect(rendersAnything(noise('n'))).toBe(false);
  });

  test('every other kind renders', () => {
    expect(rendersAnything(user('u'))).toBe(true);
    expect(rendersAnything(text('a', 'x'))).toBe(true);
    expect(rendersAnything(result('r'))).toBe(true);
  });
});

/**
 * Storage is stubbed rather than taken from jsdom, matching
 * `navPinnedDefault.test.ts` — and the first case is its anti-vacuity control
 * for the reason that file records: with no stub in effect every read falls
 * through to the fallback, and a default-ON preference makes two of the three
 * cases below pass for the wrong reason.
 */
const stubStorage = (() => {
  const map = new Map<string, string>();
  return {
    backing: map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
})();

describe('the stored preference', () => {
  beforeEach(() => {
    stubStorage.backing.clear();
    vi.stubGlobal('localStorage', stubStorage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('the stub is wired, so the cases below read a real value', () => {
    stubStorage.backing.set('cebab.chat.quiet', 'false');
    expect(localStorage.getItem('cebab.chat.quiet')).toBe('false');
  });

  test('defaults ON for an operator who has never chosen', () => {
    expect(readStoredQuiet()).toBe(true);
  });

  test('round-trips both ways', () => {
    writeStoredQuiet(false);
    expect(readStoredQuiet()).toBe(false);
    expect(stubStorage.backing.get('cebab.chat.quiet')).toBe('false');
    writeStoredQuiet(true);
    expect(readStoredQuiet()).toBe(true);
  });

  test('a corrupt value reads as the default rather than as off', () => {
    // The parse is `raw !== 'false'`, so anything unrecognised lands on ON.
    // The alternative — treating a bad value as off — would silently restore
    // the wall of tool output this exists to put away.
    stubStorage.backing.set('cebab.chat.quiet', 'yes please');
    expect(readStoredQuiet()).toBe(true);
  });
});
