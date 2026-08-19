import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { config } from './config.js';
import { initAuthToken } from './auth.js';
import { closeDb, getDb } from './db.js';
import {
  DIR_MODE,
  FILE_MODE,
  ensureDataDir,
  hardenDataDir,
  newFileMode,
  precreateDbFile,
  secureFile,
  secureMkdir,
} from './data_perms.js';
import {
  hardenDataDirOnce,
  reportInsecureDataDir,
  runDataPermsBootCheck,
  _testing,
} from './data_perms_boot.js';
import { _resetOperatorIdCache } from './notifications/operator.js';
import { getSetting, setSetting } from './repo/settings.js';

// [security] Register H01 — the database and transcripts were created with the
// ambient umask.
//
// THE DEFECT. `auth.ts` wrote `~/.cebab/auth-token` at 0600 behind a comment
// calling that "the cross-uid protection". Everything else the same process
// wrote into the same directory used the default umask, so on a stock install
// (umask 022) the 8 MB `cebab.sqlite` holding every transcript, every trust
// decision and the whole hash-chained audit log sat at 0644 — readable by any
// other local account. The credential was guarded; the data it protects was not.
//
// WHAT THIS SUITE IS NOT. It does not claim tamper resistance. Modes do not
// stop a same-uid write, which is the attacker `audit_tip.ts` already documents
// it cannot beat. These cases pin CONFIDENTIALITY against OTHER local accounts,
// and — the half that is easy to get wrong — that the fix reaches installs that
// already exist rather than only new ones.

// POSIX modes carry no ACL guarantee on Windows (Node maps only the write bit),
// and `data_perms.ts` gates every mode operation on the same check. Asserting
// `mode & 0o777` there would fail on a difference that means nothing, so the
// assertions below are gated exactly as `auth.test.ts:32` gates its own.
const POSIX = process.platform !== 'win32';

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-perms-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  closeDb();
  _resetOperatorIdCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  // closeDb before rm: Windows cannot unlink an open SQLite file.
  closeDb();
  config.dataDir = originalDataDir;
  _resetOperatorIdCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Mode bits, or -1 when the path is missing. */
function mode(p: string): number {
  try {
    return fs.statSync(p).mode & 0o777;
  } catch {
    return -1;
  }
}

/** Rebuild the exact layout measured on a real pre-fix install: 0755
 *  directories, 0644 files, at both the top level and inside `logs/`. */
function buildLooseInstall(): { db: string; log: string; logsDir: string } {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o755 });
  const logsDir = path.join(config.dataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o755 });
  const db = path.join(config.dataDir, 'cebab.sqlite');
  const log = path.join(logsDir, 'session-abc.jsonl');
  fs.writeFileSync(db, 'not-really-sqlite', { mode: 0o644 });
  fs.writeFileSync(log, '{"a":1}\n', { mode: 0o644 });
  // chmod explicitly: writeFileSync's mode is masked by the ambient umask, and
  // a developer running with umask 077 would otherwise build a "loose" fixture
  // that is already tight and pass this suite vacuously.
  fs.chmodSync(config.dataDir, 0o755);
  fs.chmodSync(logsDir, 0o755);
  fs.chmodSync(db, 0o644);
  fs.chmodSync(log, 0o644);
  return { db, log, logsDir };
}

/** Loosen a REAL data dir (one `getDb()` has already built) back to the
 *  pre-fix modes. `buildLooseInstall` writes a placeholder where the database
 *  goes, which is fine for a pure sweep but not for a case that also has to
 *  open the DB. */
function loosenExisting(): void {
  fs.chmodSync(config.dataDir, 0o755);
  fs.chmodSync(config.dbPath, 0o644);
}

