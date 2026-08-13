/**
 * [security] Register Cebab-cjm — a test must not be able to open the
 * operator's real `~/.cebab`.
 *
 * WHAT HAPPENED. `config.dataDir` is mutable module state defaulting to the
 * real home, and every DB-touching test swaps it by hand. In PR #280 one file
 * did not: `translate()` reached `getSession()` reached `getDb()`, and the
 * full suite opened, migrated and read the developer's actual database on
 * every run. Nothing failed. The only trace was a changed ctime.
 *
 * WHY A GREP CANNOT COVER THIS, which is the whole reason these tests exist:
 * that file never wrote `getDb` or `config.dataDir`. The reach was indirect,
 * three modules deep. A lint rule scanning test sources would have passed it,
 * and so would a check that every test file mentions `config.dataDir` — the
 * offending call site is not in the test file at all.
 *
 * So the coverage is two layers, and each test below pins one:
 *   - `vitest.setup.mjs` points every worker at a temp dir before any module
 *     loads (the default);
 *   - `getDb()` throws when `config.dataDir` is the real one (the invariant).
 *
 * The second is what holds when someone deletes the first.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from './config.js';
import {
  __resetRealDataDirIntentForTests,
  closeDb,
  declareRealDataDirIntent,
  getDb,
} from './db.js';

const REAL_DATA_DIR = path.join(os.homedir(), '.cebab');

describe('[security] the test suite cannot open the real data directory', () => {
  const original = config.dataDir;
  let fakeHome: string;

  // The guard compares `config.dataDir` against `path.join(os.homedir(),
  // '.cebab')`, computed at call time rather than captured — so stubbing
  // `os.homedir()` moves what counts as "the real data directory" to a temp
  // path, and these tests exercise the guard against that instead of the
  // operator's actual home.
  //
  // That is not cosmetic. The obvious way to write this test — point
  // `config.dataDir` at the true `~/.cebab` and expect a throw — means that
  // the moment someone DELETES the guard, the test itself opens and migrates
  // the real database. It did exactly that during this change's own
  // revert-check, which is how the problem was noticed. A test for "we never
  // touch the real database" must not be the thing that touches it.
  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-fakehome-'));
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.dataDir = original;
    closeDb();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  test('getDb throws when config.dataDir is the operator real one', () => {
    // The assertion that would have caught PR #280's bug. Note this test does
    // NOT need to know how the reach happens — it pins the call site, which is
    // the one place that sees every path into the database.
    closeDb();
    config.dataDir = path.join(fakeHome, '.cebab');
    expect(() => getDb()).toThrow(/refusing to open the real data directory/);
  });

  test('the guard is not fooled by a trailing separator or a relative segment', () => {
    // `path.resolve` normalises both sides. Without that, `~/.cebab/` and
    // `~/.cebab/logs/..` would slip past a string compare while opening the
    // same file.
    const home = path.join(fakeHome, '.cebab');
    for (const variant of [`${home}${path.sep}`, path.join(home, 'logs', '..')]) {
      closeDb();
      config.dataDir = variant;
      expect(() => getDb(), `variant ${variant} slipped past the guard`).toThrow(
        /refusing to open the real data directory/,
      );
    }
  });

  test('the stub is real, so these tests are not passing against the true home', () => {
    // Anti-vacuity for the stub itself: if `vi.spyOn` silently failed to take
    // effect, the three tests above would be pointed at the operator's actual
    // `~/.cebab` and would still pass — while doing the exact thing this file
    // exists to forbid.
    expect(os.homedir()).toBe(fakeHome);
    expect(path.resolve(fakeHome)).not.toBe(path.resolve(os.tmpdir()));
    expect(REAL_DATA_DIR).not.toContain(path.basename(fakeHome));
  });

  test('a temp directory is allowed, so the guard is not simply refusing everything', () => {
    // Anti-vacuity for the two tests above: a guard that threw unconditionally
    // would satisfy them and break the entire suite. This is the positive
    // control that says it discriminates.
    closeDb();
    config.dataDir = path.join(os.tmpdir(), `cebab-guard-control-${process.pid}`, '.cebab');
    expect(() => getDb()).not.toThrow();
  });

  // The guard used to return early unless `process.env.VITEST` was set, so it
  // watched vitest and nothing else. On 2026-08-13 a one-off `tsx` benchmark
  // wrote 20,000 synthetic rows into the operator's real database: it assigned
  // `process.env.CEBAB_DATA_DIR` at the top of the file, but ESM hoists
  // `import` above executable statements, so `config.ts` had already read the
  // variable and resolved `~/.cebab`. Not a test, so nothing stopped it.
  //
  // These cases run with VITEST unset so they exercise the branch a script
  // takes. The homedir stub above still applies, so a regression here writes
  // to a temp directory rather than to the operator's real one.
  test('a script that did not declare intent is refused too', () => {
    const hadVitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      closeDb();
      config.dataDir = path.join(fakeHome, '.cebab');
      expect(() => getDb()).toThrow(/did not declare it/);
      // The message has to teach the fix, because the person reading it is
      // mid-incident and the cause (import hoisting) is not visible in their
      // code.
      expect(() => getDb()).toThrow(/DYNAMIC import/);
    } finally {
      if (hadVitest !== undefined) process.env.VITEST = hadVitest;
    }
  });

  test('the script branch still allows a scratch directory', () => {
    // Positive control for the case above: a guard that refused every path
    // outside vitest would break `smoke.ts` and every future script.
    const hadVitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      closeDb();
      config.dataDir = path.join(os.tmpdir(), `cebab-script-control-${process.pid}`, '.cebab');
      expect(() => getDb()).not.toThrow();
    } finally {
      if (hadVitest !== undefined) process.env.VITEST = hadVitest;
    }
  });

  test('declaring intent is what lets the server through', () => {
    const hadVitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      closeDb();
      config.dataDir = path.join(fakeHome, '.cebab');
      declareRealDataDirIntent();
      expect(() => getDb()).not.toThrow();
    } finally {
      if (hadVitest !== undefined) process.env.VITEST = hadVitest;
      __resetRealDataDirIntentForTests();
    }
  });

  test('the declaration does not leak into the next case', () => {
    // Ordering-dependent ON PURPOSE, and it must stay after the case above.
    // `realDataDirDeclared` is module state, so a declaration that is never
    // withdrawn leaves the guard switched off for every later test in the
    // worker — the guard being off is exactly the condition it exists to
    // catch, so it must not be reachable by forgetting a cleanup. Without
    // this case the reset seam is unobserved and its removal is invisible.
    const hadVitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      closeDb();
      config.dataDir = path.join(fakeHome, '.cebab');
      expect(() => getDb()).toThrow(/did not declare it/);
    } finally {
      if (hadVitest !== undefined) process.env.VITEST = hadVitest;
    }
  });
});

describe('[security] the per-worker default lands before any module loads', () => {
  test('config.dataDir is not the real data directory, with no arrangement by this test', () => {
    // Deliberately arranges NOTHING. `config.ts` reads CEBAB_DATA_DIR once at
    // module init, so this passing proves `vitest.setup.mjs` ran before this
    // file's imports were evaluated — the ordering the whole default rests on,
    // and one that would otherwise fail OPEN.
    expect(path.resolve(config.dataDir)).not.toBe(path.resolve(REAL_DATA_DIR));
  });

  test('the default points somewhere real and disposable', () => {
    // Anti-vacuity: `not.toBe(real)` above is satisfied by an empty string or
    // by any nonsense value. Pin that the worker actually got a usable temp
    // directory, or the test above proves only that a bug is not this bug.
    expect(config.dataDir).not.toBe('');
    expect(path.resolve(config.dataDir).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    expect(config.dataDir).toContain('cebab-vitest-');
  });

  test('CEBAB_DATA_DIR is the seam config reads, and it agrees with config', () => {
    // If these ever disagree, something reassigned config.dataDir at runtime
    // and the env var is no longer evidence of anything.
    const fromEnv = process.env.CEBAB_DATA_DIR;
    expect(fromEnv).toBeTruthy();
    expect(path.resolve(fromEnv ?? '')).toBe(path.resolve(config.dataDir));
  });
});
