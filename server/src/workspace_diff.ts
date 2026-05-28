import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkspaceDiff } from '@cebab/shared/protocol';

const execFileAsync = promisify(execFile);

// Cluster D Phase 5b (spec §6.3): workspace-diff calculation for the
// `reopen_session` probe. Runs `git status --porcelain` over a project
// path and projects the output to the wire shape consumed by the
// ReopenSessionModal (Phase 5c).
//
// The "diff" here is a loose proxy — git can only tell us "what's
// different from HEAD" at the moment we ask, not "what's different
// since the swept session ran". Cebab doesn't snapshot the workspace
// at session start (a real `git stash` would be invasive + lossy), so
// this is the best signal we have. The modal copy frames it as "your
// workspace has uncommitted changes" rather than promising any specific
// since-when comparison.
//
// Non-git paths and missing-git installations both downgrade to
// `fullDiffAvailable: false` with zeroed counts; the modal interprets
// that as "we couldn't enumerate — require typed confirmation anyway"
// (spec preference: safe-by-default over a silently-skipped gate).

/** Number of `sampleChanges` paths surfaced on the wire. Spec §6.3 cap. */
export const SAMPLE_CHANGES_CAP = 10;

/** Tight timeout — git status should be milliseconds; a hang is a problem. */
const GIT_TIMEOUT_MS = 5_000;

const EMPTY_DIFF: WorkspaceDiff = {
  filesChanged: 0,
  filesAdded: 0,
  filesDeleted: 0,
  sampleChanges: [],
  fullDiffAvailable: false,
};

/**
 * Compute a workspace diff for `projectPath`. Always resolves — errors
 * (missing path, non-git, missing git binary, timeout) collapse to
 * `EMPTY_DIFF` with `fullDiffAvailable: false`. Callers (the
 * `reopen_session` handler) treat `!fullDiffAvailable` as "we don't
 * know, be cautious" rather than "everything is clean".
 *
 * Uses `-z` (NUL-terminated, byte-exact) so paths with newlines or
 * unicode don't corrupt the parse. `--no-renames` keeps the parser
 * straightforward — a rename would otherwise appear as `R` with two
 * paths split by NUL inside the entry, and we'd have to track a state
 * machine. Renames count as 1 change instead.
 */
export async function computeWorkspaceDiff(projectPath: string): Promise<WorkspaceDiff> {
  let stdout: string;
  try {
    const res = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'],
      {
        cwd: projectPath,
        // 1 MiB output cap — porcelain entries are small (~100B each) so
        // this fits ~10k files. Beyond that, truncation is acceptable —
        // the modal's job is just to surface "lots of changes".
        maxBuffer: 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
        // The user's environment might have GIT_DIR / GIT_WORK_TREE
        // pointing somewhere else (a parent shell that cd'd into another
        // repo and forgot to unset). Strip both so the cwd alone
        // determines which repo git is reading.
        env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      },
    );
    stdout = res.stdout;
  } catch (err) {
    // Distinguishing "git missing" from "not a repo" from "permission
    // denied" is operator-visible noise — the modal only acts on
    // fullDiffAvailable. Log loudly so the operator can investigate
    // via dev-server output if needed.
    console.error(`[workspace_diff] git status failed for ${projectPath}`, err);
    return EMPTY_DIFF;
  }

  return parseGitPorcelain(stdout);
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all` output.
 * Each entry is two characters of status + space + path + NUL.
 *
 * Status interpretation (porcelain v1):
 *   - `??` — untracked (we count as "added")
 *   - `A `, ` A`, `AA`, `AM`, etc. — added (index OR worktree)
 *   - `D `, ` D`, `DD`, etc. — deleted
 *   - everything else (`M`, `R`, `C`, `U`, etc.) — modified
 *
 * `filesChanged` is the TOTAL count (added + deleted + modified);
 * `filesAdded` and `filesDeleted` are sub-counts. This matches the
 * spec §6.3 wire shape — UI renders all three separately.
 */
export function parseGitPorcelain(stdout: string): WorkspaceDiff {
  if (stdout.length === 0) {
    // Clean working tree: no NULs, no entries, fullDiffAvailable=true
    // (we DID successfully consult git; the answer is "nothing").
    return {
      filesChanged: 0,
      filesAdded: 0,
      filesDeleted: 0,
      sampleChanges: [],
      fullDiffAvailable: true,
    };
  }

  let filesChanged = 0;
  let filesAdded = 0;
  let filesDeleted = 0;
  const sampleChanges: string[] = [];

  // The -z output ends with a trailing NUL after the last entry, which
  // produces an empty final piece — filter it.
  for (const entry of stdout.split('\0')) {
    if (entry.length === 0) continue;
    if (entry.length < 3) continue; // malformed; skip rather than throw

    const xy = entry.slice(0, 2);
    const filePath = entry.slice(3);

    filesChanged += 1;

    // Untracked or any A in either column → added.
    if (xy === '??' || xy[0] === 'A' || xy[1] === 'A') {
      filesAdded += 1;
    } else if (xy[0] === 'D' || xy[1] === 'D') {
      filesDeleted += 1;
    }
    // else: modified/renamed/copied/etc. — counted in filesChanged only

    if (sampleChanges.length < SAMPLE_CHANGES_CAP) {
      sampleChanges.push(filePath);
    }
  }

  return {
    filesChanged,
    filesAdded,
    filesDeleted,
    sampleChanges,
    fullDiffAvailable: true,
  };
}
