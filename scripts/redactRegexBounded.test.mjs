import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * `Cebab-ygu.51` [security]: every repetition in `redact.ts`'s scanning patterns
 * stays BOUNDED.
 *
 * WHY THIS EXISTS AS ITS OWN GATE. The first version of
 * `CREDENTIAL_ASSIGNMENT` was `[ \t]*["']?[ \t]*[:=][ \t]*` and it is quadratic
 * on `-\t\t\t…`: two adjacent stars over the same alphabet split a tab run N+1
 * ways, and even one greedy star before a disjoint literal re-tries every length
 * at every failing start position. `npm run lint` passed it — eslint's
 * `security/detect-unsafe-regex` checks STAR HEIGHT, which was 1 either way —
 * and it took CodeQL on the pull request to catch it.
 *
 * So the local signal is here, one second instead of one CI round trip. It is
 * deliberately a SHAPE check rather than a timing one: a regression makes the
 * scan hang rather than fail, and vitest's timeout is JS — it cannot fire on an
 * event loop frozen inside a backtracking regex.
 *
 * Scoped to ONE pattern: the credential-assignment scanner. The header used to
 * claim `SENSITIVE_VALUE_PATTERNS` as well, and that was never true — the name
 * appears nowhere in this file but that sentence, so a reader believed a second
 * attacker-facing surface was guarded when nothing looked at it.
 *
 * It is not an oversight that transfers, either. That array opens with
 * `/\bauthorization:\s*\S+/i`, whose `+` is unbounded and entirely safe —
 * `\s` and `\S` are disjoint, so there is nothing to backtrack over. The cheap
 * `[*+]` rule below would flag it on day one and earn the exemption list this
 * gate exists to avoid. Covering the array needs real ambiguity analysis rather
 * than a character scan; tracked separately.
 *
 * Not the whole file either: `isIdentifier` and friends run on already-bounded
 * tokens, and a gate that flags every `*` in a source file gets an exemption
 * list and then gets ignored.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'shared', 'src', 'redact.ts');

/** Strip character classes so a literal `*`/`+` INSIDE one is not a quantifier. */
function stripClasses(pattern) {
  return pattern.replace(/\[(?:[^\]\\]|\\.){0,200}\]/g, '[]');
}

function unboundedQuantifiers(pattern) {
  return [...stripClasses(pattern).matchAll(/[*+]/g)].map((m) => m[0]);
}

describe('[security] the redact.ts assignment scanner is bounded (Cebab-ygu.51)', () => {
  const source = fs.readFileSync(SRC, 'utf8');

  test('the credential-assignment scanner has no unbounded repetition', () => {
    const line = source.split('\n').find((l) => l.trim().startsWith('/') && l.includes('[:=]'));
    // Inverse-vacuity: if the pattern is renamed or reshaped so this no longer
    // finds it, the test must fail rather than pass on an empty search.
    expect({ found: line !== undefined }).toEqual({ found: true });
    expect({ line, unbounded: unboundedQuantifiers(line) }).toEqual({ line, unbounded: [] });
  });

  test('the helper itself can tell bounded from unbounded', () => {
    // The gate's own predicate is the thing most likely to measure nothing —
    // `stripClasses` returning '' would put every pattern in range and blank.
    expect(unboundedQuantifiers(String.raw`/[ \t]*[:=]/`)).toEqual(['*']);
    expect(unboundedQuantifiers(String.raw`/[ \t]{0,8}[:=]/`)).toEqual([]);
    // A `*` inside a character class is a literal, not a quantifier.
    expect(unboundedQuantifiers(String.raw`/[*+]{1,4}/`)).toEqual([]);
  });
});
