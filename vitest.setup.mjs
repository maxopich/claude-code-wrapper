/**
 * Point every vitest worker at a throwaway data directory, before any test
 * module is loaded.
 *
 * WHY AN ENV VAR AND NOT AN IMPORT. `config.dataDir` is read once, at
 * `server/src/config.ts` module init. A setup file that imported the config
 * object and assigned to it would work too — but it would pull server code
 * (and `node:os`, `node:path`, the whole config graph) into every web and
 * shared worker as well, for a value most of them never read. Writing an env
 * var costs nothing, needs no imports, and is environment-agnostic.
 *
 * The ordering this depends on was measured, not assumed: a probe module that
 * read `process.env` at module init saw the value this file sets, and saw
 * `(unset at module init)` with the setup file removed. `setupFiles` runs
 * before the test file's own imports are evaluated.
 *
 * ONE DIRECTORY PER WORKER, not per test. This is a safety floor, not test
 * isolation — it guarantees that a test which reaches `getDb()` without
 * arranging anything cannot touch the operator's real `~/.cebab`. Tests that
 * need a FRESH database per test still arrange that themselves; see
 * `withTempDataDir()` in `server/src/test_support/temp_data_dir.ts`.
 *
 * The matching enforcement is in `getDb()`: it throws if `config.dataDir` is
 * the real data directory while `VITEST` is set. This file is the default,
 * that is the invariant. Deleting this file makes every DB-touching test that
 * does not arrange its own directory fail loudly, rather than silently
 * migrating the developer's real database — which is the bug this pair exists
 * to prevent (register Cebab-cjm; it happened once, in PR #280, and the only
 * visible trace was a changed ctime).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Respect an explicit override so a developer can still aim a run somewhere
// specific. Never at the real `~/.cebab` — getDb() rejects that regardless.
if (!process.env.CEBAB_DATA_DIR) {
  // Worker identity, not randomness: every test file in a given worker should
  // share one directory, and reruns should not accumulate a new one each time.
  // The pid keeps concurrent `vitest` invocations (a watch run alongside a
  // one-off) from colliding.
  const worker = `${process.env.VITEST_POOL_ID ?? '0'}-${process.env.VITEST_WORKER_ID ?? '0'}`;
  const dir = path.join(os.tmpdir(), `cebab-vitest-${process.pid}-${worker}`, '.cebab');

  fs.mkdirSync(dir, { recursive: true });
  process.env.CEBAB_DATA_DIR = dir;

  // Best effort: /tmp gets swept eventually, but a full suite spawns one of
  // these per worker per run and they are not small once migrations apply.
  process.on('exit', () => {
    try {
      fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    } catch {
      // A worker that dies mid-write can leave a busy handle; the OS cleans up.
    }
  });
}
