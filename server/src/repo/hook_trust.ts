import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HookView } from '@cebab/shared/protocol';
import { getDb } from '../db.js';

/**
 * F6: trust-on-first-use ledger for `.claude/settings*.json` hooks
 * (migration 030) — the hook counterpart to `mcp_trust`.
 *
 * Why hooks need their own ledger. An MCP server is a process the model has to
 * decide to call. A hook is a shell command the CLI runs on its own schedule
 * — `SessionStart` fires before the model has done anything, `PreToolUse` /
 * `PostToolUse` fire around every tool call, `Stop` fires at the end. None of
 * them pass through `canUseTool`, so none of them can be approved or denied.
 *
 * That became load-bearing in #260. Bus workers and chain participants run
 * with `settingSources: ['user', 'project', 'local']`, so a participant
 * project's hooks execute on every hop for that participant, and bus agents
 * surface nothing to the operator except `AskUserQuestion`. Before this
 * module, that execution produced no record at all.
 *
 * This module is DETECTION, not prevention. It records what will run and
 * reports what changed; it does not park the spawn. `awaitMcpTrustDecisions`
 * is the shape prevention would take, and it needs an operator prompt of its
 * own — deliberately left as a separate change rather than half-built here,
 * because a gate whose UI does not exist is a gate that hangs forever.
 */

export type HookTrustRow = {
  id: number;
  project_id: number;
  hook_kind: string;
  origin_path: string;
  command: string;
  args_json: string;
  script_sha: string | null;
  first_seen_at: number;
  last_seen_at: number;
};

/**
 * What `observeProjectHooks` noticed about one hook on this spawn.
 *
 *   - `first_seen`     — no row for this (project, kind, origin, command, args).
 *                        Includes a hook whose COMMAND TEXT changed: that is a
 *                        new identity on purpose, because a rewritten command
 *                        is precisely what an operator must re-read.
 *   - `script_changed` — identity matched, but the file the command points at
 *                        now hashes differently. The case identity cannot
 *                        catch: `settings.json` untouched, script rewritten.
 */
export type HookObservation = {
  change: 'first_seen' | 'script_changed';
  hookKind: string;
  originPath: string;
  command: string;
  args: string[];
  scriptSha: string | null;
  /** Only on `script_changed`: the hash this command previously resolved to. */
  previousScriptSha?: string;
};

/**
 * Resolve the script a hook command runs and hash its bytes.
 *
 * Returns null whenever the target cannot be pinned, which is the common case
 * and not an error — the same posture `computeBinarySha` takes for `npx <name>`.
 * A null simply means this hook gets identity tracking but no change detection.
 *
 * Handled forms, in order:
 *   - `$CLAUDE_PROJECT_DIR/...` and `${CLAUDE_PROJECT_DIR}/...`, the form the
 *     Claude Code docs use for project-relative hooks.
 *   - An absolute path.
 *   - A `./`- or `../`-relative path, resolved against the project root.
 *
 * Deliberately NOT handled: bare commands (`jq`, `python3`), pipelines, and
 * anything with shell metacharacters before the first token. Guessing which
 * file a `sh -c '...'` will end up executing is a parser, not a heuristic, and
 * a wrong guess would pin the wrong bytes — worse than pinning none, because
 * it would report "unchanged" while the real script moved.
 */
