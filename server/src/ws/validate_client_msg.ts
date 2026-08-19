/**
 * Shape validation for inbound `ClientMsg` frames (register S17 + H10).
 *
 * WHY THIS EXISTS. `ws/server.ts` used to do `JSON.parse(raw.toString())` and
 * assert the result as `ClientMsg`. An assertion is not a check: every handler
 * then indexed fields the compiler believed were there. The cost is not only
 * crashes — it is handlers that quietly do the WRONG thing:
 *
 *   { "type": "set_trusted", "projectId": 1, "trusted": "false" }
 *
 * `"false"` is a truthy string, so that frame TRUSTS the project — flipping
 * both `permissionMode` and `settingSources` for its future runs — and writes
 * `to: "false"` into the hash-chained audit log, a value that is neither of
 * the field's two legal states. Frames that instead throw surfaced as
 * `wrapper_error { kind: 'process_crashed' }`, telling the operator the claude
 * process died when in fact a frame was malformed.
 *
 * WHAT IT CHECKS. Per message type, that every declared field is present (or
 * legitimately absent) and is the right primitive shape. Unknown extra fields
 * are IGNORED, not rejected — an older server talking to a newer client should
 * degrade, not refuse.
 *
 * WHAT IT DOES NOT CHECK, deliberately:
 *
 *   - The interiors of `object` fields (`updatedInput`, `answers`, `layout`,
 *     `filters`). Their consumers already treat them as bags of unknowns.
 *   - Numeric ranges. `offset: -1` is a handler's business, not the wire's.
 *   - Most string-literal unions (`decision`, `op`, `scope`, the two `mode`s,
 *     `lifecycle`). Restating those member lists here would be a second copy
 *     that rots independently of the type — the exact defect class this file
 *     was written for. The five unions that ALREADY ship a runtime guard from
 *     `@cebab/shared` are checked with that guard, because using it adds no
 *     copy; the rest are checked as `string` and left to the handler's switch.
 *
 * HOW IT STAYS HONEST. `SHAPES` is typed as `Table` below, a mapped type over
 * the `ClientMsg` union itself. That makes two things typecheck failures
 * rather than silent gaps:
 *
 *   1. a new `ClientMsg` variant with no entry here, and
 *   2. an EXISTING variant that gains a field — the entry stops satisfying
 *      `Record<Exclude<keyof Variant, 'type'>, Spec>` until the field is named.
 *
 * So `npm run typecheck` is this file's real gate; the unit tests only prove
 * the runtime half agrees with the table.
 */
import {
  isControlReasonCode,
  isKickMode,
  isPauseExpiryAction,
  isSessionPermissionMode,
  isStopReasonCode,
  type ClientMsg,
} from '@cebab/shared';

/** The primitive shapes the wire actually carries. */
type Kind = 'string' | 'number' | 'boolean' | 'object' | 'string[]' | 'number[]' | 'string|null';

/**
 * A field's spec: a `Kind`, the same suffixed with `?` for "may be absent", or
 * a `Kind` paired with a membership guard re-used from `@cebab/shared`.
 */
type Spec = Kind | `${Kind}?` | { readonly kind: Kind; readonly is: (v: unknown) => boolean };

/**
 * Every field of every variant must be named. `Exclude<…, 'type'>` drops the
 * discriminant (checked separately); `Record` makes the rest REQUIRED keys of
 * the entry, which is what turns "a variant grew a field" into a type error.
 */
type Table = {
  [K in ClientMsg['type']]: Record<Exclude<keyof Extract<ClientMsg, { type: K }>, 'type'>, Spec>;
};

const permissionMode = { kind: 'string', is: isSessionPermissionMode } as const;
const controlReason = { kind: 'string', is: isControlReasonCode } as const;
const stopReason = { kind: 'string', is: isStopReasonCode } as const;
const expiryAction = { kind: 'string', is: isPauseExpiryAction } as const;
const kickMode = { kind: 'string', is: isKickMode } as const;

