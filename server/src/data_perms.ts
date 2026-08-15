import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';

/**
 * Register H01: owner-only permissions for everything Cebab writes under
 * `~/.cebab`.
 *
 * WHY THIS EXISTS. `auth.ts` writes `~/.cebab/auth-token` at mode 0600 behind
 * a comment explaining that this is the cross-uid protection. Every other file
 * the same process writes into the same directory used the ambient umask. On a
 * default install (umask 022) that meant:
 *
 *   drwxr-xr-x  ~/.cebab/
 *   -rw-------  auth-token          <- 0600, the only guarded file
 *   -rw-r--r--  cebab.sqlite        <- 0644, world-readable
 *   -rw-r--r--  cebab.sqlite-wal
 *   drwxr-xr-x  logs/
 *   -rw-r--r--  <session>.jsonl     <- 0644
 *
 * The database holds every transcript, every trust decision, the hash-chained
 * `safety_audit` log and the forensic snapshots. The token guarded the door
 * while the data it protects was readable by any other local uid.
 *
 * ── WHAT THIS IS ───────────────────────────────────────────────────────────
 * CONFIDENTIALITY AT REST, against OTHER local users. Nothing more. It does
 * not stop a same-uid write, which is exactly the attacker `audit_tip.ts`
 * documents it cannot beat either — an agent running as the operator owns
 * these files regardless of mode. Read `0700`/`0600` as "other accounts on
 * this machine cannot read the data plane", not as tamper resistance.
 *
 * ── TWO HALVES, BOTH REQUIRED ──────────────────────────────────────────────
 * Node's `fs` was measured rather than assumed, and the result shapes the
 * module:
 *
 *   - `mkdirSync(p, { recursive: true, mode: 0o700 })` applies the mode to
 *     directories it CREATES, and silently ignores it when `p` already exists.
 *   - `createWriteStream(p, { mode: 0o600 })` likewise applies only on create.
 *
 * So getting creation right protects new installs and does not touch a single
 * existing byte. `hardenDataDir()` is the other half: a one-time sweep that
 * chmods what is already on disk. Without it, an install that predates this
 * build keeps its world-readable database forever.
 *
 * ── WINDOWS ────────────────────────────────────────────────────────────────
 * Every mode operation here is gated on `process.platform !== 'win32'`, the
 * same gate `auth.ts` applies for the same reason: Node maps only the write
 * bit to the read-only attribute there, so POSIX modes carry no ACL guarantee.
 * The exposure is also materially smaller — `C:\Users\<name>` denies other
 * standard users by default — so the honest position is that this control is a
 * no-op on Windows and the default profile ACL is what protects the data.
 * Real per-user ACLs would mean shelling out to `icacls`; that is its own
 * decision, not something to fake with a mode bit.
 *
 * ── WHY THIS MODULE TOUCHES NO DATABASE ────────────────────────────────────
 * `db.ts` calls into here to create `~/.cebab` and pre-create the SQLite file,
 * so anything this module imports runs before the database exists. It stays a
 * leaf over `fs` + `config` for that reason. The policy that needs the DB —
 * the once-per-install flag and the operator notification — lives in
 * `data_perms_boot.ts`, which imports this rather than the other way round.
 */

/** Directories: owner rwx only. `x` is required to traverse into them. */
export const DIR_MODE = 0o700;

/** Files: owner rw only. */
export const FILE_MODE = 0o600;

/** Any bit in this mask means some other account can reach the path. */
const GROUP_OTHER_MASK = 0o077;

/** POSIX modes are meaningful; on Windows they are not. Single gate so no
 *  call site has to remember. */
function modesApply(): boolean {
  return process.platform !== 'win32';
}

/**
 * `mkdirSync(recursive)` with the right mode, and tighten it if the directory
 * already exists.
 *
 * Drop-in for the bare `fs.mkdirSync(dir, { recursive: true })` calls that
 * created `~/.cebab` and `~/.cebab/logs`. Never throws on the chmod: a
 * directory we cannot tighten is a diagnostic, not a reason to fail the
 * caller — see `hardenDataDir` for where that gets reported.
 */
export function secureMkdir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if (!modesApply()) return;
  try {
    // Covers the pre-existing case, where mkdir ignored the mode above.
    fs.chmodSync(dir, DIR_MODE);
  } catch {
    // Best-effort; hardenDataDir() reports what is still loose.
  }
}

/**
 * Mode to pass when CREATING a file, or `undefined` where POSIX modes carry no
 * guarantee. Keeps the platform gate in one place so call sites can hand the
 * result straight to `createWriteStream`/`writeFileSync` without repeating it.
 */
export function newFileMode(): number | undefined {
  return modesApply() ? FILE_MODE : undefined;
}

/** Tighten one existing file to 0600. Missing files and chmod failures are
 *  both silent — callers use this opportunistically. */
export function secureFile(file: string): void {
  if (!modesApply()) return;
  try {
    fs.chmodSync(file, FILE_MODE);
  } catch {
    // Missing or unchmoddable; hardenDataDir() reports what is still loose.
  }
}