describe('[security] the existing install is retrofitted', () => {
  test('a 0755/0644 tree becomes 0700/0600', () => {
    // THE load-bearing case. `mkdirSync`'s `mode` is ignored for a directory
    // that already exists and `createWriteStream`'s applies only on create, so
    // without this sweep the fix would be real only for brand-new installs and
    // every existing database would stay world-readable forever.
    if (!POSIX) return;
    const { db, log, logsDir } = buildLooseInstall();
    expect(mode(db)).toBe(0o644);

    const result = hardenDataDir();

    expect(result.applied).toBe(true);
    expect(mode(config.dataDir)).toBe(DIR_MODE);
    expect(mode(logsDir)).toBe(DIR_MODE);
    expect(mode(db)).toBe(FILE_MODE);
    expect(mode(log)).toBe(FILE_MODE);
    expect(result.stillLoose).toEqual([]);
  });

  test('it reaches arbitrarily deep, not just the top level', () => {
    // `bus/` on installs predating the SDK rewrite is two levels down.
    if (!POSIX) return;
    fs.mkdirSync(config.dataDir, { recursive: true });
    const deep = path.join(config.dataDir, 'bus', 'agents', 'th-partner');
    fs.mkdirSync(deep, { recursive: true, mode: 0o755 });
    const f = path.join(deep, 'comm.md');
    fs.writeFileSync(f, 'x');
    fs.chmodSync(deep, 0o755);
    fs.chmodSync(f, 0o644);

    hardenDataDir();

    expect(mode(deep)).toBe(DIR_MODE);
    expect(mode(f)).toBe(FILE_MODE);
  });

  test('it counts only what it actually changed', () => {
    // A count inflated by already-tight paths would make the boot log claim
    // work it did not do.
    if (!POSIX) return;
    buildLooseInstall();
    const first = hardenDataDir();
    expect(first.dirsChanged + first.filesChanged).toBeGreaterThan(0);

    const second = hardenDataDir();
    expect(second.dirsChanged).toBe(0);
    expect(second.filesChanged).toBe(0);
  });

  test('a symlink out of the data dir is not followed', () => {
    // chmod follows symlinks. Walking one would let anything that can drop a
    // link into ~/.cebab re-permission an arbitrary path as the operator.
    if (!POSIX) return;
    fs.mkdirSync(config.dataDir, { recursive: true });
    const outside = path.join(tmpRoot, 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    fs.chmodSync(outside, 0o644);
    fs.symlinkSync(outside, path.join(config.dataDir, 'link.txt'));

    hardenDataDir();

    expect(mode(outside)).toBe(0o644);
  });
});

describe('[security] new paths are created tight', () => {
  test('secureMkdir creates 0700 and tightens an existing directory', () => {
    if (!POSIX) return;
    const fresh = path.join(tmpRoot, 'fresh');
    secureMkdir(fresh);
    expect(mode(fresh)).toBe(DIR_MODE);

    // The case `mkdirSync({ mode })` alone does NOT handle.
    const stale = path.join(tmpRoot, 'stale');
    fs.mkdirSync(stale, { mode: 0o755 });
    fs.chmodSync(stale, 0o755);
    secureMkdir(stale);
    expect(mode(stale)).toBe(DIR_MODE);
  });

  test('the database and its WAL/SHM sidecars are all 0600', () => {
    // SQLite derives journal permissions from the main database file, so
    // pre-creating that one file at 0600 covers all three. If the pre-create
    // ever moves after the WAL pragma, this goes red.
    if (!POSIX) return;
    getDb();
    expect(mode(config.dbPath)).toBe(FILE_MODE);
    // -wal/-shm exist while the connection is open.
    expect(mode(config.dbPath + '-wal')).toBe(FILE_MODE);
    expect(mode(config.dbPath + '-shm')).toBe(FILE_MODE);
    expect(mode(config.dataDir)).toBe(DIR_MODE);
  });

  test('precreateDbFile leaves an existing database readable', () => {
    // It must be a touch, not a truncate — SQLite opening a clobbered file
    // would be data loss dressed up as a permission fix.
    if (!POSIX) return;
    getDb().prepare(`CREATE TABLE IF NOT EXISTS probe (x TEXT)`).run();
    getDb().prepare(`INSERT INTO probe (x) VALUES ('kept')`).run();
    closeDb();

    precreateDbFile(config.dbPath);

    const row = getDb().prepare(`SELECT x FROM probe`).get() as { x: string } | undefined;
    expect(row?.x).toBe('kept');
  });

  test('secureFile is silent on a path that does not exist', () => {
    expect(() => secureFile(path.join(tmpRoot, 'nope', 'gone.txt'))).not.toThrow();
  });

  test('newFileMode is gated on the platform, like auth.ts', () => {
    expect(newFileMode()).toBe(POSIX ? FILE_MODE : undefined);
  });
});

describe('[security] the boot check', () => {
  test('it sweeps on first boot and records that it did', () => {
    if (!POSIX) return;
    getDb();
    loosenExisting();
    expect(getSetting(_testing.SWEEP_DONE_KEY)).toBeNull();

    const result = hardenDataDirOnce();

    expect(result).not.toBeNull();
    expect(mode(config.dataDir)).toBe(DIR_MODE);
    expect(mode(config.dbPath)).toBe(FILE_MODE);
    expect(getSetting(_testing.SWEEP_DONE_KEY)).toBe(true);
  });

  test('an already-swept, already-tight install does no work', () => {
    // The flag is what keeps a growing logs/ off the boot path.
    if (!POSIX) return;
    getDb();
    setSetting(_testing.SWEEP_DONE_KEY, true);
    expect(hardenDataDirOnce()).toBeNull();
  });

  test('it re-tightens a directory loosened after the flag was set', () => {
    // The self-heal, and the reason this is not "sweep once and trust the flag
    // forever". A restore from a permissive backup or a stray `chmod -R 755`
    // must not leave the guarantee silently not holding.
    if (!POSIX) return;
    getDb();
    setSetting(_testing.SWEEP_DONE_KEY, true);
    fs.chmodSync(config.dataDir, 0o755);

    const result = hardenDataDirOnce();

    expect(result).not.toBeNull();
    expect(mode(config.dataDir)).toBe(DIR_MODE);
  });

  test('a loose database alone triggers the re-sweep', () => {
    // Both spot-checked paths matter: the directory gates traversal, but a
    // world-readable file survives being copied out of a tight directory.
    if (!POSIX) return;
    getDb();
    setSetting(_testing.SWEEP_DONE_KEY, true);
    fs.chmodSync(config.dbPath, 0o644);

    expect(hardenDataDirOnce()).not.toBeNull();
    expect(mode(config.dbPath)).toBe(FILE_MODE);
  });

  test('the flag is not set while paths remain loose', () => {
    // Recording success on a partial sweep would suppress every future attempt
    // and leave the operator with a protection that never took effect. A
    // genuinely unchmoddable path needs a foreign uid, so the failure is
    // injected instead: chmod becomes a no-op and the paths stay loose.
    if (!POSIX) return;
    getDb();
    loosenExisting();
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => {});

    const result = hardenDataDirOnce();

    expect(result?.stillLoose.length).toBeGreaterThan(0);
    expect(getSetting(_testing.SWEEP_DONE_KEY)).not.toBe(true);
  });

  test('a still-loose sweep is retried on the next boot', () => {
    // The consequence of the case above, stated as behaviour: an unset flag
    // means the next boot tries again rather than assuming it is done.
    if (!POSIX) return;
    getDb();
    loosenExisting();
    const spy = vi.spyOn(fs, 'chmodSync').mockImplementation(() => {});
    hardenDataDirOnce();
    spy.mockRestore();

    expect(hardenDataDirOnce()).not.toBeNull();
    expect(mode(config.dataDir)).toBe(DIR_MODE);
  });
});

