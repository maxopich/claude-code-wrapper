import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { stripComments } from '../test_support/strip_comments.js';

/**
 * `Cebab-vie.17` [security] — the fifth sentinel will be added by someone who
 * has not read `isBusControlSignal`'s doc comment.
 *
 * That comment has ended with "a fourth sentinel belongs here too; adding one
 * and forgetting this line is how the hole comes back" since `Cebab-vie.14`.
 * It was accurate and it was an honour system: nothing in the repo could tell
 * a class that had been registered from one that had not, and the consequence
 * is not cosmetic — an unregistered sentinel falls back to being classified by
 * `String.includes` on its own message, which is the vie.14 bug exactly. The
 * fourth sentinel (`MaxTurnsReachedError`) is what made "add a class and
 * forget" a thing that had now happened twice, so the rule stops being prose.
 *
 * Derived from the source rather than from a list somebody maintains: every
 * exported `*Error` class in `errors.ts` must have an exported `is…` predicate,
 * and that predicate must be called inside `isBusControlSignal`'s body.
 *
 * WHAT THIS DOES NOT CHECK: whether membership is the RIGHT answer for a given
 * class. A sentinel that genuinely should be retried has to be excluded here
 * with a comment, and this test would then need a documented exemption — which
 * is the point. Today there is no such class, and `error_during_execution`,
 * the one non-success outcome that must stay retryable, is deliberately not a
 * class at all.
 *
 * Reads text, not a syntax tree, and takes a CONTENT MAP so the two fixture
 * cases below can feed it directly. Without that seam, "an unregistered class
 * is reported" could only be asserted by trusting the tree — and a scanner that
 * found no classes at all would pass just as loudly.
 */

const ERRORS_TS = fileURLToPath(new URL('./errors.ts', import.meta.url));

/** Exported error classes and the predicates `isBusControlSignal` calls. */
export function scan(source: string): { classes: string[]; registered: string[] } {
  const code = stripComments(source);
  const classes = [...code.matchAll(/export class (\w+Error) extends Error\b/g)].map((m) => m[1]!);
  const predicates = new Set(
    [...code.matchAll(/export function (is\w+)\(err: unknown\)/g)].map((m) => m[1]!),
  );
  // The body of `isBusControlSignal`, from its signature to the closing brace
  // at column 0 — the file's own formatting, enforced by prettier.
  const bodyMatch = /export function isBusControlSignal\([\s\S]*?\n\}/.exec(code);
  const body = bodyMatch ? bodyMatch[0] : '';
  const registered = classes.filter((cls) => {
    // `FooError` → `isFoo`. Derived, so a predicate named off-pattern reads as
    // unregistered rather than silently matching nothing.
    const predicate = `is${cls.replace(/Error$/, '')}`;
    return predicates.has(predicate) && body.includes(`${predicate}(err)`);
  });
  return { classes, registered };
}

describe('[security] every bus sentinel is registered as a control signal', () => {
  const source = fs.readFileSync(ERRORS_TS, 'utf8');

  test('the scanner actually found the sentinels', () => {
    // Anti-vacuity floor. Without it, a rename that made the class regex match
    // nothing would turn the assertion below into "[] equals []".
    const { classes } = scan(source);
    expect(classes.length).toBeGreaterThanOrEqual(4);
    expect(classes).toContain('MaxTurnsReachedError');
  });

  test('no exported sentinel is missing from isBusControlSignal', () => {
    const { classes, registered } = scan(source);
    expect(registered).toEqual(classes);
  });
});

describe('[security] the scanner reports an unregistered class rather than skipping it', () => {
  // Both halves are required and they fail for opposite reasons: the first
  // would pass if the scan reported everything as registered, the second if it
  // reported nothing as found.

  const REGISTERED = [
    'export class AError extends Error {}',
    'export function isA(err: unknown): boolean { return err instanceof AError; }',
    'export function isBusControlSignal(err: unknown): boolean {',
    '  return isA(err);',
    '}',
  ].join('\n');

  test('a class the predicate list omits is reported', () => {
    const source = [
      'export class AError extends Error {}',
      'export class BError extends Error {}',
      'export function isA(err: unknown): boolean { return err instanceof AError; }',
      'export function isB(err: unknown): boolean { return err instanceof BError; }',
      'export function isBusControlSignal(err: unknown): boolean {',
      '  return isA(err);',
      '}',
    ].join('\n');
    expect(scan(source)).toEqual({ classes: ['AError', 'BError'], registered: ['AError'] });
  });

  test('a fully registered file comes back clean', () => {
    expect(scan(REGISTERED)).toEqual({ classes: ['AError'], registered: ['AError'] });
  });

  test('a mention inside a COMMENT does not count as registration', () => {
    // The failure this shape is most likely to have: someone documents the new
    // class in the doc block above `isBusControlSignal` and never adds the term.
    const source = [
      'export class AError extends Error {}',
      'export class BError extends Error {}',
      'export function isA(err: unknown): boolean { return err instanceof AError; }',
      'export function isB(err: unknown): boolean { return err instanceof BError; }',
      '/** BError is handled here too — see isB(err). */',
      'export function isBusControlSignal(err: unknown): boolean {',
      '  return isA(err);',
      '}',
    ].join('\n');
    expect(scan(source).registered).toEqual(['AError']);
  });
});
