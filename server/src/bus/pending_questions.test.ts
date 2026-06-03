import { afterEach, describe, expect, test } from 'vitest';
import type { AskUserQuestionView } from '@cebab/shared/protocol';
import {
  parkQuestion,
  resolveQuestion,
  rejectQuestionsForSession,
  listParkedQuestions,
  formatAskUserAnswer,
  __clearAllParkedQuestions,
} from './pending_questions.js';

const Q: AskUserQuestionView[] = [
  {
    question: 'Deploy where?',
    header: 'Env',
    options: [{ label: 'Staging' }, { label: 'Prod' }],
    multiSelect: false,
  },
];

afterEach(() => __clearAllParkedQuestions());

describe('pending_questions registry', () => {
  test('parkQuestion resolves with the answer passed to resolveQuestion', async () => {
    const p = parkQuestion('s1', { agent: 'worker', toolUseId: 'tu1', questions: Q });
    expect(resolveQuestion('s1', 'tu1', 'Prod')).toBe(true);
    await expect(p).resolves.toBe('Prod');
  });

  test('resolveQuestion returns false for an unknown id', () => {
    expect(resolveQuestion('s1', 'nope', 'x')).toBe(false);
  });

  test('listParkedQuestions snapshots without resolving', () => {
    parkQuestion('s1', { agent: 'worker', toolUseId: 'tu1', questions: Q });
    const list = listParkedQuestions('s1');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ agent: 'worker', toolUseId: 'tu1' });
    // still parked → resolvable
    expect(resolveQuestion('s1', 'tu1', 'Prod')).toBe(true);
  });

  test('rejectQuestionsForSession rejects all parked promises + clears them', async () => {
    const p = parkQuestion('s1', { agent: 'worker', toolUseId: 'tu1', questions: Q });
    rejectQuestionsForSession('s1', 'stopped');
    await expect(p).rejects.toThrow('stopped');
    expect(listParkedQuestions('s1')).toHaveLength(0);
    expect(resolveQuestion('s1', 'tu1', 'Prod')).toBe(false);
  });

  test('sessions are isolated', async () => {
    const p1 = parkQuestion('s1', { agent: 'a', toolUseId: 'tu1', questions: Q });
    const p2 = parkQuestion('s2', { agent: 'b', toolUseId: 'tu2', questions: Q });
    rejectQuestionsForSession('s2', 'gone');
    await expect(p2).rejects.toThrow('gone');
    // s1 is untouched by draining s2.
    expect(resolveQuestion('s1', 'tu1', 'ok')).toBe(true);
    await expect(p1).resolves.toBe('ok');
  });
});

describe('formatAskUserAnswer', () => {
  test('formats a single question/answer pair', () => {
    expect(formatAskUserAnswer({ 'Deploy where?': 'Prod' })).toBe(
      'The user answered:\n• Deploy where?\n  → Prod',
    );
  });

  test('formats multiple questions', () => {
    const out = formatAskUserAnswer({ Q1: 'A', Q2: 'B' });
    expect(out).toContain('• Q1\n  → A');
    expect(out).toContain('• Q2\n  → B');
  });

  test('empty answers → explicit no-answer string', () => {
    expect(formatAskUserAnswer({})).toBe('The user submitted no answer.');
  });
});
