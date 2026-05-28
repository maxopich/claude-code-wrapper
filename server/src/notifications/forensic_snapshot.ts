import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ForensicsInput } from '../repo/controllability_forensics.js';

/**
 * Cluster C Phase 3 (spec §4.6 + §5.5): bundle capture for single-agent
 * Stop. Returns a `ForensicsInput`-shaped object minus the `safetyAuditId`
 * (the caller stamps that in once the parent audit row's id is known).
 *
 * Pure-ish: filesystem read for workdir hash, but everything else flows
 * from caller-supplied state (last-N events, pending permissions, captured
 * prompt, active permissions). The fs read is wrapped in try/catch so a
 * filesystem hiccup degrades to `workdirTreeHash: null` + a
 * `snapshotFailedReason` populated, never throws — that path keeps Stop
 * working even if the operator's cwd is on a flaky network mount.
 *
 * Caller (executeInterrupt) supplies:
 *   - the session id (used to filter events + pending perms)
 *   - listEvents (events repo helper, injectable for tests)
 *   - pendingPermissions (read directly from conn; the helper filters)
 *   - capturedPrompt (last held prompt for the session; rate-limit hold case)
 *   - activePermissions (trusted + permissionMode pulled by caller)
 *   - projectCwd (resolved by caller from session→project lookup)
 *
 * Per spec §5.5, bus_inbox_outbox + mutation_rationale are NULL for the
 * single-agent path — those fields only have content in the orchestrator
 * setting. The schema allows NULL so the column stays unset.
 */

const WORKDIR_HASH_ENTRY_CAP = 200;
const WORKDIR_HASH_SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.cebab',
  '.next',
  '.cache',
]);

export type CapturedPromptEntry = { text: string; projectId: number };

export type PendingPermissionSummary = {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
};

export type ActivePermissionsSummary = {
  trusted: boolean;
  permissionMode: string | null;
};

export type SingleAgentEventRow = {
  seq: number;
  ts: number;
  type: string;
  subtype: string | null;
  raw: string;
};

export type CaptureSingleAgentForensicsInput = {
  sessionId: string;
  /** Last 50 (or fewer) wire events from the events table for this session. */
  recentEvents: SingleAgentEventRow[];
  /** Pending tool-permission requests scoped to this session; [] when none. */
  pendingPermissions: PendingPermissionSummary[];
  /** Held prompt awaiting rate-limit retry, when present. */
  capturedPrompt: CapturedPromptEntry | undefined;
  /** Effective project trust + permissionMode at Stop time. */
  activePermissions: ActivePermissionsSummary;
  /** Absolute path to the project cwd; used for workdir tree hash. */
  projectCwd: string | undefined;
  /** Clock injection for deterministic ts in tests. */
  now?: () => number;
};

/**
 * Build a ForensicsInput-shaped object for a single-agent Stop. Caller is
 * responsible for stamping safetyAuditId in after appending the parent
 * audit row.
 */
export function captureSingleAgentForensics(
  input: CaptureSingleAgentForensicsInput,
): Omit<ForensicsInput, 'safetyAuditId'> {
  const now = input.now ?? Date.now;
  const ts = now();

  // Effective prompt: prefer the captured (held) prompt if rate-limit is
  // pending. Otherwise reach into the recent events to surface the last
  // user-text message for context. If neither: { source: 'none' }.
  const effectivePrompt = buildEffectivePrompt(input.capturedPrompt, input.recentEvents);

  // Last-N events: we trust the caller to have already capped; defensive
  // slice here so a too-large window doesn't bloat the row.
  const eventsLastN = input.recentEvents.slice(-50).map((e) => ({
    seq: e.seq,
    ts: e.ts,
    type: e.type,
    subtype: e.subtype,
    raw: e.raw,
  }));

  // Pending tool calls: filter resolve+toolInput passthrough. resolve() is a
  // closure and can't be serialised — strip it. requestId + toolName + toolInput
  // are the operator-facing trio.
  const pendingToolCalls =
    input.pendingPermissions.length > 0
      ? input.pendingPermissions.map((p) => ({
          requestId: p.requestId,
          toolName: p.toolName,
          toolInput: p.toolInput,
        }))
      : null;

  // Workdir tree hash: shallow walk of projectCwd, sorted by name, capped at
  // WORKDIR_HASH_ENTRY_CAP. Hash of "path|size|mtime\n" lines. Wrapped in
  // try/catch so EACCES / ENOENT on a flaky mount degrades gracefully.
  let workdirTreeHash: string | null = null;
  let snapshotFailedReason: string | null = null;
  if (input.projectCwd) {
    try {
      workdirTreeHash = computeShallowWorkdirHash(input.projectCwd);
    } catch (err) {
      snapshotFailedReason = `workdir_hash_failed: ${(err as Error).message}`;
    }
  }

  return {
    ts,
    sessionId: input.sessionId,
    agentSlug: null, // single-agent: no bus slug
    effectivePrompt,
    eventsLastN,
    pendingToolCalls,
    workdirTreeHash,
    activePermissions: input.activePermissions,
    busInboxOutbox: undefined, // single-agent: bus is N/A
    mutationRationale: undefined, // single-agent: classifier is bus-only
    snapshotFailedReason,
  };
}

type EffectivePromptShape =
  | { source: 'captured'; text: string; projectId: number }
  | { source: 'last-user-event'; text: string; eventSeq: number }
  | { source: 'none' };

function buildEffectivePrompt(
  captured: CapturedPromptEntry | undefined,
  events: SingleAgentEventRow[],
): EffectivePromptShape {
  if (captured) {
    return { source: 'captured', text: captured.text, projectId: captured.projectId };
  }
  // Scan events newest-first for the last user message. We treat type='user_message'
  // or any event whose raw JSON contains a top-level "text" field on a user
  // turn as the candidate; we keep the heuristic narrow (only check type ===
  // 'user_message') to avoid false positives.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === 'user_message') {
      try {
        const parsed = JSON.parse(ev.raw) as { text?: string };
        if (typeof parsed.text === 'string') {
          return { source: 'last-user-event', text: parsed.text, eventSeq: ev.seq };
        }
      } catch {
        // ignore malformed raw row; keep searching
      }
    }
  }
  return { source: 'none' };
}

/**
 * Shallow workdir hash. Walks the cwd one level deep, skipping
 * WORKDIR_HASH_SKIP_DIRS, sorts entries by name, takes the first
 * WORKDIR_HASH_ENTRY_CAP, and hashes "name|size|mtime\n" lines with sha256.
 *
 * We intentionally DON'T recurse — a deep walk on a large monorepo would
 * blow the Stop latency budget, and the spec's intent for the hash is
 * fingerprinting ("did the workdir layout change since the snapshot") not
 * diffing. A shallow shape covers that need.
 */
export function computeShallowWorkdirHash(cwd: string): string {
  const entries = readdirSync(cwd, { withFileTypes: true })
    .filter((d) => !WORKDIR_HASH_SKIP_DIRS.has(d.name))
    .map((d) => d.name)
    .sort()
    .slice(0, WORKDIR_HASH_ENTRY_CAP);
  const h = createHash('sha256');
  for (const name of entries) {
    try {
      const st = statSync(join(cwd, name));
      h.update(`${name}|${st.size}|${st.mtimeMs}\n`);
    } catch {
      // entry vanished between readdir + stat (race) — record presence-only
      h.update(`${name}|?|?\n`);
    }
  }
  return h.digest('hex');
}
