/**
 * Autonomous loop — choosing the next bead.
 *
 * PURE. Builds the `bd ready` argv, and filters the rows bd returns.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY LABEL FILTERING IS NOT DONE HERE, AND MUST NOT BE MOVED HERE.
 *
 * MEASURED, 2026-08-25: NO bd JSON output carried a `labels` field, so a
 * client-side `bead.labels.includes(...)` read `undefined`, treated it as "this
 * bead has no labels", and excluded NOTHING. It would have run on every bead,
 * reported success, and measured nothing — and the thing it silently stops
 * measuring is the loop's own memory: HARVEST labels a parked bead
 * `loop-stuck` precisely so SELECT skips it next run. Inert, the loop re-picks
 * last night's stuck bead every single night.
 *
 * RE-MEASURED 2026-08-28 on bd 1.1.2, AND THE FIELD IS THERE NOW: 99 of 240
 * `bd ready --json` rows carry a populated `labels` array, `loop-stuck` among
 * them. So the sentence above is history, not a live constraint — but the
 * DECISION it justified is unchanged and must not be revisited on the strength
 * of the field reappearing. Server-side exclusion is still correct because it
 * is bd that decides what a label means, and a client-side re-implementation
 * would be a second definition free to drift from the first. What the field's
 * return DOES buy is a cheap assertion: a test can now confirm the rows bd
 * hands back really are label-free, instead of taking the flag on trust.
 *
 * The reason this paragraph exists at all is that the stale version read as a
 * measured fact about bd rather than a dated one, and the next author to check
 * would have found `labels` present and concluded the rule was wrong.
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
export function chooseBead(beads = [], { select = {}, denyStems = [], parked, contains } = {}) {
  const parkedSet = parked instanceof Set ? parked : new Set(parked ?? []);
  // UNION, NEVER REPLACEMENT. The batch rule below is computed unconditionally
  // and the injected set is added to it, so a caller that passes nothing gets
  // exactly the previous behaviour and a caller that passes a graph-derived set
  // cannot silently LOSE the batch rule by forgetting to fold it in. The two
  // catch different things — see `ancestorsOfActive`.
  const containers = containerIds(beads);
  for (const id of contains ?? []) containers.add(id);
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

    // A ROLLUP IS NOT WORK, AND `issue_type` DOES NOT SAY SO.
    //
    // Measured 2026-08-27 against the live queue with this very function: the
    // loop's next three picks were `Cebab-8x8.1`, `.2` and `.3` — each a
    // feature-TYPED parent of three task beads that are themselves ready, and
    // `Cebab-8x8.1.1` was pick number four. So iteration 1 would implement a
    // whole feature slice and iteration 4 would implement a SUBSET of it, in a
    // second PR, diffing against a main that already contained the first.
    //
    // `excludeTypes` cannot reach these: they are typed `feature`, not `epic`.
    // Across all 232 ready rows, 20 are the parent of another ready row and 16
    // of those are literal epics already excluded — the exclusion existed and
    // simply had no way to see the other four.
    //
    // Skipping costs nothing: the child is the more specific work and is picked
    // instead, and the parent becomes selectable again the moment its children
    // close. `Cebab-qd2.40`.
    if (containers.has(bead.id)) continue;

    const text = `${bead.title ?? ''}\n${bead.description ?? ''}`;
    if (denyStems.some((stem) => text.includes(stem))) continue;

    return bead;
  }
  return null;
}

/**
 * Which rows in THIS batch contain another row in it.
 *
 * `parent` is present on every `bd ready --json` row — measured, and already
 * relied on by `excludeParents` — unlike `labels`, which is not, and which is
 * why the header forbids client-side label filtering. So this reads a real
 * field rather than an undefined one, and cannot silently match nothing.
 *
 * SCOPED TO THE BATCH, AND THAT LIMIT IS THE DESIGN RATHER THAN AN OVERSIGHT.
 * The driver asks bd for 50 rows, so a container whose children are BLOCKED —
 * or simply sorted past the cap — is not caught here. That is the narrower half
 * of the problem on purpose: the harm this exists to prevent is the loop doing
 * a parent AND its child, which requires both to be selectable, and both being
 * selectable means both are in the batch. A rollup whose children are all
 * blocked is merely large, and the mechanism for that already exists —
 * `select.excludeLabels` carries `epic`, so labelling it is one command.
 * Measured example on 2026-08-27: `Cebab-8x8.4`, whose three children are
 * blocked and which this therefore does not catch.
 */
export function containerIds(beads = []) {
  const ids = new Set();
  for (const bead of beads) {
    const parent = bead?.parent;
    if (typeof parent === 'string' && parent.length > 0) ids.add(parent);
  }
  return ids;
}

