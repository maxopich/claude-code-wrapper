// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { isInTextInput, SHORTCUTS } from './shortcutRegistry';

// Cluster E Phase 4 — registry shape + keyMatch predicates.

describe('SHORTCUTS registry', () => {
  test('every entry has a unique id', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every entry has at least one keyDisplay chip', () => {
    for (const s of SHORTCUTS) {
      expect(s.keyDisplay.length, s.id).toBeGreaterThan(0);
    }
  });

  test('every entry has a non-empty description', () => {
    for (const s of SHORTCUTS) {
      expect(s.description.length, s.id).toBeGreaterThan(0);
    }
  });

  test('documentationOnly entries pass false through keyMatch', () => {
    const docOnly = SHORTCUTS.filter((s) => s.documentationOnly);
    expect(docOnly.length).toBeGreaterThan(0);
    for (const s of docOnly) {
      // The hook short-circuits on documentationOnly without calling
      // keyMatch, but we still keep the invariant that those rows
      // return false for any event to defend against caller bugs.
      const e = new KeyboardEvent('keydown', { key: 'a' });
      expect(s.keyMatch(e), s.id).toBe(false);
    }
  });
});

describe('? cheatsheet trigger keyMatch', () => {
  const sc = SHORTCUTS.find((s) => s.id === 'help.openCheatsheet.questionMark')!;

  test('matches bare ? outside an input', () => {
    const e = new KeyboardEvent('keydown', { key: '?' });
    expect(sc.keyMatch(e)).toBe(true);
  });

  test('does NOT match ? inside a textarea', () => {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    const e = new KeyboardEvent('keydown', { key: '?' });
    Object.defineProperty(e, 'target', { value: ta });
    expect(sc.keyMatch(e)).toBe(false);
    ta.remove();
  });

  test('does NOT match ? inside a text input', () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    const e = new KeyboardEvent('keydown', { key: '?' });
    Object.defineProperty(e, 'target', { value: input });
    expect(sc.keyMatch(e)).toBe(false);
    input.remove();
  });

  test('still matches ? when target is a button (not a text input)', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    const e = new KeyboardEvent('keydown', { key: '?' });
    Object.defineProperty(e, 'target', { value: btn });
    expect(sc.keyMatch(e)).toBe(true);
    btn.remove();
  });

  test('does NOT match Cmd+? (modifier present)', () => {
    const e = new KeyboardEvent('keydown', { key: '?', metaKey: true });
    expect(sc.keyMatch(e)).toBe(false);
  });
});

describe('Cmd/Ctrl+/ cheatsheet toggle keyMatch', () => {
  const sc = SHORTCUTS.find((s) => s.id === 'help.openCheatsheet.slash')!;

  test('matches Cmd+/', () => {
    const e = new KeyboardEvent('keydown', { key: '/', metaKey: true });
    expect(sc.keyMatch(e)).toBe(true);
  });

  test('matches Ctrl+/', () => {
    const e = new KeyboardEvent('keydown', { key: '/', ctrlKey: true });
    expect(sc.keyMatch(e)).toBe(true);
  });

  test('does NOT match bare /', () => {
    const e = new KeyboardEvent('keydown', { key: '/' });
    expect(sc.keyMatch(e)).toBe(false);
  });

  test('does NOT match Cmd+Shift+/ (shift is reserved)', () => {
    const e = new KeyboardEvent('keydown', { key: '/', metaKey: true, shiftKey: true });
    expect(sc.keyMatch(e)).toBe(false);
  });
});

describe('Cmd/Ctrl+. Stop keyMatch', () => {
  const sc = SHORTCUTS.find((s) => s.id === 'session.stop.cmdPeriod')!;

  test('matches Cmd+.', () => {
    const e = new KeyboardEvent('keydown', { key: '.', metaKey: true });
    expect(sc.keyMatch(e)).toBe(true);
  });

  test('matches Ctrl+.', () => {
    const e = new KeyboardEvent('keydown', { key: '.', ctrlKey: true });
    expect(sc.keyMatch(e)).toBe(true);
  });

  test('does NOT match bare .', () => {
    const e = new KeyboardEvent('keydown', { key: '.' });
    expect(sc.keyMatch(e)).toBe(false);
  });
});

describe('isInTextInput', () => {
  test('returns true for a textarea target', () => {
    const ta = document.createElement('textarea');
    const e = new KeyboardEvent('keydown', { key: 'a' });
    Object.defineProperty(e, 'target', { value: ta });
    expect(isInTextInput(e)).toBe(true);
  });

  test('returns true for an input[type=text] target', () => {
    const input = document.createElement('input');
    input.type = 'text';
    const e = new KeyboardEvent('keydown', { key: 'a' });
    Object.defineProperty(e, 'target', { value: input });
    expect(isInTextInput(e)).toBe(true);
  });

  test('returns false for an input[type=checkbox] target (non-text)', () => {
    const input = document.createElement('input');
    input.type = 'checkbox';
    const e = new KeyboardEvent('keydown', { key: 'a' });
    Object.defineProperty(e, 'target', { value: input });
    expect(isInTextInput(e)).toBe(false);
  });

  test('returns false for a button target', () => {
    const btn = document.createElement('button');
    const e = new KeyboardEvent('keydown', { key: 'a' });
    Object.defineProperty(e, 'target', { value: btn });
    expect(isInTextInput(e)).toBe(false);
  });
});
