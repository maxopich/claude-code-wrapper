/**
 * The isolation preamble, once.
 *
 * Register C24: this twelve-line block is currently copy-pasted into 81 of
 * the 113 server test files —
 *
 *     let tmpRoot: string;
 *     let originalDataDir: string;
 *     beforeEach(() => {
 *       tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-<name>-'));
 *       originalDataDir = config.dataDir;
 *       config.dataDir = path.join(tmpRoot, '.cebab');
 *       fs.mkdirSync(config.dataDir, { recursive: true });
 *       closeDb();
 *       getDb();
 *     });
 *     afterEach(() => {
 *       closeDb();
 *       config.dataDir = originalDataDir;
 *       fs.rmSync(tmpRoot, { recursive: true, force: true });
 *     });
 *
 * WHAT THIS IS AND IS NOT FOR. C24 filed the duplication as a safety problem —
 * "one file that forgets a line writes to the developer's real database". A
 * helper does not fix that, because a helper still has to be CALLED: a file
 * that forgets to call this fails in exactly the same way as one that forgets
 * to write the block. That hole is closed elsewhere, by two things that need
 * no cooperation from the test author — `vitest.setup.mjs` points every worker
 * at a temp directory, and `getDb()` throws if a test reaches it with
 * `config.dataDir` still on the real `~/.cebab`.
 *
 * So this is for FRESHNESS, not safety. The worker-level default gives one
 * database shared by every test file in that worker; a test that needs a
 * pristine schema, or that asserts on what it wrote, needs its own. That is
 * what this provides, and it is the only reason the preamble should survive
 * anywhere.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { closeLogger } from '../runner/logger.js';

export type TempDataDir = {
  /** The temp root containing `.cebab/`. Valid only inside a test body. */
  root: () => string;
  /** The `.cebab` directory itself — i.e. what `config.dataDir` is set to. */
  dataDir: () => string;
};

/**
 * Give each test in the enclosing describe its own data directory and a
 * freshly migrated database.
 *
 * @param label short name for the temp directory, e.g. `'orchestrator'`. It
 *   only aids debugging when a directory is left behind, but keep it distinct
 *   per file — a shared prefix makes a leak impossible to attribute.
 * @param openDb whether to call `getDb()` in `beforeEach`. Default true: most
 *   callers need migrations applied before their subject runs. Pass false for
 *   tests that assert on the state of a database that does NOT yet exist.
 */
export function withTempDataDir(label: string, openDb = true): TempDataDir {
  let tmpRoot = '';
  let originalDataDir = '';

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cebab-${label}-`));
    originalDataDir = config.dataDir;
    config.dataDir = path.join(tmpRoot, '.cebab');
    fs.mkdirSync(config.dataDir, { recursive: true });
    // Drop any handle still open, or `getDb()`'s memo would hand back a
    // connection to the PREVIOUS directory and the swap above would silently
    // do nothing.
    //
    // Redundant with the `closeDb()` in `afterEach` below, and deliberately
    // kept: removing this one alone changes no observable behaviour (measured
    // — the teardown has already nulled the memo), but it is what makes this
    // hook correct on its own, for a test that opens a connection some other
    // way or a future edit to the teardown.
    closeDb();
    if (openDb) getDb();
  });

  afterEach(async () => {
    closeDb();
    // Cebab-kji: BEFORE the rmSync, and awaited. The transcript logger keeps a
    // module-level map of open write streams pointing into this directory, and
    // `fs.createWriteStream` opens its fd on a later tick. Removing the
    // directory first raced that open; the failure surfaced as a `console.error`
    // from the stream's `'error'` handler AFTER the test had finished, which
    // vitest turns into an `EnvironmentTeardownError` that fails the entire run
    // with every test green.
    //
    // Cheap for the files that never log: with no streams open this resolves
    // without waiting on anything.
    await closeLogger();
    config.dataDir = originalDataDir;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  return {
    root: () => tmpRoot,
    dataDir: () => config.dataDir,
  };
}
