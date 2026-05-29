import { randomUUID } from 'node:crypto';
import type { ServerMsg } from '@cebab/shared/protocol';
import { appendSafetyAudit } from '../notifications/safety_audit.js';
import { getProject, getProjectBusTrust, setProjectBusTrust } from '../repo/projects.js';
import { chooseAgentName } from './install.js';

/**
 * Cluster G Phase 4 (D6/D11): TOFU gate for bus install.
 *
 * The bus is a Cebab-injected in-process MCP closure
 * (`bus/runner.ts:makeBusToolServer`). "Installing" a project for the bus
 * flips `projects.bus_installed` + writes a slug; no binary executes and
 * no file is written into the project. That tempts a silent-flip
 * implementation, but per the agentic-reviewer correction
 * (high/G-run-awareness §4.4 + §7):
 *
 *   - the slug Cebab pins becomes the worker's `source` on every later
 *     `bus_send` call;
 *   - the bus is the enforcement point for D4 router-drop filters; and
 *   - "post-action confirmation is the silent-safety anti-pattern in
 *     another form" — by the time the operator sees a confirmation
 *     toast, the bus is already running.
 *
 * So this gate sits BEFORE `installBusForProject` in each install call
 * site (the explicit `install_bus_integration` handler and the
 * `add_multi_agent_participant` auto-install path), and refuses to call
 * the installer until a persisted decision exists or the operator
 * resolves a per-connection prompt.
 *
 * Decision matrix (mirrors the spec's gate-placement comment, §4.4):
 *
 *   `projects.bus_trust_decision`  →  gate behavior
 *   --------------------------------------------------------------
 *   'trusted'                        silent pass; install proceeds.
 *   'denied'                         silent refusal + safety_audit
 *                                    `bus.install_denied`; install
 *                                    does NOT proceed.
 *   NULL (per-Conn `denyOnce` hit)   silent refusal + safety_audit
 *                                    `bus.install_denied`; install
 *                                    does NOT proceed. The deny set
 *                                    is per-Conn, so a reconnection
 *                                    re-prompts.
 *   NULL (first-seen)                emit `bus_auto_install_pending`,
 *                                    block on the operator's
 *                                    `bus_trust_decision` reply.
 *
 * The gate's promise never times out: if the operator never replies,
 * the install caller hangs. A WS disconnect upstream blows away the
 * `Conn` (and with it `busTrustGate.pending`), which is the only
 * structural way out. This matches the MCP gate's
 * `awaitMcpTrustDecisions` contract and the spec's "the install does
 * not happen until the operator decides" framing.
 */

/**
 * Per-Conn gate state. Lives on the Conn (in `ws/server.ts`) so the
 * pending Map clears on disconnect (any parked decisions die with their
 * session; a reconnect re-prompts), and the `denyOnce` set scopes to
 * one connection (operator's "no, just this once" doesn't bleed into
 * the next browser session).
 */
export type BusTrustGateState = {
  /**
   * `pendingId` → parked-install entry. The `bus_trust_decision`
   * handler looks up by pendingId and calls `entry.resolve(decision)`
   * to unblock the awaiting install. Entries are deleted on
   * resolution.
   */
  pending: Map<string, PendingBusTrustEntry>;
  /**
   * Per-Conn deny_once set. Keyed by `projectId`. A repeat install
   * attempt against the same project in the same Conn after a
   * `deny_once` decision is silently refused without re-prompting.
   */
  denyOnce: Set<number>;
};

export type PendingBusTrustEntry = {
  pendingId: string;
  projectId: number;
  /** Resolved by the `bus_trust_decision` handler. */
  resolve: (decision: BusTrustDecisionKind) => void;
};

/** The three operator decisions the gate accepts. */
export type BusTrustDecisionKind = 'trust' | 'deny_once' | 'deny_remember';

/** What the gate returns to the install caller. */
export type BusTrustGateOutcome =
  | { approved: true; reason: 'trusted' | 'just_trusted' }
  | { approved: false; reason: 'denied_remember' | 'deny_once' };

export function makeBusTrustGateState(): BusTrustGateState {
  return { pending: new Map(), denyOnce: new Set() };
}

export type AwaitBusTrustInput = {
  projectId: number;
  /**
   * Multi-agent sessionId the install was raised from, or null for an
   * explicit (sidebar-button) install. Threaded into the
   * `bus_auto_install_pending` envelope (for UI deep-linking) and the
   * `safety_audit` payload (for forensics).
   */
  contextSessionId: string | null;
  gate: BusTrustGateState;
  /** WS sink for the `bus_auto_install_pending` envelope (NULL path only). */
  send: (msg: ServerMsg) => void;
};

/**
 * Resolve the bus-install trust gate for a single project.
 *
 * Reads the persisted `projects.bus_trust_decision` first. If absent,
 * checks the per-Conn `denyOnce` set, then falls through to the
 * first-seen prompt path (emit + await).
 *
 * Returns a `BusTrustGateOutcome` describing the decision; the install
 * caller only proceeds with `installBusForProject(projectId)` when
 * `approved: true`. Every denial is dual-written to `safety_audit` with
 * `kind: 'bus.install_denied'`.
 */
