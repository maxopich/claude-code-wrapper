/**
 * Autonomous loop — RECONCILE. What happened to the run before this one.
 *
 * Every other stage acts on a bead the loop is holding right now. This one acts
 * on the beads a PREVIOUS run left behind, and it exists because two of them
 * are left deliberately and nothing ever looks at them again.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE WITHHELD HALF (`Cebab-qd2.42`), which is the destructive one.
 *
 * `loop.merge` is false by default, so `guard_withheld` is how an ORDINARY
 * SUCCESSFUL iteration ends: PR opened, CI green, merge left to a human.
 * HARVEST correctly does not close the bead — a human merging it is the
 * remaining work — and leaves it `in_progress` with a note naming the PR.
 *
 * Then nothing runs again. The operator merges the PR and the bead stays
 * `in_progress` forever: not in `bd ready`, so the loop never re-selects it and
 * never notices; not closed, so its epic never completes. The work is on main
 * and invisible to every subsequent SELECT.
 *
 * Measured on the run of 2026-08-27: 3 of 8 iterations were withheld
 * (`Cebab-8x8.2.1`/#422, `Cebab-8x8.2`/#423, `Cebab-8x8.3.2`/#425), all three
 * merged, all three still `in_progress` the next morning, all three closed BY
 * HAND. At that rate an unattended week strands most of what it ships.
 *
 * `Cebab-qd2.40` — open for days with its work shipped in #418 — looks like a
 * fourth and is really this design's LIMIT, which is worth more than a fourth
 * data point. It has no ledger row at all (`grep -c qd2.40 runs.jsonl` -> 0) and
 * #418 came from a hand-authored branch, not a `loop/<id>` one, so it was
 * stranded OUTSIDE the loop entirely. Nothing here can see it, by construction:
 * this pass reconciles what the DRIVER recorded, and a bead a human left claimed
 * was never the driver's to record. Stated so the next person measuring
 * reconcile's hit rate does not size it at 4 of 8 and go looking for a bug.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE PARKED HALF (`Cebab-qd2.41`), which only ever REPORTS.
 *
 * The ledger knows a bead parked; the queue decides what runs next; no code
 * reads both. A park whose `loop-stuck` label fails to write is therefore
 * silent until the same bead is selected, built and failed again — a whole turn
 * budget to rediscover something already recorded.
 *
 * The mechanism is not broken today (`beads.park` retries and
 * `harvest.parkFailed` records a failure at the time), and this deliberately
 * does NOT filter: the loop's cross-run memory stays the LABEL, one mechanism
 * rather than two. A second, independent exclusion path would be a second
 * definition of "skip this bead", free to drift from the first and to disagree
 * with it in the direction that silently drains the queue. So this prints, and
 * the operator decides.
 *
 * Live positive control at the time of writing: `Cebab-vie.28` and
 * `Cebab-vie.29` both have a parked ledger row and are both still returned by
 * the loop's own `readyArgv`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE LEDGER IS THE SOURCE, AND NOT THE BEAD'S OWN NOTE.
 *
 * `Cebab-qd2.42` proposed scanning `in_progress` beads for the note HARVEST
 * writes and parsing the PR number out of it. That works and it is the wrong
 * input: it is prose, written for a human, matched by a regex that would also
 * match a bead whose DESCRIPTION quotes a PR url, or a note a person edited, or
 * the same sentence reworded by a later change to `harvest`.
 *
 * The ledger already carries the fact structurally — `{ bead, disposition:
 * 'guard_withheld', pr: { number } }` — because the driver wrote it. Verified
 * against all 32 rows of `.loop/runs.jsonl`: every `guard_withheld` row has a
 * `pr.number`. Reading the record the loop itself produced removes the parser
 * and everything that can go wrong inside it.
 *
 * The cost of that choice, stated plainly: `.loop/` is gitignored, so the
 * ledger is per-checkout. A withheld bead recorded on one machine is invisible
 * on another. That is the correct trade — the alternative is a parser over
 * human-editable prose whose failure mode is CLOSING THE WRONG BEAD — and the
 * bound is real rather than theoretical, so it is stated here rather than
 * discovered.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THREE INDEPENDENT CONFIRMATIONS BEFORE ANYTHING IS CLOSED, because this is
 * the only part of the loop that writes to a bead nobody is currently holding:
 *
 *   1. the LEDGER says this bead's latest row was withheld, and names a PR;
 *   2. `bd` says the bead is STILL `in_progress` — so a human who already
 *      closed it, reopened it, or handed it to someone else is left alone;
 *   3. the FORGE says the PR is `MERGED` and hands back a merge commit.
 *
 * Any one of the three disagreeing means no write. This is LAND's own
 * discipline — verify, never predict — applied to a bead the loop put down
 * hours ago.
 */

