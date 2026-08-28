/**
 * Autonomous loop — the `bd` calls.
 *
 * Argv builders are exported separately from the executors so the flag names
 * can be pinned by unit tests without a seam. That split matters more here
 * than anywhere else in the loop, because three of these flags are NOT what
 * the spec originally wrote, and every one of them fails differently:
 *
 *   update --add-label   `--label` is a FILTER flag on ready/list; `update`
 *                        rejects it outright. `--set-labels` is accepted and
 *                        would REPLACE every existing label on the bead.
 *   create --labels      plural on create, singular nowhere.
 *   create --deps        'discovered-from:<id>' creates the follow-up AND
 *                        wires the edge in one call. The spec had create then
 *                        `dep add`, and called a failure between them a hard
 *                        park of the whole run; one call removes the window.
 *
 * R8: `bd` is resolved to an absolute path once at startup. Under launchd or
 * cron, /opt/homebrew/bin is not on PATH, and the failure would otherwise be a
 * mid-run `command not found` rather than a preflight error.
 */

/** §6.1 — see select.mjs for why the exclusions MUST be flags, not a filter. */
export { readyArgv } from './select.mjs';

/**
 * ONE bead by id. `--bead` must never guess.
 *
 * It used to look the id up in the READY LIST and fall back to a stub with an
 * empty description when it missed. Measured: 210 beads are ready and that
 * lookup asked for 200, so ten of them silently produced a prompt reading
 * `**Cebab-ouy — Cebab-ouy**` with no body at all — the agent worked from the
 * id and nothing else, and burned a full turn budget doing it. A bead that is
 * blocked, in progress or closed missed for the same reason and degraded the
 * same silent way.
 */
export function showArgv(id) {
  return ['show', id, '--json'];
}

/**
 * EVERY bead bd knows about, for the containment graph.
 *
 * TWO FLAGS, AND BOTH ARE LOAD-BEARING IN THE SAME WAY — each one's absence
 * silently SHRINKS the parent map, and a containment rule built on a partial
 * map is correct only for whichever beads happened to be in it.
 *
 * `-n 0` is bd's no-limit. The default page truncates, and it does so to
 * STDERR (`Showing 200 of 207 ready issues`) while leaving stdout valid JSON,
 * so nothing throws and the caller cannot tell. That is not hypothetical here:
 * the same trap was live in this very change, on the reconcile pass's ready
 * set, until it was measured.
 *
 * `--all` is what makes this ONE call. Measured 2026-08-28, bd 1.1.2:
 * `bd list --json -n 0` with no status filter returns 249 rows — 243 open plus
 * 6 in_progress — and NOT ONE closed bead, so the unfiltered form is really
 * "every active bead" under a name that suggests otherwise. `--all` returns all
 * 608 (240 open, 6 in_progress, 362 closed) with all 457 parent edges, in
 * 0.37s. The closed rows carry 311 of those edges and are the only way a chain
 * passing THROUGH a closed bead is visible at all.
 *
 * It also covers the statuses an explicit list would forget. bd's vocabulary is
 * open, in_progress, blocked, deferred and closed; asking for two of them by
 * name leaves a `blocked` or `deferred` intermediate out of the map with
 * exactly the same effect as a missing closed one. `--all` cannot develop that
 * gap, which is why it is preferred over naming statuses even though this repo
 * currently has none of either.
 */
export function listArgv() {
  return ['list', '--json', '-n', '0', '--all'];
}

export function claimArgv(id) {
  // --claim is atomic: assignee + status=in_progress, idempotent if already
  // ours. Two writes would leave a window where the bead is assigned but open.
  return ['update', id, '--claim'];
}

