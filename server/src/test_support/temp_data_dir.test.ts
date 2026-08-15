/**
 * Covers `withTempDataDir` — and is its first adopter, so the helper is
 * exercised rather than merely exported.
 *
 * Register C24 filed the copy-pasted preamble as a safety issue. It is not
 * one (a helper still has to be called; see the module header), so what is
 * worth pinning here is the property the preamble actually delivers and the
 * worker-level default does not: a FRESH database per test.
 *
 * NOT COVERED, deliberately: the `fs.rmSync` in the helper's teardown. It only
 * deletes the previous temp directory — each test gets a new `mkdtemp`
 * regardless, so removing it leaks directories under /tmp without making any
 * assertion here fail. Revert-checked and confirmed: no test goes red. It is
 * hygiene, not correctness, and pretending otherwise would put a fake gate in
 * the count.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { __setStreamFactoryForTests, logEvent } from '../runner/logger.js';
import { withTempDataDir } from './temp_data_dir.js';

describe('withTempDataDir', () => {
  const tmp = withTempDataDir('helper-selftest');

  test('points config.dataDir inside its own temp root', () => {
    expect(config.dataDir).toBe(path.join(tmp.root(), '.cebab'));
    expect(tmp.dataDir()).toBe(config.dataDir);
    expect(path.resolve(tmp.root()).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    expect(fs.existsSync(config.dataDir)).toBe(true);
  });

  test('migrations are applied, so the database is usable immediately', () => {
    const rows = getDb()
      .prepare<[], { filename: string }>('SELECT filename FROM schema_migrations')
      .all();
    expect(rows.length).toBeGreaterThan(20);
  });

  // NOTE: the next two tests are a PAIR and only mean something run together
  // — the second's assertion is about what the first wrote. Running either
  // alone (`-t`) passes vacuously, because the row is absent for the boring
  // reason that nothing ever wrote it. Verified: reverting the helper's
  // teardown reddens this pair on a whole-file run and is invisible to a
  // filtered one.
  test('each test gets a database that does not carry the previous one writes', () => {
    // The freshness property, and the reason the preamble survives at all.
    // The row written below would still be here on the next test if the
    // directory were shared, which is exactly what the worker-level default
    // in vitest.setup.mjs gives you.
    const db = getDb();
    const before = db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM settings WHERE key='helper-probe'")
      .get();
    expect(before?.n).toBe(0);
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'helper-probe',
      '1',
      1,
    );
  });

  test('and again, from a clean database', () => {
    // Deliberately identical to the assertion above. If `afterEach` stopped
    // tearing down, or `closeDb()` were dropped so `getDb()` handed back the
    // memoised previous connection, this is the test that goes red.
    const rows = getDb()
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM settings WHERE key='helper-probe'")
      .get();
    expect(rows?.n).toBe(0);
  });
});

describe('withTempDataDir with openDb false', () => {
  const tmp = withTempDataDir('helper-noopen', false);

  test('creates the directory but leaves the database unopened', () => {
    expect(fs.existsSync(tmp.dataDir())).toBe(true);
    expect(fs.existsSync(path.join(tmp.dataDir(), 'cebab.sqlite'))).toBe(false);
  });
});

/**
 * Cebab-kji. The teardown closes the transcript logger BEFORE `fs.rmSync`, and
 * awaits it. Without the await, the directory goes while `fs.createWriteStream`
 * may still be opening its fd; that open then fails ENOENT, the stream's
 * `'error'` handler logs AFTER the test has finished, and vitest turns a
 * console line arriving during worker teardown into an
 * `EnvironmentTeardownError` that fails the whole run with every test green.
 *
 * Pinned by ORDER rather than by timing, so it is deterministic: the injected
 * stream records whether the temp directory still existed at the moment it
 * closed. Awaited, it does; not awaited, `rmSync` has already run.
 */
describe('withTempDataDir closes the transcript logger before removing the directory', () => {
  const tmp = withTempDataDir('helper-logger-order');
  const observed: string[] = [];

  /** A stream that closes one tick later, like the real one. */
  class SlowStream extends EventEmitter {
    writableNeedDrain = false;
    closed = false;
    constructor(private readonly root: string) {
      super();
    }
    write(): boolean {
      return true;
    }
    end(): void {
      setImmediate(() => {
        observed.push(fs.existsSync(this.root) ? 'dir-present-at-close' : 'dir-already-removed');
        this.closed = true;
        this.emit('close');
      });
    }
  }

  test('a test writes a transcript and leaves the stream open', async () => {
    const root = tmp.root();
    __setStreamFactoryForTests(() => new SlowStream(root) as unknown as fs.WriteStream);
    await logEvent('sess-teardown-order', { n: 1 });
    // Reset the factory now; the stream for this session is already cached, so
    // the teardown still closes the injected one and no later test is affected.
    __setStreamFactoryForTests(null);
    expect(observed).toEqual([]); // nothing has closed yet
  });

  test('the previous test closed its stream while the directory still existed', () => {
    expect(observed).toEqual(['dir-present-at-close']);
  });
});
