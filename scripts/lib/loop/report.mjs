/**
 * Autonomous loop — the end-of-run REPORT, and the VERIFIER behind it.
 *
 * Two jobs that belong in one module because one feeds the other:
 *
 *   `verifyRun`   — go and look at the world, and say where it disagrees with
 *                   what the ledger claims.
 *   `renderReport` — turn a run into something a human reads at 08:00.
 *
 * WHY A VERIFIER AT ALL. Every row in `.loop/runs.jsonl` is the loop's own
 * account of its own work, and until now nothing checked it. Measured on the
 * run of 2026-08-30: the ledger recorded `merge_queued` for a PR that was in
 * fact BLOCKED by a required check and could never merge — so the bead sat
 * open with a row that reads "will land shortly", and the only way to find out
 * was for a human to go and look. Which is precisely what this does.
 *
 * THE RULE THAT MAKES IT WORTH ANYTHING: NEVER CHECK THE LEDGER WITH THE
 * LEDGER. Every claim is tested against a source the driver does not write —
 * `git` for what is in main, `gh` for what a PR really is, `bd` for what a bead
 * really says. A verifier fed from the same place as the claim would agree with
 * it by construction, which is this repo's primary defect class wearing a new
 * hat: it would run, report success, and measure nothing.
 *
 * IT REPORTS; IT DOES NOT REPAIR. Nothing here merges, closes, labels or
 * clears. Two reasons, and the second is the important one. First, the safe
 * repairs already exist — `reconcile` runs at the START of the next run and
 * closes a bead only behind three independent confirmations, so a finding here
 * is handed to a mechanism that is already careful rather than duplicated by a
 * second, less careful one. Second, the single most valuable finding on
 * 2026-08-30 was a SECURITY GATE CORRECTLY REFUSING TO LET SOMETHING THROUGH
 * (`Fixture review gate`, pending a CODEOWNER). Anything that "helpfully"
 * resolved that would have done real damage. A verifier that can act is a
 * verifier that can be wrong in the expensive direction.
 *
 * THE ONE ESCALATION. A row claiming a merge whose commit is NOT in `main` is
 * different in kind: every later bead branches from `main`, so if `main` is not
 * what the loop believes, everything after it is built on a false base. That
 * finding writes `.loop/HALT`, which preflight already refuses to start on —
 * an existing mechanism, not a new one, and `npm run loop:recover` already
 * clears it.
 */

/**
 * `blocker` — the next run must not start until a human looks.
 * `attention` — a human has to do something, but the loop is not compromised.
 * `note` — worth printing, nothing owed.
 */
export const SEVERITY_ORDER = Object.freeze({ blocker: 0, attention: 1, note: 2 });

const finding = (severity, bead, title, action) => ({ severity, bead, title, action });

/** Which rows belong to THIS run: everything appended since it began. */
export function rowsSince(rows = [], startedAtIso = null) {
  if (!startedAtIso) return [...rows];
  return rows.filter((r) => typeof r?.ts === 'string' && r.ts >= startedAtIso);
}

/**
 * Counts for the digest. PURE.
 *
 * Grouped by disposition rather than summed into a score: "5 merged, 2 parked"
 * is the sentence an operator needs, and any single number would hide which.
 */
export function summarise(rows = []) {
  const byDisposition = new Map();
  let turns = 0;
  for (const r of rows) {
    const d = r?.disposition ?? 'unknown';
    if (!byDisposition.has(d)) byDisposition.set(d, []);
    byDisposition.get(d).push(r);
    turns += Number(r?.build?.totals?.numTurns ?? r?.build?.numTurns ?? 0) || 0;
  }
  return { total: rows.length, byDisposition, turns };
}

/**
 * Check every claim this run made against the world.
 *
 * Dependencies are injected and each is a DIFFERENT source: `git` answers what
 * is in main, `forge` what a PR is, `beads` what a bead says. `log` is optional
 * and only narrates progress.
 *
 * EVERY LOOKUP IS WRAPPED. A verifier that throws on a network blip converts a
 * successful night into a crash at the last step, which is strictly worse than
 * the silence it replaces. A lookup that cannot answer produces a `note` saying
 * so — never silence, because "I could not check" and "I checked and it was
 * fine" are the two things this module exists to keep apart.
 */
