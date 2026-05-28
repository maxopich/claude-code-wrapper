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

// ---------- Cluster C Phase 4f: multi-agent forensic capture ----------
//
// Per-participant forensic snapshot for a multi-agent control action
// (operator kick + auto-kick via pause expiry). Populates the
// `agentSlug`, `busInboxOutbox`, and `mutationRationale` fields that
// `captureSingleAgentForensics` intentionally left NULL — they only
// have content when the action targets a bus participant.
//
// The single-agent vs multi-agent split is on capture shape, not on
// the persistence model: both call `appendForensics` with the same
// `ForensicsInput` shape (minus the safetyAuditId stamped after the
// audit row's append). The audit-viewer (post-v1 surface) reads the
// JSON columns generically and renders whichever fields are populated.
//
// What the multi-agent capture pulls in (per spec §5.5 + the kick path
// needing forensic state at moment of kick):
//
//   - `agentSlug`             — bus_agent_name of the target participant
//   - `effectivePrompt`       — { source: 'last-bus-event', ... } when the
//                               agent's most recent inbox message exists;
//                               { source: 'none' } when freshly added /
//                               never delivered to. Bus participants
//                               don't have a "captured prompt" the way
//                               single-agent's rate-limit hold does, so
//                               we look at the bus inbox tail instead.
//   - `eventsLastN`           — recent BusEvents the participant SAW
//                               (destination = agent slug), capped at 50.
//                               Lets a forensic viewer see "what was
//                               this agent reacting to right before the
//                               action."
//   - `busInboxOutbox`        — separated inbox + outbox tails for the
//                               agent. Different from eventsLastN: this
//                               surfaces the bidirectional view ("agent
//                               was sending X while receiving Y") that's
//                               only meaningful in a bus setting.
//   - `mutationRationale`     — recent mutations the agent's recent
//                               turns performed, each with toolName +
//                               category + summary + filePath +
//                               confirmed-status. Lets an operator
//                               answer "was this kick justified — what
//                               was the agent about to do?"
//   - `workdirTreeHash`       — same shape as single-agent, computed
//                               against the participant's project cwd.
//   - `activePermissions`     — kept undefined for multi-agent: a
//                               participant's permissionMode is
//                               session-wide (`bypassPermissions` for
//                               bus turns per CLAUDE.md), not
//                               per-participant. Surfacing it would
//                               be redundant across the per-agent rows.
//   - `pendingToolCalls`      — null for multi-agent: bus turns run
//                               headless with bypassPermissions, so no
//                               pending `canUseTool` requests exist.
//
// The action-specific metadata (kick mode, reasonCode, trigger ref for
// auto-kick) lives in the parent safety_audit row's payload — the
// forensic bundle complements it with the state-at-action-time, not
// the action itself.

export type MultiAgentBusEvent = {
  id: number;
  ts: number;
  source: string;
  destination: string;
  kind: string;
  textPreview: string;
};

export type MultiAgentMutationSummary = {
  id: number;
  ts: number;
  toolName: string;
  category: 'mutate' | 'dangerous';
  summary: string;
  filePath: string | null;
  confirmed: boolean;
};

export type CaptureMultiAgentForensicsInput = {
  sessionId: string;
  /** Bus agent slug — the router's key and what shows up on
   *  `safety_audit.agent_id` for this row. */
  agentSlug: string;
  /** Absolute path to the participant's project cwd. Used for the
   *  shallow workdir hash. */
  projectCwd: string | undefined;
  /**
   * All BusEvents involving this agent in EITHER direction
   * (source = slug OR destination = slug), most recent last. Caller
   * (the kick handler) filters from `listMultiAgentEvents` to avoid
   * a per-call repo query inside this helper. Cap at 50 here so a
   * test that passes too many doesn't bloat the row.
   */
  agentBusEvents: MultiAgentBusEvent[];
  /** All mutations by this agent for the session, ascending ts.
   *  Capped at 50 most-recent inside the helper. */
  agentMutations: MultiAgentMutationSummary[];
  /** Total count of bus events in the session (any source/destination)
   *  so the forensic viewer can show "agent's slice / total" context. */
  totalSessionEvents: number;
  /** Clock injection for deterministic ts in tests. */
  now?: () => number;
};

const MULTI_AGENT_EVENTS_CAP = 50;
const MULTI_AGENT_MUTATIONS_CAP = 50;
const BUS_EVENT_TEXT_PREVIEW_CHARS = 240;

/**
 * Build a ForensicsInput-shaped bundle for a multi-agent control action
 * targeting one participant. Returns the bundle minus `safetyAuditId`
 * — the caller (executeKickParticipant / executeExpireParticipant)
 * stamps that in after appending the parent audit row.
 *
 * Pure-ish: workdir read is the only side effect, wrapped same way as
 * the single-agent path so a flaky mount degrades to
 * `workdirTreeHash: null` + `snapshotFailedReason` populated.
 */