describe('[security] the operator is told when it could not be fixed', () => {
  test('a still-loose result emits a safety notification and an audit row', () => {
    // The wiring that makes the failure visible. Class `safety` (not
    // `operational`) is what forces the audit row to be written before the
    // notification — BE-1 — so the record survives with no browser attached.
    if (!POSIX) return;
    getDb();
    loosenExisting();
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const emitted = reportInsecureDataDir(hardenDataDirOnce());

    expect(emitted).toBe(true);
    const audit = (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM safety_audit WHERE kind = 'data_perms.insecure'`)
        .get() as { n: number }
    ).n;
    expect(audit).toBeGreaterThan(0);
  });

  test('a clean sweep says nothing', () => {
    // Attach and boot are frequent; an alarm on the healthy path would train
    // the operator to ignore this one.
    if (!POSIX) return;
    getDb();
    expect(reportInsecureDataDir(hardenDataDirOnce())).toBe(false);
    expect(reportInsecureDataDir(null)).toBe(false);
  });

  test('the boot step sweeps and reports in one call', () => {
    // What `index.ts` actually invokes. `main()` boots an HTTP server and is
    // not reachable from a unit test, so the composite is covered here and the
    // untestable part is reduced to a single call site.
    if (!POSIX) return;
    getDb();
    loosenExisting();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = runDataPermsBootCheck();

    expect(result?.dirsChanged).toBeGreaterThan(0);
    expect(mode(config.dataDir)).toBe(DIR_MODE);
    expect(mode(config.dbPath)).toBe(FILE_MODE);
    // It says so, rather than tightening the operator's files silently.
    expect(logSpy.mock.calls.flat().join(' ')).toContain('permissions tightened');
  });

  test('the boot step reports a sweep that could not finish', () => {
    if (!POSIX) return;
    getDb();
    loosenExisting();
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    runDataPermsBootCheck();

    const audit = (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM safety_audit WHERE kind = 'data_perms.insecure'`)
        .get() as { n: number }
    ).n;
    expect(audit).toBeGreaterThan(0);
  });
});