export async function verifyRun({ rows = [], git, forge, beads, log = () => {} }) {
  const findings = [];
  const add = (f) => findings.push(f);

  // `origin/main` has to be current or every ancestry answer below is stale.
  let mainKnown = true;
  try {
    await git.fetchMain();
  } catch {
    mainKnown = false;
    add(
      finding(
        'note',
        null,
        'could not fetch origin/main, so "is it merged?" was not checked',
        'Re-run `npm run loop:status` once the network is back.',
      ),
    );
  }

  for (const row of rows) {
    const bead = row?.bead ?? null;
    const prNumber = row?.pr?.number ?? null;

    // ── a row claiming a merge ───────────────────────────────────────────
    if (row?.disposition === 'merged') {
      const sha = row?.land?.sha ?? null;
      if (!sha) {
        add(
          finding(
            'attention',
            bead,
            'recorded as merged but carries no commit sha, so nothing can be verified',
            'Check the PR by hand; the row cannot be checked against main.',
          ),
        );
      } else if (mainKnown) {
        // `shaInMain` answers true / false / null, and null must NOT read as a
        // negative — see its own header. A throw is the same "could not tell".
        let inMain;
        try {
          inMain = await git.shaInMain(sha);
        } catch {
          inMain = null;
        }
        if (inMain === false) {
          // THE ESCALATION. See the module header.
          add(
            finding(
              'blocker',
              bead,
              `recorded as merged at ${String(sha).slice(0, 7)}, but that commit is NOT in origin/main`,
              'Do not start another run until this is understood — every later bead branches from main.',
            ),
          );
        } else if (inMain === null) {
          add(
            finding(
              'note',
              bead,
              'could not check whether its merge commit is in main',
              'Retry later.',
            ),
          );
        }
      }
      if (row?.harvest?.beadClosed === true && bead) {
        const live = await safeShow(beads, bead);
        if (live && live.status !== 'closed') {
          add(
            finding(
              'attention',
              bead,
              `recorded as closed, but bd still reports status "${live.status}"`,
              "The next run's reconcile pass will close it, behind its own confirmations.",
            ),
          );
        }
      }
    }

    // ── a row that only QUEUED a merge ───────────────────────────────────
    // The 2026-08-30 case. `merge_queued` reads as "will land shortly"; it can
    // also mean "will never land", and only the forge can say which.
    if (row?.disposition === 'merge_queued' && prNumber) {
      const state = await safePrState(forge, prNumber);
      if (state && state.state && state.state !== 'MERGED') {
        const blocking = (row?.ci?.failedChecks ?? []).map((c) => c.name).join(', ');
        add(
          finding(
            'attention',
            bead,
            `queued PR #${prNumber} is still ${state.state}` +
              (blocking ? `, blocked by ${blocking}` : ''),
            'It will not merge on its own. Clear the blocking check or merge it by hand.',
          ),
        );
      }
    }

    // ── a parked row ─────────────────────────────────────────────────────
    // The label is the loop's ONLY cross-run memory. Without it the same
    // failing bead is selected again tomorrow and burns another full budget.
    // `harvest.parkFailed` catches the write failing; this catches a write
    // that succeeded and was later undone.
    if (row?.disposition === 'parked' && bead) {
      const live = await safeShow(beads, bead);
      if (live) {
        const labels = live.labels ?? [];
        if (!labels.includes('loop-stuck') && !labels.includes('loop-declined')) {
          add(
            finding(
              'attention',
              bead,
              'was parked but carries neither loop-stuck nor loop-declined',
              "Tomorrow's run will select it again. Re-apply the label or fix the bead.",
            ),
          );
        }
      }
    }
  }

  // ── sweeps: problems no row would ever mention ─────────────────────────
  const branch = await safeCall(() => git.currentBranch());
  if (branch !== null && branch !== 'main') {
    add(
      finding(
        'attention',
        null,
        `the repository was left on branch "${branch}", not main`,
        'Run `npm run loop:recover`.',
      ),
    );
  }
  const clean = await safeCall(() => git.isClean());
  if (clean === false) {
    add(
      finding('attention', null, 'the working tree was left dirty', 'Run `npm run loop:recover`.'),
    );
  }

  // A pushed loop branch that NOTHING references — neither an open PR nor a row
  // of this run.
  //
  // THE SECOND HALF IS NOT OPTIONAL, and the rehearsal is what proved it. The
  // check first asked only about OPEN pull requests, so every bead that merged
  // successfully — whose PR is then MERGED, not open, and whose branch survives
  // until `--delete-branch` removes it — was reported as an orphan. That fires
  // on the happy path, which is the one place a report must be silent, and a
  // report that cries on every good run is one nobody reads by the third night.
  const listed = await safeCall(() => forge.openLoopPrs());
  const branches = await safeCall(() => git.remoteLoopBeads());
  const beadsThisRun = new Set(
    rows
      .filter((r) => r?.pr?.number)
      .map((r) => r.bead)
      .filter(Boolean),
  );
  if (listed && !listed.error && Array.isArray(branches)) {
    const withPr = new Set((listed.prs ?? []).map((p) => p?.headRefName).filter(Boolean));
    for (const id of branches) {
      if (beadsThisRun.has(id)) continue;
      if (!withPr.has(`loop/${id}`)) {
        add(
          finding(
            'note',
            id,
            'has a pushed loop branch with no open pull request',
            'Either open a PR for it or delete the branch.',
          ),
        );
      }
    }
  }

  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  log(`verify: ${rows.length} row(s) checked, ${findings.length} finding(s)`);
  return { findings, blocked: findings.some((f) => f.severity === 'blocker') };
}

