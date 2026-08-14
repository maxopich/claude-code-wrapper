/**
 * Cebab-1uk: prove the react-hooks rules can actually FIRE.
 *
 * WHY THIS EXISTS. A misspelled rule name is an ESLint startup error, so that
 * failure mode is self-checking. The one that is not is the `files:` glob: a
 * rule scoped to a pattern that matches nothing is **silent and green**, and
 * indistinguishable from a clean tree. `npm run lint` passing says the repo has
 * no violations OR that the rules never ran, and nothing else in CI can tell
 * those apart. Same reasoning as `scripts/semgrepRules.test.mjs` — a rule that
 * cannot fire is worse than no rule, because it reads as coverage.
 *
 * These cases lint fixture TEXT through the repo's real `eslint.config.js`, so
 * they exercise the actual glob rather than a copy of it. Nothing
 * deliberately-broken is committed to the tree.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { ESLint } = require('eslint');

/** Lint `code` as if it were the file at `relPath`; return react-hooks ruleIds. */
async function ruleIdsFor(code, relPath) {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: join(REPO_ROOT, 'eslint.config.js'),
  });
  const [result] = await eslint.lintText(code, { filePath: join(REPO_ROOT, relPath) });
  return result.messages.map((m) => m.ruleId).filter((id) => (id || '').startsWith('react-hooks/'));
}

/** A hook called from a plain function — `rules-of-hooks` territory. */
const BAD_RULES_OF_HOOKS = `
import { useRef } from 'react';
export const notAComponent = () => useRef(null);
`;

/** An effect reading a prop it does not declare — `exhaustive-deps` territory. */
const BAD_EXHAUSTIVE_DEPS = `
import { useEffect } from 'react';
export function Widget({ label }: { label: string }) {
  useEffect(() => {
    console.log(label);
  }, []);
  return null;
}
`;

/** The same effect, declared correctly. */
const GOOD_EXHAUSTIVE_DEPS = `
import { useEffect } from 'react';
export function Widget({ label }: { label: string }) {
  useEffect(() => {
    console.log(label);
  }, [label]);
  return null;
}
`;

describe('react-hooks rules are live in web/ (Cebab-1uk)', () => {
  test('rules-of-hooks fires', async () => {
    const ids = await ruleIdsFor(BAD_RULES_OF_HOOKS, 'web/src/__liveness__.tsx');
    expect(ids).toContain('react-hooks/rules-of-hooks');
  });

  test('exhaustive-deps fires', async () => {
    const ids = await ruleIdsFor(BAD_EXHAUSTIVE_DEPS, 'web/src/__liveness__.tsx');
    expect(ids).toContain('react-hooks/exhaustive-deps');
  });

  test('clean code in the same directory reports nothing', async () => {
    // The control. Without it, a rule that fired on EVERYTHING would satisfy
    // both cases above and this gate would be waving through noise.
    const ids = await ruleIdsFor(GOOD_EXHAUSTIVE_DEPS, 'web/src/__liveness__.tsx');
    expect(ids).toEqual([]);
  });

  test('a nested web/ directory is covered, not just the top level', async () => {
    // `web/**/*.{ts,tsx}` vs `web/src/*.tsx` is a difference no other test in
    // this repo would notice — 12 of 13 hook-bearing directories are nested.
    const ids = await ruleIdsFor(BAD_EXHAUSTIVE_DEPS, 'web/src/components/agentControl/__x__.tsx');
    expect(ids).toContain('react-hooks/exhaustive-deps');
  });
});

describe('the scoping is real, not accidentally global (Cebab-1uk)', () => {
  test('server/ is not linted by the react-hooks rules', async () => {
    // Negative control. The block is scoped to web/ because that is where
    // React lives; if it ever silently widened, this is what would say so.
    const ids = await ruleIdsFor(BAD_EXHAUSTIVE_DEPS, 'server/src/__liveness__.tsx');
    expect(ids).toEqual([]);
  });

  test('the negative control is not passing for the wrong reason', async () => {
    // If `server/src/*.tsx` were excluded from linting altogether — by an
    // `ignores` entry, say — the case above would pass while proving nothing.
    // Assert the file IS linted, by some other rule reporting on it.
    const eslint = new ESLint({
      cwd: REPO_ROOT,
      overrideConfigFile: join(REPO_ROOT, 'eslint.config.js'),
    });
    const [result] = await eslint.lintText('const unused = 1;\nexport const x: number = y;\n', {
      filePath: join(REPO_ROOT, 'server/src/__liveness__.tsx'),
    });
    expect(result.messages.length).toBeGreaterThan(0);
  });
});