const SHAPES: Table = {
  list_projects: {},
  open_project: { projectId: 'number' },
  send_message: {
    projectId: 'number',
    sessionId: 'string?',
    text: 'string',
    maxTurns: 'number?',
  },
  interrupt: { sessionId: 'string' },
  permission_decision: {
    sessionId: 'string',
    requestId: 'string',
    decision: 'string',
    updatedInput: 'object?',
    message: 'string?',
  },
  set_trusted: { projectId: 'number', trusted: 'boolean' },
  load_session: { projectId: 'number', sessionId: 'string' },
  get_settings: {},
  set_workspace_root: { path: 'string' },
  set_default_hop_budget: { value: 'number' },
  set_default_max_turns: { value: 'number' },
  set_permission_mode: { sessionId: 'string', mode: permissionMode },
  rename_session: { sessionId: 'string', title: 'string|null' },
  install_bus_integration: { projectId: 'number' },
  uninstall_bus_integration: { projectId: 'number' },
  start_multi_agent: {
    mode: 'string',
    participants: 'number[]',
    initialPrompt: 'string',
    lifecycle: 'string?',
    pauseOnDangerous: 'boolean?',
    executeMode: 'boolean?',
    templateId: 'string?',
    hopBudget: 'number?',
  },
  stop_multi_agent: { sessionId: 'string' },
  resume_multi_agent: { sessionId: 'string' },
  continue_multi_agent: { sessionId: 'string' },
  retry_worker: { sessionId: 'string' },
  abandon_session: { sessionId: 'string' },
  continue_through_mutation: { sessionId: 'string', mutationId: 'number' },
  multi_agent_user_prompt: { sessionId: 'string', text: 'string' },
  multi_agent_ask_user_answer: {
    sessionId: 'string',
    agent: 'string',
    toolUseId: 'string',
    answers: 'object',
  },
  list_iterations: {},
  clear_iterations: {},
  archive_session: { sessionId: 'string', removeArtifacts: 'boolean?' },
  reopen_session: { sessionId: 'string' },
  reopen_session_confirmed: {
    sessionId: 'string',
    acknowledgedWorkspaceDiff: 'boolean',
    typedConfirmation: 'string?',
  },
  set_multi_agent_lifecycle: { sessionId: 'string', lifecycle: 'string' },
  add_multi_agent_participant: { sessionId: 'string', projectId: 'number' },
  list_templates: {},
  save_template: {
    name: 'string',
    mode: 'string',
    lifecycle: 'string',
    participants: 'number[]',
    roles: 'object?',
    layout: 'object?',
    hopBudget: 'number?',
  },
  delete_template: { id: 'string' },
  load_session_log: {
    sessionId: 'string',
    scope: 'string?',
    offset: 'number',
    limit: 'number',
    revealSensitive: 'boolean?',
  },
  read_project_facts: { projectId: 'number' },
  get_last_run_for_template: { templateId: 'string' },
  ack_notification: { id: 'string', ackReason: 'string?' },
  request_inbox_snapshot: { filters: 'object?' },
  clear_dismissed_inbox: {},
  get_project_authority: { projectId: 'number', mode: 'string' },
  mcp_trust_decision: {
    pendingId: 'string?',
    serverName: 'string',
    originPath: 'string',
    binarySha: 'string?',
    decision: 'string',
  },
  bus_trust_decision: { pendingId: 'string', projectId: 'number', decision: 'string' },
  acknowledge_and_start: {
    pendingStartId: 'string',
    typedAcknowledgment: 'string',
    reasonText: 'string?',
  },
  cancel_gate: { kind: 'string', pendingId: 'string' },
  retry_rate_limited: { sessionId: 'string', auto: 'boolean?' },
  start_auth_refresh: {},
  cancel_auth_refresh: { runId: 'string' },
  get_recovery_log_snapshot: { recentLimit: 'number?' },
  get_storage_stats: {},
  get_stray_session_folders: {},
  delete_stray_session_folders: { names: 'string[]' },
  get_kick_forensics: { sessionId: 'string', agentSlug: 'string' },
  stop_reason: {
    sessionId: 'string',
    interruptAckId: 'string',
    reasonCode: stopReason,
    reasonText: 'string?',
  },
  mute_participant: {
    sessionId: 'string',
    projectId: 'number',
    reasonCode: controlReason,
    reasonText: 'string?',
  },
  unmute_participant: {
    sessionId: 'string',
    projectId: 'number',
    reasonCode: controlReason,
    reasonText: 'string?',
  },
  pause_participant: {
    sessionId: 'string',
    projectId: 'number',
    reasonCode: controlReason,
    reasonText: 'string?',
    timeoutMs: 'number',
    expiryAction,
  },
  resume_participant: {
    sessionId: 'string',
    projectId: 'number',
    reasonCode: controlReason,
    reasonText: 'string?',
  },
  kick_participant: {
    sessionId: 'string',
    projectId: 'number',
    reasonCode: controlReason,
    reasonText: 'string?',
    mode: kickMode,
  },
  bulk_session_op: { sessionIds: 'string[]', op: 'string', removeArtifacts: 'boolean?' },
  search_sessions: {
    query: 'string',
    scope: 'string',
    projectId: 'number?',
    includeArchived: 'boolean?',
    raw: 'boolean?',
    limit: 'number?',
  },
  get_artifact_content: { mutationId: 'number' },
};