const safeCall = async (fn) => {
  try {
    return await fn();
  } catch {
    return null;
  }
};
const safeShow = (beads, id) => safeCall(() => beads.show(id));
const safePrState = (forge, pr) => safeCall(() => forge.prState(pr));

/** `2h55m`, `12m`, `41s`. */
export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

const LINE = '─'.repeat(72);

/**
 * The digest. PURE — takes data, returns a string, touches nothing.
 *
 * Pure because it is the part most likely to be changed on taste, and a
 * renderer that reached for the filesystem or the clock could not be asserted
 * on character-for-character. Every number it prints is passed in.
 */
export function renderReport({
  rows = [],
  findings = [],
  usageLine = null,
  stopBecause = null,
  elapsedMs = null,
} = {}) {
  const { total, byDisposition } = summarise(rows);
  const out = [];
  const push = (s = '') => out.push(s);

  push(LINE);
  const when = elapsedMs === null ? '' : ` in ${formatElapsed(elapsedMs)}`;
  push(
    ` loop run — ${total} bead${total === 1 ? '' : 's'}${when}` +
      (stopBecause ? `, stopped: ${stopBecause}` : ''),
  );
  push(LINE);

  if (total === 0) {
    push(' nothing ran.');
  } else {
    // Ordered so the good news is first and the things owing action are last.
    const order = [
      'merged',
      'no_change_needed',
      'merge_queued',
      'guard_withheld',
      'parked',
      'halted',
      'dry_run',
    ];
    const seen = new Set();
    for (const d of [...order, ...byDisposition.keys()]) {
      if (seen.has(d) || !byDisposition.has(d)) continue;
      seen.add(d);
      const list = byDisposition.get(d);
      const detail = list
        .map((r) => {
          const id = r.bead ?? '?';
          // The REASON, not just the count: "parked 2" sends the reader to the
          // ledger, "parked 2 (needs_human, ci_infra)" usually does not.
          //
          // Suppressed when it merely repeats the disposition — `merge_queued`
          // carries `reason: 'merge_queued'`, which rendered as
          // `MERGE_QUEUED  Cebab-x (merge_queued)` and said nothing twice.
          const why = r.reason && r.reason !== d ? ` (${r.reason})` : '';
          const pr = r.pr?.number ? ` #${r.pr.number}` : '';
          return `${id}${why}${pr}`;
        })
        .join('  ');
      push(
        `  ${String(d).toUpperCase().padEnd(18)} ${String(list.length).padStart(2)}   ${detail}`,
      );
    }
  }

  if (usageLine) {
    push('');
    push(` cost: ${usageLine}`);
  }

  const actionable = findings.filter((f) => f.severity !== 'note');
  const notes = findings.filter((f) => f.severity === 'note');

  push('');
  if (findings.length === 0) {
    // SAY IT OUT LOUD. A verifier that prints nothing when it finds nothing is
    // indistinguishable from a verifier that did not run.
    push(` verified: ${rows.length} row(s) checked against git, gh and bd — no discrepancies.`);
  } else {
    if (actionable.length > 0) {
      push(` NEEDS YOU (${actionable.length})`);
      actionable.forEach((f, i) => {
        const who = f.bead ? `${f.bead} — ` : '';
        push(`  [${i + 1}] ${f.severity === 'blocker' ? 'BLOCKER: ' : ''}${who}${f.title}`);
        if (f.action) push(`      -> ${f.action}`);
      });
    }
    if (notes.length > 0) {
      if (actionable.length > 0) push('');
      push(` notes (${notes.length})`);
      for (const f of notes) push(`  - ${f.bead ? `${f.bead} — ` : ''}${f.title}`);
    }
  }
  push(LINE);
  return out.join('\n');
}