export function captureMultiAgentForensics(
  input: CaptureMultiAgentForensicsInput,
): Omit<ForensicsInput, 'safetyAuditId'> {
  const now = input.now ?? Date.now;
  const ts = now();

  // Cap the event window inside the helper too (caller already filtered,
  // but a too-generous caller shouldn't blow the row size).
  const events = input.agentBusEvents.slice(-MULTI_AGENT_EVENTS_CAP);
  const mutations = input.agentMutations.slice(-MULTI_AGENT_MUTATIONS_CAP);

  // Effective prompt: scan the agent's bus events newest-first for the
  // last message ADDRESSED TO IT (destination = agent slug). That's the
  // semantic equivalent of single-agent's "last user message" — the
  // most recent thing the agent was asked to act on.
  const effectivePrompt = buildMultiAgentEffectivePrompt(input.agentSlug, events);

  // Wire-shape last-N events: the single-agent shape is { seq, ts, type,
  // subtype, raw }, the multi-agent shape is keyed on bus event fields.
  // We use the BusEvent fields directly so the JSON column captures
  // routing context (source/destination) — without those, the forensic
  // viewer couldn't tell whether the agent was talking or listening.
  const eventsLastN = events.map((e) => ({
    id: e.id,
    ts: e.ts,
    source: e.source,
    destination: e.destination,
    kind: e.kind,
    textPreview: e.textPreview,
  }));

  // Inbox / outbox split: same source events but partitioned. The
  // forensic viewer can render two columns; eventsLastN is the
  // flattened chronological view used by simpler renderers.
  const busInboxOutbox = {
    inbox: events
      .filter((e) => e.destination === input.agentSlug)
      .map((e) => ({
        id: e.id,
        ts: e.ts,
        source: e.source,
        kind: e.kind,
        textPreview: e.textPreview,
      })),
    outbox: events
      .filter((e) => e.source === input.agentSlug)
      .map((e) => ({
        id: e.id,
        ts: e.ts,
        destination: e.destination,
        kind: e.kind,
        textPreview: e.textPreview,
      })),
    totalSessionEvents: input.totalSessionEvents,
  };

  // Mutation rationale: list of recent mutations attributed to this
  // agent, ordered ts ASC (matches the persistence order so a viewer
  // sees the action sequence directly). Each row carries enough
  // identifying info for cross-reference with the multi_agent_mutations
  // table without re-querying.
  const mutationRationale = {
    recentMutations: mutations.map((m) => ({
      id: m.id,
      ts: m.ts,
      toolName: m.toolName,
      category: m.category,
      summary: m.summary,
      filePath: m.filePath,
      confirmed: m.confirmed,
    })),
    totalMutations: input.agentMutations.length,
  };

  // Workdir hash — same wrapping as single-agent. NULL when cwd
  // missing (chain mode or pathological state); reason logged on
  // snapshotFailedReason if the read throws.
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
    agentSlug: input.agentSlug,
    effectivePrompt,
    eventsLastN,
    pendingToolCalls: null, // bus turns run headless; no pending canUseTool
    workdirTreeHash,
    activePermissions: undefined, // session-wide for bus, not per-participant
    busInboxOutbox,
    mutationRationale,
    snapshotFailedReason,
  };
}

type MultiAgentEffectivePromptShape =
  | { source: 'last-bus-inbox'; text: string; eventId: number; from: string }
  | { source: 'none' };

function buildMultiAgentEffectivePrompt(
  agentSlug: string,
  events: readonly MultiAgentBusEvent[],
): MultiAgentEffectivePromptShape {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.destination === agentSlug) {
      return {
        source: 'last-bus-inbox',
        text: ev.textPreview,
        eventId: ev.id,
        from: ev.source,
      };
    }
  }
  return { source: 'none' };
}

/**
 * Helper: turn a raw BusEvent (full text, no preview) into the
 * preview-trimmed shape `captureMultiAgentForensics` expects. Lives
 * here so the caller doesn't have to know the preview char cap.
 */
export function toBusEventPreview(ev: {
  id: number;
  ts: number;
  source: string;
  destination: string;
  kind: string;
  text: string;
}): MultiAgentBusEvent {
  return {
    id: ev.id,
    ts: ev.ts,
    source: ev.source,
    destination: ev.destination,
    kind: ev.kind,
    textPreview:
      ev.text.length > BUS_EVENT_TEXT_PREVIEW_CHARS
        ? ev.text.slice(0, BUS_EVENT_TEXT_PREVIEW_CHARS) + '…'
        : ev.text,
  };
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
