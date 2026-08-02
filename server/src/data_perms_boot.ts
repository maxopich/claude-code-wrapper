import { config } from './config.js';
import { hardenDataDir, posixModesApply, spotCheckLoose, type HardenResult } from './data_perms.js';
import { emit as emitNotification } from './notifications/dispatcher.js';
import { getSetting, setSetting } from './repo/settings.js';

/**
 * Register H01, boot half: decide whether the retrofit sweep needs to run, and
 * tell the operator when it could not do its job.
 *
 * Split from `data_perms.ts` because that module is a leaf `db.ts` calls into
 * while creating the database — anything it imports runs before the DB exists.
 * Everything here needs the database (the once-per-install flag lives in
 * `settings`, and the notification writes a `safety_audit` row), so it lives
 * on this side of the line and imports `data_perms` rather than the reverse.
 */

/** Set once the retrofit sweep has run cleanly, so it is not repeated on every
 *  boot. Versioned: widening the sweep later means bumping to `_v2`, which
 *  re-runs it everywhere. Lives in the `settings` table, which predates this —
 *  no migration needed. */
const SWEEP_DONE_KEY = 'data_perms.hardened_v1';

/**
 * Run the sweep if it has not run, or if the guarantee has since stopped
 * holding. Returns null when there was nothing to do.
 *
 * Deliberately NOT "sweep once, then trust the flag forever". A restore from a
 * permissive backup, a stray `chmod -R 755 ~/.cebab`, or a file written by a
 * build predating this module all loosen things after the flag is set. The
 * two-stat spot check means the guarantee is verified on each boot rather than
 * assumed, and a loose result re-runs the sweep instead of leaving the operator
 * with a protection that quietly stopped applying — the exact failure mode this
 * series of fixes exists to remove.
 *
 * The flag is set ONLY on a clean sweep. Recording success after a partial one
 * would suppress every future attempt.
 */
export function hardenDataDirOnce(): HardenResult | null {
  if (!posixModesApply()) return null;

  const alreadySwept = getSetting<boolean>(SWEEP_DONE_KEY) === true;
  if (alreadySwept && !spotCheckLoose()) return null;

  const result = hardenDataDir();
  if (result.stillLoose.length === 0) setSetting(SWEEP_DONE_KEY, true);
  return result;
}

/**
 * Report a sweep that left paths reachable by other accounts.
 *
 * Severity `warn` rather than `danger` — the exposure is to other local
 * accounts, not to the network — while the class stays `safety`, so the audit
 * row is written before the notification (BE-1) and the event is never
 * coalesced at the recording layer. `NotificationSeverity`'s own docstring
 * blesses that split explicitly.
 *
 * Deduped by key, so a filesystem that genuinely cannot carry POSIX modes (a
 * read-only mount, exFAT) costs the operator one acknowledgement rather than a
 * fresh nag on every boot.
 *
 * Returns true if a notification was emitted.
 */
export function reportInsecureDataDir(result: HardenResult | null): boolean {
  if (!result || result.stillLoose.length === 0) return false;

  const sample = result.stillLoose.slice(0, 5);
  console.error(`[cebab] data dir still group/other-readable: ${sample.join(', ')}`);

  const emitted = emitNotification(
    {
      severity: 'warn',
      class: 'safety',
      dedupeKey: 'data_perms.insecure',
      title: 'Cebab data directory is readable by other accounts',
      message:
        `${result.stillLoose.length} path(s) under ${config.dataDir} could not be made ` +
        `owner-only, so other users on this machine can read your transcripts and audit ` +
        `log. Check the filesystem permissions, then restart Cebab.`,
      reasonCode: 'data_perms_insecure',
      auditKind: 'data_perms.insecure',
      auditPayload: { count: result.stillLoose.length, sample },
    },
    () => {},
  );
  if (!emitted.ok) {
    console.error(`[cebab] could not record data-dir permission warning: ${emitted.error}`);
  }
  return true;
}

/**
 * The whole boot step, as one call: sweep if needed, log what changed, and
 * report anything left exposed.
 *
 * Deliberately one function rather than three statements in `index.ts`'s
 * `main()`. `main()` boots an HTTP server, so nothing in it is reachable from a
 * unit test; keeping the logic here means the behaviour is covered and the
 * untestable part is a single call rather than a sequence that could silently
 * lose a step. Returns the sweep result for the caller's own logging, or null
 * when there was nothing to do.
 */
export function runDataPermsBootCheck(): HardenResult | null {
  const result = hardenDataDirOnce();
  if (result && result.dirsChanged + result.filesChanged > 0) {
    console.log(
      `[cebab] data dir permissions tightened ` +
        `(${result.dirsChanged} dirs, ${result.filesChanged} files)`,
    );
  }
  reportInsecureDataDir(result);
  return result;
}

/** Test-only handle on the settings key, so a case can exercise both the
 *  first-sweep and the already-swept paths without hardcoding the string. */
export const _testing = { SWEEP_DONE_KEY };
