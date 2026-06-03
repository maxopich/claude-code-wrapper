import { describe, expect, test } from 'vitest';
import { parseAskUserQuestions } from './runner.js';

describe('parseAskUserQuestions', () => {
  test('coerces the SDK question shape to the wire view', () => {
    const out = parseAskUserQuestions({
      questions: [
        {
          question: 'Pick',
          header: 'H',
          multiSelect: true,
          options: [{ label: 'A', description: 'a' }, { label: 'B' }],
        },
      ],
    });
    expect(out).toEqual([
      {
        question: 'Pick',
        header: 'H',
        multiSelect: true,
        options: [{ label: 'A', description: 'a' }, { label: 'B' }],
      },
    ]);
  });

  test('drops malformed questions/options and defaults missing fields', () => {
    const out = parseAskUserQuestions({
      questions: [
        null,
        { question: 'Q', options: [{ description: 'no label' }, { label: 'Keep' }] },
      ],
    });
    expect(out).toEqual([
      { question: 'Q', header: '', multiSelect: false, options: [{ label: 'Keep' }] },
    ]);
  });

  test('non-array questions → empty list', () => {
    expect(parseAskUserQuestions({})).toEqual([]);
    expect(parseAskUserQuestions({ questions: 'x' })).toEqual([]);
  });
});
