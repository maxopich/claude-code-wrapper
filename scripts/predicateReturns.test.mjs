/**
 * A function named like a predicate must answer like one — register N01.
 *
 * WHAT WENT WRONG. `server/src/bus/reconstruct.ts` exported
 *
 *     /** Cheap, synchronous predicate: can this row be brought back by R-B? *\/
 *     export function isReconstructable(row): ReconstructGuard
 *
 * where `ReconstructGuard` is `{ ok: true } | { ok: false; reason: … }`. Named
 * like a predicate, documented as one, returning an object — so
 * `if (isReconstructable(row))` is legal TypeScript and is **always true**,
 * because the failure case is a truthy object. Nothing was broken: all four
 * call sites read `.ok`, and a `canReconstruct(row): boolean` already sat
 * eleven lines below. The name was one distracted edit from a silent bug the
 * compiler cannot see.
 *
 * WHY A GATE RATHER THAN JUST THE RENAME. The convention was already at 34 of
 * 35 before that fix — measured, not assumed. A rule the codebase follows
 * everywhere but once is exactly the kind that decays silently: the next
 * `is*` returning a rich result looks locally reasonable, and nothing fails.
 * Type-level enforcement is not available (TypeScript has no "must return
 * boolean" constraint on a declaration), so a source scan is the seam.
 *
 * THE RULE. An exported function whose name starts with `is` / `has` / `can` /
 * `should` followed by an uppercase letter must declare a return type of
 * `boolean` or a type predicate (`v is T`). Both are booleans at runtime, and
 * the type-predicate form is the one that makes narrowing work — a rule that
 * demanded literal `boolean` would flag eight correct guards
 * (`isKickMode(v): v is KickMode` and friends) and force an allowlist where a
 * rule belongs. That rejected variant is in the revert-check.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER. Non-exported functions: the corpus is
 * the API surface, where a caller reads the name without the body in view. A
 * local `function isFoo()` is visible in its own file to whoever calls it.
 * Stated rather than silent, because an unstated scope limit is how a gate
 * gets read as broader than it is.
 *
 * PARSING is brace-and-paren walking rather than a line regex, and that is
 * load-bearing: `shouldAutoAllow`, `shouldHaltUnrecordedMutation` and
 * `isPinnedToBottom` all wrap their parameters across lines, so a
 * line-oriented matcher silently drops three of the corpus and passes by
 * measuring less. Same failure `busSafetyClaims.test.mjs` records for wrapped
 * prose. No TypeScript parser: those dependencies resolve as unhoisted
 * transitives here and break on a clean `npm ci`, which is why every gate in
 * `scripts/` parses by hand.
 *
 * Lives in `scripts/` rather than `web/` because it reads all three packages;
 * `web/tsconfig.json` sets `types: []` and `nodeTypeIsolation.test.ts` enforces
 * it, so a `web/` spec cannot use `node:fs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Read a repo file as text with CRLF normalised away.
 *
 * `.gitattributes` pins LF on checkout, but a scan should not assume its
 * input: a contributor with a global `core.autocrlf=true` reads `\r` at every
 * line end, and this repo has lost CI round-trips to that
 * (`project_crlf_breaks_css_parsing_tests`). */
function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
}

// ===========================================================================
// 1. The checker.
// ===========================================================================