/** The dispositions that leave a bead claimed with a real PR behind it. */
const AWAITING_HUMAN = Object.freeze(['guard_withheld', 'merge_queued']);

/**
 * Latest row per bead. The ledger is append-only and a bead can appear many
 * times — parked on Tuesday, withheld on Wednesday — so only the LAST row
 * describes where it actually stands. Taking any earlier one would resurrect a
 * state the loop has already moved past.
 */
export function latestByBead(rows = []) {
  const latest = new Map();
  for (const row of rows) {
    if (typeof row?.bead === 'string' && row.bead.length > 0) latest.set(row.bead, row);
  }
  return latest;
}

/**
 * Beads whose LATEST ledger row left them claimed behind a real PR.
 *
 * A row with no PR number is skipped rather than guessed at: without one there
 * is nothing to ask the forge about, and a bead this cannot verify is a bead it
 * must not touch.
 */
export function withheldFromLedger(rows = []) {
  const out = [];
  for (const [bead, row] of latestByBead(rows)) {
    if (!AWAITING_HUMAN.includes(row?.disposition)) continue;
    const pr = row?.pr?.number;
    if (typeof pr !== 'number' || !Number.isFinite(pr)) continue;
    out.push({ bead, pr, url: row?.pr?.url ?? null, ts: row?.ts ?? null });
  }
  return out;
}

/** Beads whose LATEST ledger row is a park. */
export function parkedFromLedger(rows = []) {
  const out = [];
  for (const [bead, row] of latestByBead(rows)) {
    if (row?.disposition !== 'parked') continue;
    out.push({ bead, reason: row?.reason ?? null, ts: row?.ts ?? null });
  }
  return out;
}

/**
 * What to do about one withheld bead, decided from the three facts above.
 *
 * PURE, and separated from the calls that gather those facts precisely because
 * this is the function that authorises a write. Every branch is reachable from
 * a plain object in a test, with no bd and no network.
 */
export function decideWithheld({ beadStatus, prState }) {
  // (2) The bead moved on without us. A human closed it, reopened it, or
  // reassigned it — any of which makes the ledger's row stale, and none of
  // which is ours to undo.
  if (beadStatus !== 'in_progress') {
    return { action: 'skip', why: `bead is ${beadStatus ?? 'unknown'}, not in_progress` };
  }
  // (3) The forge is the authority on what happened to the PR.
  if (prState?.state === 'MERGED') {
    // A MERGED PR with no merge commit is a contradiction, not a merge. Refuse
    // rather than close on the state string alone — `land.sha` was null on
    // every ledger row ever written, which is exactly how a loop ends up unable
    // to check any of its own claims against `main`.
    if (typeof prState.sha !== 'string' || prState.sha.length === 0) {
      return { action: 'report', why: 'PR reads MERGED but carries no merge commit' };
    }
    return { action: 'close', why: 'merged', sha: prState.sha };
  }
  // A human REJECTED the work. Loud, because a silently-closed PR means an
  // iteration's whole output was thrown away and the bead is still open.
  if (prState?.state === 'CLOSED') {
    return { action: 'report', why: 'PR was CLOSED without merging — the work was rejected' };
  }
  if (prState?.state === 'OPEN') return { action: 'wait', why: 'PR is still open' };
  // Unknown covers an unparseable read, a network failure, and a state this
  // code has never seen. All three mean the same thing: do not write.
  return { action: 'wait', why: `PR state is ${prState?.state ?? 'unreadable'}` };
}

/**
 * Run both halves. Returns a summary for the ledger and the console; performs
 * at most one bd write per bead, and only through `beads.close`, which is
 * already `--dry-run`-aware.
 *
 * @param {object}   deps.beads    from `makeBeads`
 * @param {object}   deps.forge    from `makeForge`
 * @param {object[]} deps.rows     parsed `.loop/runs.jsonl`
 * @param {Function} deps.readySet resolves to a Set of ids the loop would pick
 */