/**
 * A bead is ACTIVE while it still represents work nobody has finished. bd's own
 * two non-terminal statuses, named here rather than inlined because both the
 * containment walk and its test have to agree on the set.
 */
export const ACTIVE_STATUSES = Object.freeze(new Set(['open', 'in_progress']));

/**
 * Every ancestor of every ACTIVE bead — containment computed from the bead
 * GRAPH rather than from the ready batch.
 *
 * WHY THE BATCH RULE ABOVE IS NOT ENOUGH, measured on the run of 2026-08-27.
 * `containerIds` derives containment from the `parent` pointers of the rows IN
 * THE READY BATCH, so it is correct only while every child is either open or
 * closed — and a guard-withheld bead is neither. HARVEST deliberately leaves it
 * `in_progress` (a human merging its PR is the remaining work), which takes it
 * out of `bd ready`; with no child in the batch its parent has no pointer aimed
 * at it and reads as a leaf.
 *
 * That is not hypothetical. Iteration 5 built `Cebab-8x8.2.1`, the guard
 * withheld the merge, and PR #422 was left open with the bead in_progress.
 * Iteration 6 then selected `Cebab-8x8.2` — its DIRECT PARENT — and built it
 * from a main that did not contain #422. Both PRs create
 * `assistant/kb/00-index.md`; the second to merge conflicted and a human
 * resolved it by hand. The rule itself is sound, and the same run proves it:
 * `Cebab-8x8.1` was selected after all three of its children had merged and
 * closed, and correctly returned `no_change_needed`.
 *
 * TRANSITIVE, BECAUSE THE CHAINS ARE. `Cebab-8x8.2.1` -> `Cebab-8x8.2` ->
 * `Cebab-8x8` is two levels, so blocking only the direct parent would leave the
 * grandparent selectable while its grandchild is mid-flight — the same defect
 * one level up.
 *
 * PASS EVERY BEAD bd KNOWS ABOUT, INCLUDING THE CLOSED ONES. `status` is read
 * here rather than by the caller, so a half-filtered list cannot silently
 * narrow the rule — but the parent MAP still needs the closed rows, because a
 * chain may pass THROUGH a closed bead: if `8x8.2` is closed while its child
 * `8x8.2.2` is open, `8x8` still contains unfinished work and the walk can only
 * find that out by reading the closed row's own `parent`. Measured 2026-08-28
 * across all 608 beads: 457 parent edges, of which 311 are on closed rows, and
 * zero active chains currently pass through one. Zero occurrences is the reason
 * to include them cheaply now rather than the reason to leave them out — the
 * omission would be invisible until the day it fired.
 *
 * Pass every bead bd knows about — `listArgv` uses `--all` for exactly this,
 * and its header records why the unfiltered form is not enough.
 *
 * WHAT THIS DELIBERATELY DOES NOT FIX, recorded because it is the same hazard
 * one level out and the fix above makes it easy to think it is covered. Every
 * iteration branches from `origin/main`, and `loop.merge` is false by default,
 * so a withheld PR's files are invisible to every LATER iteration of the same
 * run — related or not. #422 and #423 collided on `assistant/kb/00-index.md`
 * and happened to be parent and child, which is the only reason ancestry could
 * catch them; two unrelated beads under different epics collide identically and
 * share no ancestor.
 *
 * It is not fixed HERE because the SELECT-side version cannot work: it needs to
 * know which files a bead will touch before building it, and this file's own
 * header records the measurement that kills that — beads name their files by
 * BASENAME as often as by path. The workable shape is a post-PUBLISH REPORT
 * intersecting `changedPaths` with the files of open `loop/*` PRs, which is
 * certain where a pre-build guess is not. `Cebab-qd2.44`.
 */
export function ancestorsOfActive(rows = []) {
  const parentOf = new Map();
  for (const row of rows) {
    if (typeof row?.id !== 'string') continue;
    if (typeof row.parent === 'string' && row.parent.length > 0) parentOf.set(row.id, row.parent);
  }
  const blocked = new Set();
  for (const row of rows) {
    if (typeof row?.id !== 'string') continue;
    if (!ACTIVE_STATUSES.has(row.status)) continue;
    let cursor = row.id;
    // A cycle in the parent pointers would otherwise spin forever. bd should
    // not produce one; `seen` costs nothing and the alternative is a hung run.
    const seen = new Set([cursor]);
    for (;;) {
      const parent = parentOf.get(cursor);
      if (!parent || seen.has(parent)) break;
      blocked.add(parent);
      seen.add(parent);
      cursor = parent;
    }
  }
  return blocked;
}