export async function awaitBusTrustDecision(
  input: AwaitBusTrustInput,
): Promise<BusTrustGateOutcome> {
  const persisted = getProjectBusTrust(input.projectId);

  if (persisted === 'trusted') {
    // Silent pass — no audit row needed; the original `bus.trust_decided`
    // row from the first-seen decision (or the migration-024 backfill)
    // is the forensic anchor.
    return { approved: true, reason: 'trusted' };
  }

  if (persisted === 'denied') {
    recordSilentRefusal(input.projectId, 'denied_remember', input.contextSessionId);
    return { approved: false, reason: 'denied_remember' };
  }

  if (input.gate.denyOnce.has(input.projectId)) {
    recordSilentRefusal(input.projectId, 'deny_once', input.contextSessionId);
    return { approved: false, reason: 'deny_once' };
  }

  // First-seen: derive the slug the install WOULD pin so the operator
  // sees the exact identity in the prompt. If we can't derive a slug
  // (project missing on disk, name has no alphanumerics AND the
  // `agent-<id>` fallback collides), refuse cleanly with an audit row —
  // the gate is the right place to surface this since the install would
  // throw downstream anyway.
  const project = getProject(input.projectId);
  if (!project) {
    recordSilentRefusal(input.projectId, 'project_not_found', input.contextSessionId);
    return { approved: false, reason: 'denied_remember' };
  }

  let agentName: string;
  try {
    agentName = chooseAgentName(project.name, project.id);
  } catch {
    // `chooseAgentName` throws InstallError for empty / collided slugs.
    // Don't expose details on the wire; the operator can still kick off
    // a manual install and see the typed error there.
    recordSilentRefusal(input.projectId, 'agent_name_unavailable', input.contextSessionId);
    return { approved: false, reason: 'denied_remember' };
  }

  const pendingId = randomUUID();
  const envelope: ServerMsg = {
    type: 'bus_auto_install_pending',
    pendingId,
    projectId: input.projectId,
    projectName: project.name,
    agentName,
    contextSessionId: input.contextSessionId,
  };

  const decisionPromise = new Promise<BusTrustDecisionKind>((resolve) => {
    input.gate.pending.set(pendingId, {
      pendingId,
      projectId: input.projectId,
      resolve: (decision) => {
        // Drop the entry before persistence so a throw inside the
        // applier can't leak a dangling pending registration.
        input.gate.pending.delete(pendingId);
        resolve(decision);
      },
    });
  });

  input.send(envelope);
  const decision = await decisionPromise;
  return applyDecision({
    projectId: input.projectId,
    gate: input.gate,
    decision,
    contextSessionId: input.contextSessionId,
  });
}

/**
 * Resolve a parked pending by id. The `bus_trust_decision` handler
 * calls this from `ws/server.ts` after validating the inbound shape.
 *
 * Returns `true` if a pending entry was matched and resolved; `false`
 * if no entry existed for the id (stale reply after a WS reconnect, or
 * a malicious client trying to inject decisions for ids it doesn't
 * own). Callers can use the boolean to surface a soft `wrapper_error`
 * for the second case if they want — Phase 1 (this slice) ignores
 * silently because the upstream invariants make spoofing harmless.
 */
export function resolveBusTrustPending(
  gate: BusTrustGateState,
  pendingId: string,
  decision: BusTrustDecisionKind,
): boolean {
  const entry = gate.pending.get(pendingId);
  if (!entry) return false;
  entry.resolve(decision);
  return true;
}

// ---- internals ----

function applyDecision(args: {
  projectId: number;
  gate: BusTrustGateState;
  decision: BusTrustDecisionKind;
  contextSessionId: string | null;
}): BusTrustGateOutcome {
  switch (args.decision) {
    case 'trust':
      setProjectBusTrust(args.projectId, 'trusted');
      appendSafetyAudit({
        ts: Date.now(),
        sessionId: args.contextSessionId,
        kind: 'bus.trust_decided',
        reasonCode: 'trust',
        payload: { projectId: args.projectId },
      });
      return { approved: true, reason: 'just_trusted' };
    case 'deny_remember':
      setProjectBusTrust(args.projectId, 'denied');
      appendSafetyAudit({
        ts: Date.now(),
        sessionId: args.contextSessionId,
        kind: 'bus.trust_decided',
        reasonCode: 'deny_remember',
        payload: { projectId: args.projectId },
      });
      // `recordSilentRefusal` is for SILENT refusals (re-asked after a
      // prior denial). The first-seen `deny_remember` is the
      // operator's *active* decision, so we log it under
      // `bus.trust_decided` only. The next install attempt will hit
      // `persisted === 'denied'` and emit the silent-refusal row from
      // that path.
      return { approved: false, reason: 'denied_remember' };
    case 'deny_once':
      args.gate.denyOnce.add(args.projectId);
      appendSafetyAudit({
        ts: Date.now(),
        sessionId: args.contextSessionId,
        kind: 'bus.trust_decided',
        reasonCode: 'deny_once',
        payload: { projectId: args.projectId },
      });
      return { approved: false, reason: 'deny_once' };
    default: {
      const _exhaustive: never = args.decision;
      void _exhaustive;
      // Unreachable under TypeScript; defensive return for runtime
      // safety if a future ClientMsg literal slips through validation.
      return { approved: false, reason: 'deny_once' };
    }
  }
}

/**
 * Append `bus.install_denied` for an install attempt that was refused
 * without re-prompting (prior persisted denial, prior per-Conn
 * deny_once, or upstream prerequisite failure). The active-decision
 * rows live under `bus.trust_decided` instead — see `applyDecision`.
 */
function recordSilentRefusal(
  projectId: number,
  reasonCode: 'denied_remember' | 'deny_once' | 'project_not_found' | 'agent_name_unavailable',
  contextSessionId: string | null,
): void {
  appendSafetyAudit({
    ts: Date.now(),
    sessionId: contextSessionId,
    kind: 'bus.install_denied',
    reasonCode,
    payload: { projectId },
  });
}
