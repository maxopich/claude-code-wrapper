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

export function claimArgv(id) {
  // --claim is atomic: assignee + status=in_progress, idempotent if already
  // ours. Two writes would leave a window where the bead is assigned but open.
  return ['update', id, '--claim'];
}

export function parkArgv(id, evidence) {
  return [
    'update',
    id,
    '--status',
    'open',
    '--add-label',
    'loop-stuck',
    '--append-notes',
    evidence,
  ];
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
    async claim(id) {
      const result = await write(claimArgv(id));
      return result.code === 0;
    },
    async park(id, evidence) {
      const result = await write(parkArgv(id, evidence));
      return result.code === 0;
    },
    async close(id, reason) {
      const result = await write(closeArgv(id, reason));
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
