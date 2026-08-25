/**
 * Autonomous loop — choosing the next bead.
 *
 * PURE. Builds the `bd ready` argv, and filters the rows bd returns.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY LABEL FILTERING IS NOT DONE HERE, AND MUST NOT BE MOVED HERE.
 *
 * MEASURED, 2026-08-25, bd against this repo's `.beads/`: NO bd JSON output
 * carries a `labels` field. `bd ready --json`, `bd list --json` and
 * `bd show --json` all return exactly
 *
 *   id, title, description, design, acceptance_criteria, notes, status,
 *   priority, issue_type, owner, created_at, created_by, updated_at,
 *   external_ref, dependency_count, dependent_count, comment_count
 *
 * so a client-side `bead.labels.includes(...)` reads `undefined`, treats it as
 * "this bead has no labels", and excludes NOTHING. It would run on every bead,
 * report success, and measure nothing — and the thing it silently stops
 * measuring is the loop's own memory: HARVEST labels a parked bead
 * `loop-stuck` precisely so SELECT skips it next run. Inert, the loop re-picks
 * last night's stuck bead every single night.
 *
 * So label and type exclusion are pushed down to `bd ready`, which does both
 * natively and server-side. Positive controls, same day:
 *   bd ready --json -n 0                              -> 223
 *   bd ready --json -n 0 --exclude-type epic          -> 207  (16 epics exist)
 *   bd ready --json -n 0 --exclude-label security     -> 211  (12 carry it)
 *
 * `readyArgvConformsToConfig` below is what keeps that wiring honest, because
 * this is now the only place the exclusion exists.
 *
 * DO NOT write a unit test that hands `chooseBead` a fixture carrying a
 * `labels` array. That object cannot come out of bd, so the test would pass
 * while the real path stayed broken — a fixture describing the impossible.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { ConfigError } from './config.mjs';

/** `bd ready -s` accepts exactly these. Checked here so a bad config value
 *  fails before the run rather than as a bd error mid-iteration. */
export const SORT_POLICIES = Object.freeze(['priority', 'hybrid', 'oldest']);

/**
 * argv for `bd ready`. `--json` is a bd GLOBAL flag, inherited rather than
 * declared on the subcommand, but it is passed the same way.
 */
export function readyArgv(select, { limit = 50 } = {}) {
  const sort = select.sortPolicy ?? 'priority';
  if (!SORT_POLICIES.includes(sort)) {
    throw new ConfigError(`select.sortPolicy '${sort}' is not one of ${SORT_POLICIES.join(', ')}`);
  }
  const argv = ['ready', '--json', '-n', String(limit), '-s', sort];
  const labels = select.excludeLabels ?? [];
  if (labels.length > 0) argv.push('--exclude-label', labels.join(','));
  const types = select.excludeTypes ?? [];
  if (types.length > 0) argv.push('--exclude-type', types.join(','));
  return argv;
}

/**
 * Does an argv actually carry the exclusions the config asked for? The whole
 * label filter lives in these flags now, so a refactor that drops one would
 * otherwise be invisible — `bd ready` still returns beads, the loop still
 * runs, and only the re-selection of parked work reveals it, days later.
 */
export function readyArgvConformsToConfig(argv, select) {
  const missing = [];
  const has = (flag, value) => {
    const at = argv.indexOf(flag);
    return at !== -1 && argv[at + 1] === value;
  };
  const labels = select.excludeLabels ?? [];
  if (labels.length > 0 && !has('--exclude-label', labels.join(','))) {
    missing.push('--exclude-label');
  }
  const types = select.excludeTypes ?? [];
  if (types.length > 0 && !has('--exclude-type', types.join(','))) {
    missing.push('--exclude-type');
  }
  return { conforms: missing.length === 0, missing };
}

/**
 * Literal stems for the deny-path text check: everything before the first
 * wildcard. `.github/**` -> `.github/`.
 *
 * A pattern that STARTS with a wildcard yields an empty stem, which would make
 * `text.includes('')` true for every bead and empty the ready queue. Dropped
 * rather than kept — the failure of a too-narrow text heuristic is a bead that
 * gets built and then caught by the real guard at PUBLISH; the failure of the
 * empty stem is a loop that selects nothing and looks drained.
 */
export function denyPathStems(denyPaths = []) {
  const stems = [];
  for (const pattern of denyPaths) {
    if (typeof pattern !== 'string') continue;
    let cut = pattern.length;
    for (const wildcard of ['*', '?']) {
      const at = pattern.indexOf(wildcard);
      if (at !== -1 && at < cut) cut = at;
    }
    const stem = pattern.slice(0, cut);
    if (stem.length > 0) stems.push(stem);
  }
  return stems;
}

/**
 * First survivor of bd's own ordering. bd has already sorted by `sortPolicy`
 * and applied the label/type exclusions, so this re-filters only on fields
 * that are actually present in the response, and never re-sorts.
 *
 * @param {Array<object>} beads    rows from `bd ready --json`
 * @param {{select: object, denyStems?: string[], parked?: Set<string>}} opts
 */
export function chooseBead(beads = [], { select = {}, denyStems = [], parked } = {}) {
  const parkedSet = parked instanceof Set ? parked : new Set(parked ?? []);
  const maxPriority = select.maxPriority ?? Number.POSITIVE_INFINITY;
  const excludeTypes = select.excludeTypes ?? [];
  const prefixes = select.excludeIdPrefixes ?? [];

  for (const bead of beads) {
    if (!bead || typeof bead.id !== 'string') continue;
    if (typeof bead.priority === 'number' && bead.priority > maxPriority) continue;
    // Belt and braces behind `bd ready --exclude-type`: `issue_type` IS present
    // in the response, so unlike the label case this filter is real, not inert.
    if (excludeTypes.includes(bead.issue_type)) continue;
    if (prefixes.some((prefix) => prefix && bead.id.startsWith(prefix))) continue;
    if (parkedSet.has(bead.id)) continue;

    const text = `${bead.title ?? ''}\n${bead.description ?? ''}`;
    if (denyStems.some((stem) => text.includes(stem))) continue;

    return bead;
  }
  return null;
}
