import { randomUUID } from 'node:crypto';
import type { ServerMsg, McpServerView } from '@cebab/shared/protocol';
import { listForServer, recordTrustDecision } from './mcp_trust.js';
import { appendSafetyAudit } from '../notifications/safety_audit.js';

// Cluster B Phase 4b (§4.4): Pre-spawn TOFU gate.
//
// Phase 4a built the persisted state (table `mcp_trust`), the wire envelopes
// (`mcp_auto_install_pending` ServerMsg + `mcp_trust_decision` ClientMsg with
// optional `pendingId`), and the resolver's JOIN that maps each declared MCP
// server into a `trust` state ('trusted' | 'pending_tofu' | 'hash_changed' |
// 'denied' | 'unknown').
//
// Phase 4b wires that machinery into the start-session paths. Before the SDK
// spawns a worker (single-agent first turn OR multi-agent participant), the
// gate enumerates every declared MCP server for the project and parks the
// spawn until each unfamiliar (pending_tofu) or upgraded (hash_changed)
// server has an operator decision.
//
// Decision matrix:
//   - cebab-injected             → silent (always trusted; Cebab pins these)
//   - trust='trusted'            → silent (matches existing mcp_trust row)
//   - trust='denied'             → silent refusal + safety_audit row
//   - per-session deny_once hit  → silent refusal + safety_audit row
//   - trust='pending_tofu'       → emit `first_seen` pending + await decision
//   - trust='hash_changed'       → emit `hash_changed` pending + await decision
//   - trust='unknown' (no path)  → silent (no anchor; same as cebab-injected)
//
// The "block" is structural: `awaitMcpTrustDecisions` returns a Promise that
// resolves only when EVERY parked pending has been answered. The caller
// (start_multi_agent / runOneTurn) awaits before calling pickRunner so the
// spawn cannot race a decision.
//
// Cebab cannot today surgically prevent a single project-declared MCP from
// loading once the SDK starts (the SDK reads settingSources + merges its own
// mcpServers param). What the gate guarantees IS:
//   - The operator sees first_seen / hash_changed BEFORE the run begins.
//   - Every decision is dual-written to mcp_trust + safety_audit (BE-1).
//   - Per-session deny_once is honored for THIS connection's subsequent
//     start_session calls (re-prompts on the next connection).
// Future work (Phase 5+): write decisions back to settings.json or get an
// SDK option for per-server disable, so "denied" actually stops the binary.

/**
 * Per-connection gate state. Lives on the `Conn` (in ws/server.ts) so the
 * pending Map clears on disconnect (the operator's parked decisions die with
 * their session; a reconnect re-prompts).
 */
export type TrustGateState = {
  /**
   * `pendingId` → parked-decision entry. The `mcp_trust_decision` handler
   * looks up by pendingId and calls `entry.resolve(outcome)` to unblock the
   * awaiting spawn. Entries are deleted on resolution.
   */
  pending: Map<string, PendingTrustEntry>;
  /**
   * Per-session deny_once decisions. Key shape: `<projectId>:<serverName>@<originPath>`.
   * A repeat start_session against the same project + server in the same
   * connection sees the entry and silent-refuses without re-prompting.
   * Cleared on WS disconnect (the spec's "ask again next time" is "next
   * connection," not "next minute" — by design simple).
   */
  denyOnce: Set<string>;
};

export type PendingTrustEntry = {
  pendingId: string;
  serverName: string;
  originPath: string;
  /** Resolved by the mcp_trust_decision handler. Removes itself from the Map. */
  resolve: (outcome: TrustGateOutcome) => void;
};

/** What the operator decided for one pending. Drives both persistence and
 *  the gate's return value. */
export type TrustGateOutcome =
  | { kind: 'allow' }
  | { kind: 'allow_pinned'; binarySha: string }
  | { kind: 'deny_once' }
  | { kind: 'deny_remember' };

export function makeTrustGateState(): TrustGateState {
  return { pending: new Map(), denyOnce: new Set() };
}

/** Composite key used by `denyOnce` and exposed for test setup. */
export function denyOnceKey(projectId: number, serverName: string, originPath: string): string {
  return `${projectId}:${serverName}@${originPath}`;
}