/** Exported for the tests that prove the runtime half matches the table. */
export const CLIENT_MSG_TYPES: readonly string[] = Object.keys(SHAPES);

function matchesKind(kind: Kind, v: unknown): boolean {
  switch (kind) {
    case 'string':
      return typeof v === 'string';
    // `Number.isFinite` rather than `typeof v === 'number'`: JSON cannot carry
    // NaN or Infinity as literals, but it can carry them through a non-browser
    // client, and `limit`/`offset`/`timeoutMs` all reach arithmetic.
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'string[]':
      return Array.isArray(v) && v.every((e) => typeof e === 'string');
    case 'number[]':
      return Array.isArray(v) && v.every((e) => typeof e === 'number' && Number.isFinite(e));
    case 'string|null':
      return v === null || typeof v === 'string';
  }
}

export type ClientMsgValidation = { ok: true; msg: ClientMsg } | { ok: false; reason: string };

/**
 * Validate a parsed frame.
 *
 * The `reason` is written for a server log line, so it names the message type
 * and the offending FIELD but never the offending VALUE — frames carry prompt
 * text and edited tool inputs. The type is length-capped for the same reason:
 * it is attacker-controlled and ends up in the log.
 */
export function validateClientMsg(value: unknown): ClientMsgValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'frame is not a JSON object' };
  }
  const frame = value as Record<string, unknown>;
  const type = frame['type'];
  if (typeof type !== 'string') {
    return { ok: false, reason: 'frame has no string `type`' };
  }
  // `hasOwnProperty.call` rather than `type in SHAPES` or a bare lookup: the
  // discriminant is attacker-supplied, and `'constructor'` / `'toString'`
  // would otherwise resolve up the prototype chain to a function.
  if (!Object.prototype.hasOwnProperty.call(SHAPES, type)) {
    return { ok: false, reason: `unknown type \`${type.slice(0, 40)}\`` };
  }
  const fields = SHAPES[type as ClientMsg['type']] as Record<string, Spec>;

  for (const [name, spec] of Object.entries(fields)) {
    const present = Object.prototype.hasOwnProperty.call(frame, name);
    const raw = present ? frame[name] : undefined;

    if (typeof spec === 'string') {
      const optional = spec.endsWith('?');
      const kind = (optional ? spec.slice(0, -1) : spec) as Kind;
      if (optional && (!present || raw === undefined)) continue;
      if (!matchesKind(kind, raw)) {
        return { ok: false, reason: `${type}.${name} is not ${kind}` };
      }
      continue;
    }

    if (!matchesKind(spec.kind, raw) || !spec.is(raw)) {
      return { ok: false, reason: `${type}.${name} is not a known value` };
    }
  }

  return { ok: true, msg: value as ClientMsg };
}