/** `is` / `has` / `can` / `should` followed by an uppercase letter. */
const PREDICATE_NAME = /export function ((?:is|has|can|should)[A-Z][A-Za-z0-9]*)\s*\(/g;

/**
 * Every exported predicate-named function in `src`, with its declared return
 * type as written.
 *
 * Walks the parameter list to its matching `)` and takes the text up to the
 * body's `{`. A regex stopping at the first `)` on the line would report `''`
 * for the three declarations whose parameters wrap — and `''` is not a
 * conforming return type, so they would have surfaced as false violations
 * rather than silently vanishing. Both failure modes are wrong; this avoids
 * needing to know which.
 */
function predicateSignatures(src) {
  const out = [];
  for (const m of src.matchAll(PREDICATE_NAME)) {
    // Start on the `(` the name pattern consumed, so the walk below opens at
    // depth 1 on its first character.
    let i = m.index + m[0].length - 1;
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const brace = src.indexOf('{', i);
    const between = brace === -1 ? '' : src.slice(i + 1, brace);
    out.push({ name: m[1], returns: between.trim().replace(/^:/, '').trim() });
  }
  return out;
}

/** `boolean`, or a type predicate (`v is Foo`, `err is Bar<T>`). */
function returnsBoolean(returns) {
  return returns === 'boolean' || /^\w+ is [\w.<>[\] |]+$/.test(returns);
}

/** `{ file, name, returns }` for every declaration that breaks the rule. */
function violations(sources) {
  const out = [];
  for (const [file, src] of Object.entries(sources)) {
    for (const sig of predicateSignatures(src)) {
      if (!returnsBoolean(sig.returns)) out.push({ file, ...sig });
    }
  }
  return out.sort((a, b) => `${a.file}${a.name}`.localeCompare(`${b.file}${b.name}`));
}

// ===========================================================================
// 2. Anti-vacuity: prove the checker fires, independent of the tree.
// ===========================================================================

describe('the predicate-return checker catches what it is for', () => {
  test('flags the verbatim pre-rename declaration', () => {
    // `git show 486aaf7:server/src/bus/reconstruct.ts`. The tree has exactly
    // zero violations after this PR, so without this fixture every scan below
    // would pass whether or not the checker works.
    const src = 'export function isReconstructable(row: MultiAgentSessionRow): ReconstructGuard {';
    expect(violations({ 'reconstruct.ts': src })).toEqual([
      { file: 'reconstruct.ts', name: 'isReconstructable', returns: 'ReconstructGuard' },
    ]);
  });

  test.each([
    ['export function isValidAgentName(s: string): boolean {', 'plain boolean'],
    ['export function isKickMode(v: unknown): v is KickMode {', 'type predicate'],
    ['export function isTurnStalled(err: unknown): err is TurnStalledError {', 'predicate on err'],
    ['export function hasLiveSession(sessionId: string): boolean {', 'has-prefix'],
    ['export function canReconstruct(row: Row): boolean {', 'can-prefix'],
    ['export function shouldAutoAllow(\n  trusted: boolean,\n  mode: M,\n): boolean {', 'wrapped'],
  ])('does not flag %s (%s)', (src) => {
    expect(violations({ 'a.ts': src })).toEqual([]);
  });

  test('reads the return type through a WRAPPED parameter list', () => {
    // Three real declarations wrap. A matcher that stopped at the first `)` on
    // the line would read `''` here and report a false violation; one that
    // stopped at the first newline would drop the declaration entirely.
    const src = [
      'export function isPinnedToBottom(',
      '  metrics: ScrollMetrics,',
      '  thresholdPx: number = SCROLL_STICK_THRESHOLD_PX,',
      '): boolean {',
    ].join('\n');
    expect(predicateSignatures(src)).toEqual([{ name: 'isPinnedToBottom', returns: 'boolean' }]);
  });

  test('a generic in the parameter list does not end the walk early', () => {
    // `(v: Map<string, number>)` contains no parens, but a default value can:
    // `= new Set()`. The paren walk handles it; a first-`)` matcher would stop
    // inside the parameter list and read a nonsense return type.
    const src = 'export function isMuted(env: Pick<E, "a">, seen = new Set()): boolean {';
    expect(predicateSignatures(src)).toEqual([{ name: 'isMuted', returns: 'boolean' }]);
  });

  test('a non-exported predicate is out of scope, deliberately', () => {
    // Stated as a test so the limit is a decision rather than an oversight.
    expect(violations({ 'a.ts': 'function isThing(x: unknown): Thing | null {' })).toEqual([]);
  });

  test('a name that merely starts with those letters is not a predicate', () => {
    // `island`, `hasty`, `issue`, `candidate` — the uppercase letter after the
    // prefix is what makes it a predicate name. Without that boundary the rule
    // would demand booleans from ordinary functions.
    const src = [
      'export function issueToken(): string {',
      'export function candidateFor(x: A): B {',
      'export function hasteMode(): Mode {',
    ].join('\n');
    expect(violations({ 'a.ts': src })).toEqual([]);
  });
});

// ===========================================================================
// 3. The scan.
// ===========================================================================

describe('every exported predicate in the repo returns a boolean', () => {
  const sources = collectSources();
  const names = Object.values(sources).flatMap((s) => predicateSignatures(s).map((x) => x.name));

  test('the scan reaches all three packages', () => {
    // A walk that found only `server/src` would pass while measuring half the
    // corpus — the rule spans the wire types, the server and the client.
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(200);
    for (const f of [
      'shared/src/protocol.ts',
      'server/src/bus/reconstruct.ts',
      'web/src/scrollAnchor.ts',
    ]) {
      expect(files, `${f} is not in the scanned set`).toContain(f);
    }
  });

  test('the corpus is the predicates, not an empty set', () => {
    // 34 today. A floor well below it survives churn while catching a regex
    // that stopped matching — which would make the scan below pass on nothing.
    expect(names.length).toBeGreaterThan(25);
  });

  test('the three wrapped-parameter declarations are in the corpus', () => {
    // Named because they are the ones a line-oriented parser loses. If the
    // brace walk is replaced by a regex, this fails before the scan does.
    for (const n of ['shouldAutoAllow', 'shouldHaltUnrecordedMutation', 'isPinnedToBottom']) {
      expect(names, `${n} is missing — the parser stopped at a line break`).toContain(n);
    }
  });

  test('tests are excluded from the scan', () => {
    // This file's own fixtures are verbatim copies of the declaration it
    // forbids — the same reason `.semgrep/cebab-bus.ts` is excluded from the
    // semgrep step while feeding `semgrep --test`.
    expect(Object.keys(sources).filter((f) => f.includes('.test.'))).toEqual([]);
  });

  test('no exported is/has/can/should function returns a non-boolean', () => {
    expect(
      violations(sources),
      'An exported function named like a predicate does not return a boolean. ' +
        '`if (thing(x))` on a rich return type is legal TypeScript and always ' +
        'true — the compiler cannot catch it, which is why this is a test. ' +
        'Either return `boolean` / `v is T`, or rename it to say what it ' +
        'answers (`check…`, `resolve…`, `find…`). See ' +
        '`checkReconstructable` in server/src/bus/reconstruct.ts, which pairs ' +
        'a rich `check…` with a boolean `canReconstruct` (register N01).',
    ).toEqual([]);
  });
});

/**
 * Walk the three package sources. A directory walk rather than `git ls-files`
 * so the gate runs identically on both CI runners with no subprocess — same
 * approach as `scripts/busSafetyClaims.test.mjs` and
 * `scripts/configSurfaceClaims.test.mjs`.
 */
function collectSources() {
  const out = {};
  for (const root of ['shared/src', 'server/src', 'web/src']) walk(root, out);
  return out;
}

function walk(rel, out) {
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(child, out);
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.includes('.test.')
    ) {
      out[child] = read(child);
    }
  }
}