/**
 * Create the SQLite file at 0600 before better-sqlite3 opens it.
 *
 * better-sqlite3 exposes no mode option, so the choice is to pre-create or to
 * chmod afterwards. Pre-creating wins twice. It avoids the window where the
 * file briefly exists at 0644 — the same reasoning that makes `auth.ts`
 * unlink-then-write rather than write-then-chmod. And it fixes the WAL and SHM
 * sidecars for free: SQLite derives journal permissions from the main database
 * file, so a 0600 database yields a 0600 `-wal` and `-shm` (measured, not
 * assumed). That makes this one call the single control point for all three.
 *
 * `openSync(p, 'a', mode)` creates an empty file when absent and is a no-op
 * touch when present — SQLite treats a zero-byte file as an empty database.
 * An existing file keeps its old mode, so the `secureFile` follow-up is what
 * covers the upgrade path.
 */
export function precreateDbFile(dbPath: string): void {
  if (!modesApply()) return;
  try {
    fs.closeSync(fs.openSync(dbPath, 'a', FILE_MODE));
    secureFile(dbPath);
  } catch {
    // If we cannot create it, better-sqlite3's own open will report properly.
  }
}

/**
 * Every path under `dataDir` whose mode we own.
 *
 * Enumerated by walking rather than by listing known names, so a file added
 * later is covered without anyone remembering to update a list here. Today
 * that walk finds: `cebab.sqlite` and its `-wal`/`-shm` sidecars, `auth-token`,
 * the H14 chain-tip mirror, `logs/` with the per-session JSONL transcripts and
 * `origin_rejections.log`, and `bus/` — a leftover from the pre-SDK
 * architecture that still holds agent comm files on installs predating the
 * rewrite.
 */
function dataDirEntries(): { dirs: string[]; files: string[] } {
  const dirs: string[] = [config.dataDir];
  const files: string[] = [];
  collectTree(config.dataDir, dirs, files);
  return { dirs, files };
}

/** An unreadable directory contributes nothing rather than aborting the walk —
 *  one bad subdirectory must not stop the rest of the tree being tightened. */
function readDirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Recursive walk, symlinks NOT followed — `withFileTypes` reports a symlink
 *  as neither file nor directory, so it is skipped rather than chased out of
 *  the data directory (chmod follows symlinks, so walking one would let a
 *  planted link re-permission an arbitrary path). */
function collectTree(dir: string, dirs: string[], files: string[]): void {
  for (const ent of readDirSafe(dir)) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      dirs.push(p);
      collectTree(p, dirs, files);
    } else if (ent.isFile()) {
      files.push(p);
    }
  }
}

/** Paths still reachable by another account. Empty is the healthy answer. */
function findLoose(dirs: readonly string[], files: readonly string[]): string[] {
  const loose: string[] = [];
  for (const p of [...dirs, ...files]) {
    try {
      if (fs.statSync(p).mode & GROUP_OTHER_MASK) loose.push(p);
    } catch {
      // Vanished mid-sweep (a rotated log, a closed WAL). Not a finding.
    }
  }
  return loose;
}

export type HardenResult = {
  /** False on Windows, where POSIX modes carry no guarantee. */
  applied: boolean;
  dirsChanged: number;
  filesChanged: number;
  /** Paths still group/other-accessible after the sweep. Non-empty means the
   *  protection is NOT in place and the operator needs to hear about it. */
  stillLoose: string[];
};

/**
 * Retrofit every existing path under `~/.cebab` to owner-only.
 *
 * This is the half that protects the install you already have. Creation-time
 * modes do nothing for a database written months ago, and `mkdirSync`'s mode
 * is ignored for a directory that already exists — so without this sweep the
 * fix would be real only for people installing Cebab for the first time.
 *
 * Idempotent and safe to call repeatedly; `hardenDataDirOnce` is the gate that
 * keeps it off the boot path once it has succeeded.
 */
export function hardenDataDir(): HardenResult {
  if (!modesApply()) {
    return { applied: false, dirsChanged: 0, filesChanged: 0, stillLoose: [] };
  }
  const { dirs, files } = dataDirEntries();
  let dirsChanged = 0;
  let filesChanged = 0;

  for (const d of dirs) {
    try {
      if ((fs.statSync(d).mode & GROUP_OTHER_MASK) === 0) continue;
      fs.chmodSync(d, DIR_MODE);
      dirsChanged++;
    } catch {
      // Reported below via findLoose rather than thrown.
    }
  }
  for (const f of files) {
    try {
      if ((fs.statSync(f).mode & GROUP_OTHER_MASK) === 0) continue;
      fs.chmodSync(f, FILE_MODE);
      filesChanged++;
    } catch {
      // Same.
    }
  }

  return { applied: true, dirsChanged, filesChanged, stillLoose: findLoose(dirs, files) };
}

/**
 * True if either load-bearing path — the data directory or the database — is
 * reachable by another account.
 *
 * Two `stat` calls, which is what lets the boot check run unconditionally:
 * `logs/` grows without bound, and re-walking it every boot to confirm a state
 * already established would be pure waste. The directory gates traversal; the
 * database file matters separately because a world-readable file survives
 * being copied out of a tight directory.
 */
export function spotCheckLoose(): boolean {
  for (const p of [config.dataDir, config.dbPath]) {
    try {
      if (fs.statSync(p).mode & GROUP_OTHER_MASK) return true;
    } catch {
      // Absent (a fresh install before getDb, or a moved data dir).
    }
  }
  return false;
}

/** True where POSIX modes carry a real guarantee. Exported so `data_perms_boot`
 *  and the tests apply the same gate rather than re-deriving it. */
export function posixModesApply(): boolean {
  return modesApply();
}

export const _testing = { GROUP_OTHER_MASK };
