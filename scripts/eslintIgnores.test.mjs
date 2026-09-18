import { describe, expect, test } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `Cebab-1513`: what `eslint .` skips, and — more importantly — what it must
 * NOT skip.
 *
 * eslint's ignore list and `.gitignore` are independent mechanisms. `eslint .`
 * walks the directory tree regardless of what git ignores, so a gitignored JS
 * file inside a gitignored directory still fails the lint gate — measured, in a
 * bead that never touched lint, with nothing in `git status`, the diff or the
 * loop's guard to explain it.
 *
 * The fix adds ONE state directory. The obvious generalisation — derive the
 * ignore list from `.gitignore` — was built, measured and rejected, and the
 * fourth case below is what stops it coming back: the autonomous driver's CODE
 * is gitignored too and is linted today, and that lint is very nearly the only
 * automated check it gets (no PR, no review, no CI). Deriving the list would
 * drop it silently, and no gate could see the loss — CI clones the repo, so
 * those files are not even present there.
 *
 * These are CONFIG questions, not filesystem ones: `isPathIgnored` answers from
 * the resolved config, so the cases hold on a CI runner where the gitignored
 * driver files do not exist.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: repoRoot });
const ignored = (rel) => eslint.isPathIgnored(path.join(repoRoot, rel));

describe('eslint ignores (Cebab-1513)', () => {
  test('the loop harness STATE directory is ignored', async () => {
    expect(await ignored('.loop/supervisor.mjs')).toBe(true);
    expect(await ignored('.loop/anything/nested/helper.mjs')).toBe(true);
  });

  test('CONTROL: ordinary source is still linted', async () => {
    // Without this, "ignore everything" satisfies the case above. The two
    // directions are different bugs and need different evidence.
    expect(await ignored('web/src/App.tsx')).toBe(false);
    expect(await ignored('server/src/index.ts')).toBe(false);
    expect(await ignored('shared/src/protocol.ts')).toBe(false);
  });

  test('the loop driver CODE stays linted, though it is gitignored', async () => {
    // THE ONE THAT MATTERS. `/scripts/loop.mjs`, `/scripts/revert-check.mjs`
    // and `/scripts/lib/loop/` are all in `.gitignore`, so any change that
    // derives eslint's ignores from `.gitignore` turns these true and reddens
    // here instead of silently removing the driver's only lint coverage.
    expect(await ignored('scripts/loop.mjs')).toBe(false);
    expect(await ignored('scripts/revert-check.mjs')).toBe(false);
    expect(await ignored('scripts/lib/loop/machine.mjs')).toBe(false);
  });

  test('gitignored-ness is not the criterion; category is', async () => {
    // Stated as its own case because the distinction is the whole design and a
    // reader who misses it will "simplify" this config back into the bug.
    // Both paths below are gitignored. Only one is STATE.
    const stateIsIgnored = await ignored('.loop/config-helper.mjs');
    const codeIsIgnored = await ignored('scripts/lib/loop/select.mjs');
    expect(stateIsIgnored).toBe(true);
    expect(codeIsIgnored).toBe(false);
    expect(stateIsIgnored).not.toBe(codeIsIgnored);
  });
});