/**
 * The two labels a park can leave, and why there are two.
 *
 * Both exclude the bead from every future SELECT (`select.excludeLabels`), and
 * that exclusion is right in both cases — nothing should burn a second budget
 * on a bead the loop already judged or already failed at. What differs is what
 * a human reading the label learns.
 *
 * `loop-stuck` means A HUMAN MUST DEBUG THIS: the build crashed, the gate would
 * not go green, CI stayed red, the merge was refused.
 *
 * `loop-declined` means THE LOOP READ IT AND SAID NO: the agent looked at the
 * brief and judged the bead unsuitable for an unattended run. Nothing is broken
 * — the loop working exactly as `Cebab-qd2.16` intended — and an operator
 * scanning for what to fix should not have to open the bead to discover that.
 * `Cebab-qd2.20` split the COUNTERS for this reason and stopped short of the
 * labels; this is the other half. `Cebab-qd2.36`.
 */
export const PARK_LABEL = 'loop-stuck';
export const DECLINE_LABEL = 'loop-declined';

export function parkArgv(id, evidence, label = PARK_LABEL) {
  return ['update', id, '--status', 'open', '--add-label', label, '--append-notes', evidence];
}

/**
 * A note on a bead that is neither closed nor parked.
 *
 * The two terminal states that leave the bead OPEN and CLAIMED — a PR awaiting
 * a human merge, and a merge sitting in a queue — previously wrote nothing to
 * the bead at all. `commitSubject` puts the id in the PR title and the branch
 * is `loop/<id>`, so the link exists, but only from the PR inward: `bd show
 * <id>` said nothing, and after an `--until 8` run that is eight claimed beads
 * to correlate by hand.
 *
 * Deliberately NOT `--add-label loop-stuck`: that label excludes a bead from
 * every future selection, which is right for something a human must debug and
 * wrong for something a human must merely merge.
 */
export function noteArgv(id, text) {
  return ['update', id, '--append-notes', text];
}

/**
 * Hand a claimed bead back, un-run.
 *
 * A HALT — `loop:stop`, a signal, a usage limit — routes straight to DONE and
 * never enters HARVEST, so the bead the loop was holding kept `in_progress`
 * with the loop as assignee. `bd ready` excludes in_progress, so that bead was
 * not merely skipped next run: it left the queue permanently, with nothing on
 * it saying why, while the same teardown deleted the branch its work was on.
 * Measured 2026-08-26 on Cebab-vie.30.
 *
 * Deliberately NOT `parkArgv`. `loop-stuck` means "a human must debug this",
 * and an interrupted bead has not failed at anything — it was mid-flight when
 * the operator stopped the run. It goes back exactly as it came, plus a note
 * saying what happened to it.
 */
export function releaseArgv(id, evidence) {
  return ['update', id, '--status', 'open', '--append-notes', evidence];
}

export function closeArgv(id, reason) {
  return ['close', id, '-r', reason];
}

/**
 * One call: create the follow-up and attach its `discovered-from` edge.
 * `--silent` makes stdout the bare issue id, which is what the caller records.
 */
export function followUpArgv(followUp, sourceId, harvest) {
  const body = [
    followUp.why,
    '',
    `Evidence: ${followUp.evidence}`,
    '',
    `Found by the autonomous loop while working ${sourceId}.`,
  ].join('\n');
  return [
    'create',
    '--title',
    followUp.title,
    '--type',
    followUp.type,
    '-p',
    String(harvest.followUpPriority),
    '-l',
    harvest.followUpLabel,
    '--deps',
    `discovered-from:${sourceId}`,
    '-d',
    body,
    '--silent',
  ];
}

/** Fallback for the one-call form above, if a bd build rejects `--deps`. */
export function depAddArgv(newId, sourceId) {
  return ['dep', 'add', newId, sourceId, '-t', 'discovered-from'];
}

const parseJson = (stdout, what) => {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`bd ${what}: could not parse JSON output`);
  }
};

