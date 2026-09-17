import { describe, expect, test } from 'vitest';
import { initialState, reduce, type AppState } from './store';
import type { AskUserQuestionView } from '@cebab/shared/protocol';

/**
 * `Cebab-uhn2`: the single-agent question card as scrollback state.
 *
 * The card lives IN the transcript (like a permission card) rather than in a
 * floating slot (like the multi-agent tab's), so the reducer's job is the same
 * as `permission_decided`'s: find the matching card and mark it spent, in
 * place, idempotently. The cases below are the three ways that goes wrong —
 * a duplicate card, a lost answer, and a card that stays live after the turn
 * has moved on.
 */

const QUESTIONS: AskUserQuestionView[] = [
  {
    question: 'Which database?',
    header: 'DB',
    multiSelect: false,
    options: [{ label: 'Postgres' }, { label: 'SQLite' }],
  },
];

function seedSession(): AppState {
  let s = reduce(initialState, {
    type: 'server',
    msg: {
      type: 'projects',
      scans: [],
      projects: [
        {
          id: 1,
          name: 'p',
          path: '/p',
          trusted: true,
          lastUsedAt: 0,
          hasClaudeMd: false,
          busInstalled: false,
          busAgentName: null,
          model: null,
          startPermissionMode: null,
          isManaged: false,
          managed: null,
        },
      ],
    },
  });
  s = reduce(s, { type: 'select_project', projectId: 1 });
  s = reduce(s, {
    type: 'server',
    msg: {
      type: 'session_started',
      sessionId: 'sess-1',
      projectId: 1,
      model: 'claude-sonnet-4-5',
      tools: [],
      permissionMode: 'acceptEdits',
    },
  });
  return s;
}

function ask(s: AppState, toolUseId: string): AppState {
  return reduce(s, {
    type: 'server',
    msg: {
      type: 'ask_user_question',
      sessionId: 'sess-1',
      agent: 'p',
      toolUseId,
      questions: QUESTIONS,
    },
  });
}

function cards(s: AppState) {
  const msgs = s.sessionsByProject[1]?.['sess-1']?.messages ?? [];
  return msgs.filter((m) => m.kind === 'ask_user_question');
}

describe('store / ask_user_question', () => {
  test('a question appends an answerable card to the transcript', () => {
    const s = ask(seedSession(), 'tu-1');
    expect(cards(s)).toHaveLength(1);
    const card = cards(s)[0]!;
    expect(card).toMatchObject({ toolUseId: 'tu-1', agent: 'p', questions: QUESTIONS });
    // Not yet spent — this is what makes the buttons live.
    expect(card.resolved).toBeUndefined();
    expect(card.answers).toBeUndefined();
  });

  test('a repeated emit for the same toolUseId does not stack a second card', () => {
    // The id is the SDK's, so a re-emit is the server's to make, not the
    // operator's; two identical cards would give them two places to answer one
    // question and one of the two clicks would silently do nothing.
    const s = ask(ask(seedSession(), 'tu-1'), 'tu-1');
    expect(cards(s)).toHaveLength(1);
  });

  test('answering records the choice AND spends the card', () => {
    let s = ask(seedSession(), 'tu-1');
    s = reduce(s, {
      type: 'ask_user_answered',
      sessionId: 'sess-1',
      toolUseId: 'tu-1',
      answers: { 'Which database?': 'SQLite' },
    });
    expect(cards(s)[0]).toMatchObject({
      resolved: true,
      answers: { 'Which database?': 'SQLite' },
    });
  });

  test('the server echo must NOT erase the answer the operator just gave', () => {
    // The ordering this defends: the optimistic `ask_user_answered` lands
    // first, then `ask_user_resolved` arrives from the server a moment later.
    // A reducer that rebuilt the card from the echo would blank the choice out
    // of the transcript while the operator was looking at it.
    let s = ask(seedSession(), 'tu-1');
    s = reduce(s, {
      type: 'ask_user_answered',
      sessionId: 'sess-1',
      toolUseId: 'tu-1',
      answers: { 'Which database?': 'SQLite' },
    });
    s = reduce(s, {
      type: 'server',
      msg: { type: 'ask_user_resolved', sessionId: 'sess-1', toolUseId: 'tu-1' },
    });
    expect(cards(s)[0]).toMatchObject({
      resolved: true,
      answers: { 'Which database?': 'SQLite' },
    });
  });

  test('a drain spends the card with NO answers — it went unanswered', () => {
    // Cebab drained it (interrupt / turn death / disconnect). `answers` staying
    // absent is what lets the card say "went unanswered" instead of rendering
    // a blank where a choice would be.
    let s = ask(seedSession(), 'tu-1');
    s = reduce(s, {
      type: 'server',
      msg: { type: 'ask_user_resolved', sessionId: 'sess-1', toolUseId: 'tu-1' },
    });
    expect(cards(s)[0]).toMatchObject({ resolved: true });
    expect(cards(s)[0]!.answers).toBeUndefined();
  });

  test('a resolve for a DIFFERENT toolUseId leaves the live card alone', () => {
    // A late drain for an already-replaced question must not blank the card
    // that is currently on screen.
    let s = ask(seedSession(), 'tu-1');
    s = reduce(s, {
      type: 'server',
      msg: { type: 'ask_user_resolved', sessionId: 'sess-1', toolUseId: 'tu-OTHER' },
    });
    expect(cards(s)[0]!.resolved).toBeUndefined();
  });
});