/**
 * Summary of what happened during one gate pass. The caller uses this for
 * structured logging; tests assert on it. Empty fields are fine — a project
 * with all-trusted MCPs returns `{ approvals: 0, persistedDenials: 0, refused: [] }`.
 */
export type GateOutcome = {
  /** Number of `mcp_trust` rows the operator wrote during this gate
   *  (trust + trust_pinned + deny_remember). deny_once is in-memory and
   *  doesn't count here. */
  approvals: number;
  /** Number of `mcp_trust` rows with decision='denied_remember'. */
  persistedDenials: number;
  /** Servers that ended up silently refused, with `persisted: true` for
   *  denied_remember (this gate or earlier) and false for deny_once. */
  refused: Array<{ serverName: string; originPath: string; persisted: boolean }>;
};

export type AwaitGateInput = {
  projectId: number;
  gate: TrustGateState;
  /** WS sink. The gate emits 0+ `mcp_auto_install_pending` envelopes through this. */
  send: (msg: ServerMsg) => void;
  /** Servers to gate. Caller (start_session path) passes the resolver's
   *  `mcpServers` view so the resolver and the gate agree on scope+sha+trust. */
  servers: McpServerView[];
};

/**
 * Walk `servers`, emit a `mcp_auto_install_pending` for each one needing an
 * operator decision, park a promise per pending, and resolve when every
 * decision has arrived. Servers that are already trusted / denied / cebab-
 * injected short-circuit silently — for `denied` (persisted OR per-session
 * deny_once) we still record a `mcp.trust_silent_refusal` safety_audit row so
 * the forensic trail captures every spawn that proceeded past a denial.
 *
 * Returns a `GateOutcome` summarizing the pass (for logging / tests).
 *
 * No exception path: if the operator never replies, the promise hangs. The
 * caller (ws/server.ts) holds the await inside its `try/catch` for
 * start_multi_agent / runOneTurn; a WS disconnect upstream (which kills
 * `conn.trustGate`) is the only way out. That's intentional — the spec's
 * gate-and-block contract is "the spawn does not happen until the operator
 * decides," not "timeout after N seconds and proceed."
 */
export async function awaitMcpTrustDecisions(input: AwaitGateInput): Promise<GateOutcome> {
  const outcome: GateOutcome = { approvals: 0, persistedDenials: 0, refused: [] };
  const promises: Promise<void>[] = [];

  for (const server of input.servers) {
    // Cebab-injected (e.g. cebab_bus) is always trusted — Cebab pins it.
    if (server.scope === 'cebab-injected') continue;
    // No origin → no anchor for a decision row. Treat as silent.
    if (!server.originPath) continue;

    const originPath = server.originPath;
    const sessionKey = denyOnceKey(input.projectId, server.name, originPath);

    // Per-session deny_once takes precedence over any persisted state — the
    // operator's most recent decision in THIS connection wins until the
    // connection closes.
    if (input.gate.denyOnce.has(sessionKey)) {
      recordSilentRefusal(input.projectId, server.name, originPath, 'deny_once');
      outcome.refused.push({ serverName: server.name, originPath, persisted: false });
      continue;
    }

    switch (server.trust) {
      case 'trusted':
      case 'unknown':
        // 'trusted' is the silent-pass case; 'unknown' fires when the
        // enrichment pass left the row alone (no originPath, or a non-
        // cebab-injected server without a computable trust state). Silent
        // either way.
        continue;
      case 'denied':
        recordSilentRefusal(input.projectId, server.name, originPath, 'denied_remember');
        outcome.refused.push({ serverName: server.name, originPath, persisted: true });
        continue;
      case 'pending_tofu':
      case 'hash_changed':
        // Fall through to the prompt path.
        break;
      default: {
        // Exhaustiveness — surfaces a typecheck error if McpServerView['trust']
        // gains a new variant without updating this gate.
        const _exhaustive: never = server.trust;
        void _exhaustive;
        continue;
      }
    }

    const pendingId = randomUUID();
    const reason: 'first_seen' | 'hash_changed' =
      server.trust === 'hash_changed' ? 'hash_changed' : 'first_seen';
    const command = server.config?.command ?? '';
    const args = server.config?.args;
    const binarySha = server.binarySha;

    // For hash_changed, surface the prior pinned hash so the operator can
    // compare ("was abc123… now def456…").
    let previousSha: string | undefined;
    if (reason === 'hash_changed') {
      const history = listForServer(server.name, originPath);
      for (const row of history) {
        if (row.decision === 'trusted_pinned_hash' && row.binary_sha) {
          previousSha = row.binary_sha;
          break;
        }
      }
    }

    const envelope: ServerMsg = {
      type: 'mcp_auto_install_pending',
      pendingId,
      serverName: server.name,
      originPath,
      command,
      reason,
      ...(args && args.length > 0 ? { args } : {}),
      ...(binarySha ? { binarySha } : {}),
      ...(previousSha ? { previousSha } : {}),
    };

    const spawnPromise = new Promise<void>((resolveSpawn) => {
      input.gate.pending.set(pendingId, {
        pendingId,
        serverName: server.name,
        originPath,
        resolve: (decision) => {
          // Always clean up the Map before doing persistence so a thrown
          // recordTrustDecision can't leak a dangling entry (the spawn
          // promise still resolves — we don't want one bad audit-write to
          // freeze the gate forever).
          input.gate.pending.delete(pendingId);
          try {
            applyDecision({
              projectId: input.projectId,
              gate: input.gate,
              server,
              originPath,
              decision,
              outcome,
              sessionKey,
            });
          } finally {
            resolveSpawn();
          }
        },
      });
    });

    input.send(envelope);
    promises.push(spawnPromise);
  }

  await Promise.all(promises);
  return outcome;
}