describe('[security] failure is survivable', () => {
  test('getDb still opens when the data dir cannot be tightened', () => {
    // Fail-open, matching index.ts:36-39's reasoning about the chain check:
    // losing the whole app over a mode bit is the worse failure. The boot
    // notification is what carries the bad news.
    if (!POSIX) return;
    expect(() => getDb()).not.toThrow();
    expect(fs.existsSync(config.dbPath)).toBe(true);
  });

  test('hardenDataDir on a data dir that does not exist is a no-op', () => {
    // Ordering guard: something may call this before getDb() has created it.
    config.dataDir = path.join(tmpRoot, 'never-created');
    const result = hardenDataDir();
    expect(result.dirsChanged).toBe(0);
    expect(result.filesChanged).toBe(0);
  });
});

// [security] Cebab-ws0.8 — the data dir must be invisible to git.
//
// `config.dataDir` reads `CEBAB_DATA_DIR` with NO validation, so
// `CEBAB_DATA_DIR=./data` inside a checkout drops the database, its WAL/SHM
// sidecars, the logs and every per-session folder into a git repo as
// untracked-but-unignored noise. That placement is a legitimate dev workflow,
// so it is not refused — it is made harmless.
describe('[security] ensureDataDir gitignores Cebab state (ws0.8)', () => {
  const gitignorePath = (): string => path.join(config.dataDir, '.gitignore');

  test('creates the data dir and a .gitignore that ignores everything', () => {
    ensureDataDir();
    expect(fs.existsSync(config.dataDir)).toBe(true);
    const body = fs.readFileSync(gitignorePath(), 'utf8');
    // A bare `*`, and specifically NOT the `* + !.gitignore` idiom — see the
    // DATA_DIR_GITIGNORE comment. Asserted as an absence, because the idiom is
    // exactly what a well-meaning future edit would reach for.
    expect(body).toContain('*\n');
    expect(body).not.toContain('!.gitignore');
    if (POSIX) expect(mode(gitignorePath())).toBe(FILE_MODE);
  });

  test('is idempotent — a second call rewrites nothing', () => {
    ensureDataDir();
    const before = fs.statSync(gitignorePath());
    const body = fs.readFileSync(gitignorePath(), 'utf8');
    ensureDataDir();
    expect(fs.readFileSync(gitignorePath(), 'utf8')).toBe(body);
    expect(fs.statSync(gitignorePath()).mtimeMs).toBe(before.mtimeMs);
  });

  // The negative that makes `flag: 'wx'` load-bearing rather than incidental.
  // A file we did not write is not ours to rewrite: it is the operator's
  // explicit statement of intent and it wins over ours.
  test('does NOT clobber a .gitignore the operator already wrote', () => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const theirs = '# mine\n!keep-this\n';
    fs.writeFileSync(gitignorePath(), theirs);
    ensureDataDir();
    expect(fs.readFileSync(gitignorePath(), 'utf8')).toBe(theirs);
  });

  test('a write failure is a diagnostic, not a boot failure', () => {
    // The data dir works perfectly well ungitignored — this is hygiene, not a
    // control, so it must never be able to stop the server starting.
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('nope'), { code: 'EACCES' });
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => ensureDataDir()).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // BEHAVIOURAL. The three cases above pin the file's content and lifecycle;
  // only this one pins the thing the operator actually asked for. It is what
  // reddens if someone "improves" DATA_DIR_GITIGNORE to `* + !.gitignore` —
  // every content assertion above could be rewritten to match that change,
  // but git's own answer cannot.
  //
  // Deliberately not skipped when git is absent: a conditional skip is a gate
  // that goes vacuously green, and this repo is a git repo.
  test('git reports nothing in a data dir placed inside a checkout', () => {
    const repo = path.join(tmpRoot, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const git = (args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git(['init', '-q']);
    config.dataDir = path.join(repo, 'data');
    ensureDataDir();
    fs.writeFileSync(path.join(config.dataDir, 'cebab.sqlite'), 'x');

    expect(git(['status', '--porcelain']).trim()).toBe('');

    // Negative control: without the file, the same state IS reported. Without
    // this, a bug that made the data dir empty would pass the assertion above.
    fs.rmSync(path.join(config.dataDir, '.gitignore'));
    expect(git(['status', '--porcelain']).trim()).not.toBe('');
  });

  test('both boot entry points create it independently', () => {
    // Either can be first depending on boot order, so neither may depend on
    // the other having run.
    getDb();
    expect(fs.existsSync(gitignorePath())).toBe(true);

    closeDb();
    config.dataDir = path.join(tmpRoot, 'auth-only');
    initAuthToken();
    expect(fs.existsSync(gitignorePath())).toBe(true);
  });
});
