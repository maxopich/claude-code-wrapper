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
 * ────────────────────────────────────────────────────────────────────────────
 * AND WHY THERE IS NO `skipPhrases` HERE EITHER. MEASURED, 2026-08-26, after
 * three real runs cost $15 and one of them ($9.06) was a bead the loop could
 * never have finished.
 *
 * The idea was to scan a bead's body for the phrases that mark a DECISION —
 * `chooseBead` already has a text-scan seam for deny paths, so it was nearly
 * free. Run backwards over all 242 open beads it does not survive contact:
 *
 *   'not fixed here'          4 hits — incl. Cebab-vie.30, an ordinary bug
 *   'was not fixed'           2 hits — incl. Cebab-7r8, which the loop
 *                                      COMPLETED in 20 turns
 *   'unverified'              5 hits — incl. three ordinary bus bugs
 *   'not measured'            4 hits — incl. the follow-up the loop had just
 *                                      filed itself
 *
 * `Cebab-7r8`'s body carries "## Why it was not fixed in PR #402", which is
 * this repo's standard heading for "I found this while doing something else".
 * That is true of nearly every well-filed bead and says NOTHING about whether
 * the work is suitable. The phrases mark why a bead exists, not what it costs.
 *
 * A size heuristic fails too, in the other direction: the bead that succeeded
 * has a LONGER description (2.2k chars) than the one that capped (1.5k).
 *
 * So there is no automatic signal, and the honest mechanism is the explicit
 * one that already exists: `needs-human` is in `select.excludeLabels` and
 * reaches `bd ready --exclude-label`, which is measured to work. It is
 * currently on zero beads — the exclusion is live and simply unused. The
 * second line of defence is the agent itself, which is the only reader that
 * can tell a decision from a defect: `build-prompt.md` asks it to return
 * `needs_human` before starting, which costs a few turns instead of sixty.
 * ────────────────────────────────────────────────────────────────────────────
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
  const excludeParents = select.excludeParents ?? [];

  for (const bead of beads) {
    if (!bead || typeof bead.id !== 'string') continue;
    if (typeof bead.priority === 'number' && bead.priority > maxPriority) continue;
    // Belt and braces behind `bd ready --exclude-type`: `issue_type` IS present
    // in the response, so unlike the label case this filter is real, not inert.
    if (excludeTypes.includes(bead.issue_type)) continue;
    if (prefixes.some((prefix) => prefix && bead.id.startsWith(prefix))) continue;
    if (parkedSet.has(bead.id)) continue;

    // THE TEXT SCAN BELOW ONLY CATCHES BEADS THAT SPELL A PATH OUT, and a bead
    // about the loop usually does not. Measured live 2026-08-27: `Cebab-qd2.17`
    // was correctly skipped because its body writes `scripts/loop.mjs:824`,
    // while `Cebab-qd2.22` — entirely about the driver — was SELECTED and began
    // a full BUILD, because it names the same files by BASENAME. The guard at
    // PUBLISH would have caught the diff, but only after a whole turn budget.
    //
    // Parentage is the precise signal and it is FREE: `parent` is present on
    // every `bd ready --json` row (measured — unlike `labels`, which is not,
    // hence the header's rule that label exclusion is pushed down to bd). A
    // bead filed under the loop's own epic is about the loop, whatever words it
    // happens to use.
    //
    // Not a replacement for the text scan: that one catches `.github/**` and a
    // bead about the driver filed under some other epic. Both, cheaply.
    if (excludeParents.includes(bead.parent)) continue;

    const text = `${bead.title ?? ''}\n${bead.description ?? ''}`;
    if (denyStems.some((stem) => text.includes(stem))) continue;

    return bead;
  }
  return null;
}