// ---- internals ----

function applyDecision(args: {
  projectId: number;
  gate: TrustGateState;
  server: McpServerView;
  originPath: string;
  decision: TrustGateOutcome;
  outcome: GateOutcome;
  sessionKey: string;
}): void {
  switch (args.decision.kind) {
    case 'allow':
      recordTrustDecision({
        serverName: args.server.name,
        originPath: args.originPath,
        binarySha: args.server.binarySha ?? null,
        decision: 'trusted',
      });
      args.outcome.approvals += 1;
      return;
    case 'allow_pinned':
      recordTrustDecision({
        serverName: args.server.name,
        originPath: args.originPath,
        binarySha: args.decision.binarySha,
        decision: 'trusted_pinned_hash',
      });
      args.outcome.approvals += 1;
      return;
    case 'deny_once':
      args.gate.denyOnce.add(args.sessionKey);
      recordSilentRefusal(args.projectId, args.server.name, args.originPath, 'deny_once');
      args.outcome.refused.push({
        serverName: args.server.name,
        originPath: args.originPath,
        persisted: false,
      });
      return;
    case 'deny_remember':
      recordTrustDecision({
        serverName: args.server.name,
        originPath: args.originPath,
        binarySha: args.server.binarySha ?? null,
        decision: 'denied_remember',
      });
      args.outcome.persistedDenials += 1;
      args.outcome.refused.push({
        serverName: args.server.name,
        originPath: args.originPath,
        persisted: true,
      });
      return;
    default: {
      const _exhaustive: never = args.decision;
      void _exhaustive;
      return;
    }
  }
}

/**
 * Append a `mcp.trust_silent_refusal` row to safety_audit. Called every time
 * the gate decides NOT to prompt because a prior decision (denied_remember)
 * or per-session deny_once already covers this server. The chain entry is
 * how XCT-1 forensics later reconstructs "the operator denied this server
 * but the binary still ran" — Phase 4b can't prevent the spawn, but the
 * audit row makes the gap visible to the inspector.
 */
function recordSilentRefusal(
  projectId: number,
  serverName: string,
  originPath: string,
  reasonCode: 'denied_remember' | 'deny_once',
): void {
  appendSafetyAudit({
    ts: Date.now(),
    kind: 'mcp.trust_silent_refusal',
    reasonCode,
    payload: { projectId, serverName, originPath },
  });
}