export function resolveHookScriptSha(command: string, projectPath: string): string | null {
  const target = firstToken(command);
  if (!target) return null;
  // A metacharacter in the first token means we are looking at shell syntax,
  // not a path.
  if (/[|&;<>(){}*?$`]/.test(target.replace(/^\$\{?CLAUDE_PROJECT_DIR\}?/, ''))) return null;

  let candidate = target;
  const projectDirPrefix = /^\$\{?CLAUDE_PROJECT_DIR\}?/;
  if (projectDirPrefix.test(candidate)) {
    candidate = path.join(projectPath, candidate.replace(projectDirPrefix, ''));
  } else if (candidate.startsWith('./') || candidate.startsWith('../')) {
    candidate = path.resolve(projectPath, candidate);
  } else if (!path.isAbsolute(candidate)) {
    // A bare command — PATH lookup decides what runs, and that can differ
    // between spawns. Nothing stable to pin.
    return null;
  }

  // Open once and both stat and read through the SAME descriptor. A
  // `statSync` followed by `readFileSync(path)` is a TOCTOU: the path could be
  // replaced between the two calls, and this function's entire job is to say
  // what a given file contained — hashing bytes from a different inode than
  // the one that was checked is precisely the failure it exists to detect.
  let fd: number | undefined;
  try {
    fd = fs.openSync(candidate, 'r');
    if (!fs.fstatSync(fd).isFile()) return null;
    return createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
  } catch {
    // Missing, unreadable, a directory — unresolvable, same as a bare command.
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed or invalid; nothing useful to do, and leaking the
        // error would turn a successful hash into a failed resolve.
      }
    }
  }
}

/**
 * First whitespace-separated token, honouring a single level of quoting so
 * `"/path with spaces/hook.sh" --flag` resolves. Returns '' when the command
 * is blank.
 */
function firstToken(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return '';
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  const spaceIdx = trimmed.search(/\s/);
  return spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
}

/** Canonical args key. `undefined` and `[]` must collapse to one identity, or
 *  the same hook alternates between two rows and re-reports forever. */
function argsKey(args: readonly string[] | undefined): string {
  return JSON.stringify(args ?? []);
}

export function listHookTrust(projectId: number): HookTrustRow[] {
  return getDb()
    .prepare<[number], HookTrustRow>(
      'SELECT * FROM hook_trust WHERE project_id = ? ORDER BY hook_kind, command',
    )
    .all(projectId);
}

/**
 * Record every hook this project is about to run, and report what changed
 * since the last spawn.
 *
 * Called from the spawn gate, so it runs once per project per spawn — for the
 * single-agent first turn and for every bus participant, including a mid-run
 * `add_multi_agent_participant`.
 *
 * All writes happen in one transaction. A half-applied pass would leave some
 * hooks recorded as seen and others not, so the next spawn would re-report an
 * arbitrary subset — noisy in a way that trains operators to ignore the
 * notification, which is the one outcome that makes this worse than nothing.
 *
 * Returns observations in input order. An empty array means "nothing new",
 * which is the overwhelmingly common case: steady state is silent.
 */
export function observeProjectHooks(
  projectId: number,
  hooks: readonly HookView[],
  projectPath: string,
  now: number = Date.now(),
): HookObservation[] {
  if (hooks.length === 0) return [];
  const db = getDb();

  const tx = db.transaction((): HookObservation[] => {
    const observations: HookObservation[] = [];
    const selectRow = db.prepare<[number, string, string, string, string], HookTrustRow>(
      `SELECT * FROM hook_trust
        WHERE project_id = ? AND hook_kind = ? AND origin_path = ?
          AND command = ? AND args_json = ?`,
    );
    const insertRow = db.prepare(
      `INSERT INTO hook_trust
         (project_id, hook_kind, origin_path, command, args_json, script_sha,
          first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Register D07: COALESCE, so a spawn that could NOT resolve the script
    // (deleted, renamed, permissions) refreshes `last_seen_at` but leaves the
    // recorded hash alone. Writing `script_sha` unconditionally let one
    // unresolvable spawn overwrite a good baseline with NULL — and once the
    // baseline is NULL the `changed` comparison below can never be true
    // again, so a script modified and later restored silently re-baselines
    // and `script_changed` never fires. An unresolvable script is not
    // evidence of tampering (see below); it must not destroy the evidence
    // either.
    const touchRow = db.prepare(
      'UPDATE hook_trust SET last_seen_at = ?, script_sha = COALESCE(?, script_sha) WHERE id = ?',
    );

    for (const hook of hooks) {
      const args = hook.args ?? [];
      const key = argsKey(hook.args);
      const scriptSha = resolveHookScriptSha(hook.command, projectPath);
      const existing = selectRow.get(projectId, hook.hookKind, hook.scopePath, hook.command, key);

      if (!existing) {
        insertRow.run(
          projectId,
          hook.hookKind,
          hook.scopePath,
          hook.command,
          key,
          scriptSha,
          now,
          now,
        );
        observations.push({
          change: 'first_seen',
          hookKind: hook.hookKind,
          originPath: hook.scopePath,
          command: hook.command,
          args,
          scriptSha,
        });
        continue;
      }

      // Only a hash that RESOLVED both times can prove a change. A script that
      // became unresolvable (deleted, renamed, permissions) reports nothing
      // here — it is not evidence of tampering, and the run will fail loudly
      // on its own when the hook cannot execute.
      const changed =
        existing.script_sha !== null && scriptSha !== null && existing.script_sha !== scriptSha;
      touchRow.run(now, scriptSha, existing.id);
      if (changed) {
        observations.push({
          change: 'script_changed',
          hookKind: hook.hookKind,
          originPath: hook.scopePath,
          command: hook.command,
          args,
          scriptSha,
          previousScriptSha: existing.script_sha!,
        });
      }
    }
    return observations;
  });

  return tx();
}