export async function reconcile({
  beads,
  forge,
  rows = [],
  readySet,
  remoteLoopBeads,
  log = () => {},
  dryRun = false,
}) {
  const summary = { closed: [], reported: [], waiting: [], reselectable: [], staleBranches: [] };

  for (const candidate of withheldFromLedger(rows)) {
    // CONFIRMATION (2) FIRST, AND THE ORDER IS A COST DECISION. `decideWithheld`
    // treats "not in_progress" as decisive, so asking the forge about a bead a
    // human already closed buys nothing and spends a network round trip
    // (`gh pr view` measured at ~0.48s). The ledger is append-only and never
    // pruned, so its withheld rows only accumulate — 4 today, 3 of them added by
    // one night — and every one of them would otherwise be re-queried at every
    // run start, forever, in a phase whose errors are swallowed.
    const bead = await beads.show(candidate.bead);
    if (bead?.status !== 'in_progress') continue;
    const prState = await forge.prState(candidate.pr);
    const decision = decideWithheld({ beadStatus: bead?.status, prState });

    if (decision.action === 'close') {
      // The reason carries the merge commit, so the bead's own history says
      // which commit closed it — the evidence LAND records for a bead it
      // closed itself, kept identical for a bead closed hours later.
      const ok = await beads.close(
        candidate.bead,
        `merged as ${decision.sha} (PR #${candidate.pr}) — closed by the loop's reconcile pass`,
      );
      if (ok) {
        summary.closed.push({ ...candidate, sha: decision.sha, ...(dryRun ? { dryRun } : {}) });
        // A DRY RUN MUST NOT CLAIM AN EFFECT IT DID NOT HAVE. `beads.close`
        // routes through the `write` wrapper, which under `--dry-run` returns
        // `{ code: 0 }` WITHOUT spawning bd — so `ok` is true and this branch
        // runs having closed nothing. An operator validating the new pass would
        // read `bead closed`, believe it, and leave the bead stranded: the exact
        // outcome this module exists to end, with a line of output saying it was
        // handled.
        log(
          dryRun
            ? `reconcile: ${candidate.bead} — PR #${candidate.pr} merged, WOULD close (dry run)`
            : `reconcile: ${candidate.bead} — PR #${candidate.pr} merged, bead closed`,
        );
      } else {
        summary.reported.push({ ...candidate, why: 'bd close failed' });
        log(`reconcile: ${candidate.bead} — PR #${candidate.pr} merged but \`bd close\` FAILED`);
      }
    } else if (decision.action === 'report') {
      summary.reported.push({ ...candidate, why: decision.why });
      log(`reconcile: ${candidate.bead} — ${decision.why} (PR #${candidate.pr})`);
    } else if (decision.action === 'wait') {
      summary.waiting.push({ ...candidate, why: decision.why });
    }
    // `skip` is deliberately silent and deliberately unrecorded: a bead a human
    // already dealt with is not news, and it is the common case on any checkout
    // whose ledger predates the operator's last tidy-up.
  }

  // ── the parked half: read-only, and it never filters ──────────────────────
  const parked = parkedFromLedger(rows);
  if (parked.length > 0 && typeof readySet === 'function') {
    const ready = await readySet();
    for (const row of parked) {
      if (ready.has(row.bead)) summary.reselectable.push(row);
    }
    if (summary.reselectable.length > 0) {
      log(
        `reconcile: ${summary.reselectable.length} bead(s) parked in the ledger are still ` +
          `selectable — ${summary.reselectable.map((r) => `${r.bead} (${r.reason})`).join(', ')}. ` +
          `Their \`loop-stuck\` label did not land; the loop will pick them again.`,
      );
    }

    // THE OTHER SILENT WAY A RE-SELECTED BEAD WASTES A BUDGET, and `Cebab-qd2.41`
    // asks for it by name: a bead whose `loop/<id>` branch is still on the
    // remote. Nothing labels it, so SELECT picks it as normal, and the loop
    // spends a full turn budget on BUILD and the whole gate before `push` fails
    // non-fast-forward at PUBLISH — attempt 1 pushes without `--force`. Measured
    // instance: `Cebab-p5y`, whose PR #403 sat on `loop/Cebab-p5y` while the
    // bead stayed selectable.
    //
    // One `git ls-remote` for the entire set, and a REPORT like its neighbour
    // rather than a filter, for the same reason: a stale branch is a fact about
    // the remote, not a judgement about the bead, and the operator may well want
    // that bead run.
    if (typeof remoteLoopBeads === 'function') {
      const remote = new Set(await remoteLoopBeads());
      summary.staleBranches = [...ready].filter((id) => remote.has(id));
      if (summary.staleBranches.length > 0) {
        log(
          `reconcile: ${summary.staleBranches.length} selectable bead(s) already have a ` +
            `loop/ branch on the remote — ${summary.staleBranches.join(', ')}. A fresh attempt ` +
            `spends its whole budget before failing to push.`,
        );
      }
    }
  }

  return summary;
}