export function makeBeads({ run, bd, cwd, dryRun = false }) {
  const call = (args, opts = {}) => run(bd, args, { cwd, timeoutMs: 30000, ...opts });
  /** Writes are skipped under --dry-run, which must make NO bd writes at all. */
  const write = async (args) => (dryRun ? { code: 0, stdout: '', stderr: '' } : call(args));

  return {
    async ready(select, limit) {
      const { readyArgv } = await import('./select.mjs');
      const result = await call(readyArgv(select, { limit }));
      if (result.code !== 0) throw new Error(`bd ready failed: ${result.stderr.trim()}`);
      const rows = parseJson(result.stdout, 'ready');
      return Array.isArray(rows) ? rows : [];
    },
    /**
     * THE EXIT CODE IS NOT THE SIGNAL. `bd show` on a missing id exits **0**
     * and prints `{"error": "no issues found matching the provided IDs"}` — an
     * object where a hit is an array — so the SHAPE is what decides. Checking
     * `result.code !== 0` here would have returned that error object as if it
     * were a bead.
     */
    async show(id) {
      const result = await call(showArgv(id));
      let rows;
      try {
        rows = parseJson(result.stdout, 'show');
      } catch {
        return null;
      }
      const row = Array.isArray(rows) ? rows[0] : null;
      return row?.id ? row : null;
    },
    /**
     * Rows for the containment graph. Returns `[]` on any failure rather than
     * throwing, and the choice is deliberate in the SAFE direction: an empty
     * list makes `ancestorsOfActive` return an empty set, which loses the new
     * rule and falls back on the batch rule that shipped before it. The
     * alternative — throwing — would turn a transient bd hiccup into a crashed
     * iteration. The caller logs the count so a persistent zero is visible
     * rather than silently narrowing SELECT.
     */
    async list() {
      const result = await call(listArgv());
      if (result.code !== 0) return [];
      let rows;
      try {
        rows = parseJson(result.stdout, 'list');
      } catch {
        return [];
      }
      return Array.isArray(rows) ? rows : [];
    },
    async claim(id) {
      const result = await write(claimArgv(id));
      return result.code === 0;
    },
    /**
     * THE PARK IS THE CROSS-RUN MEMORY, so a failed one is not cosmetic.
     * `loop-stuck` is what makes SELECT skip this bead on the NEXT run; without
     * it the same failing bead is picked again tomorrow night, fails again, and
     * parks again. The result used to be returned to a caller that dropped it,
     * so the whole mechanism could be dead and nothing would say so.
     *
     * Retried once — the common cause is a transient `bd` lock — and the
     * outcome is returned for the ledger either way.
     */
    async park(id, evidence, label = PARK_LABEL) {
      let result = await write(parkArgv(id, evidence, label));
      if (result.code !== 0) result = await write(parkArgv(id, evidence, label));
      return result.code === 0;
    },
    async close(id, reason) {
      const result = await write(closeArgv(id, reason));
      return result.code === 0;
    },
    /**
     * Retried once, for the same reason `park` is: this runs on the way out of
     * a halted run, and a bead silently left claimed is the whole defect.
     */
    async release(id, evidence) {
      let result = await write(releaseArgv(id, evidence));
      if (result.code !== 0) result = await write(releaseArgv(id, evidence));
      return result.code === 0;
    },
    async note(id, text) {
      const result = await write(noteArgv(id, text));
      return result.code === 0;
    },
    /**
     * Returns the new bead id, or null. A follow-up that cannot be filed is a
     * hard park of the whole run — losing a finding is the failure mode this
     * loop exists to fix — so the caller checks for null and stops.
     */
    async fileFollowUp(followUp, sourceId, harvest) {
      if (dryRun) return 'dry-run';
      let result = await call(followUpArgv(followUp, sourceId, harvest));
      if (result.code === 0) return result.stdout.trim().split('\n').pop().trim() || null;
      // Retried once, then the two-step fallback in case `--deps` is rejected.
      result = await call(followUpArgv(followUp, sourceId, harvest));
      if (result.code !== 0) return null;
      const id = result.stdout.trim().split('\n').pop().trim();
      if (!id) return null;
      await call(depAddArgv(id, sourceId));
      return id;
    },
  };
}
