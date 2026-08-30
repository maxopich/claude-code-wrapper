import { randomUUID } from 'node:crypto';
import type { ServerMsg, McpServerView } from '@cebab/shared/protocol';
import { abandonPendingGates, MAX_PENDING_GATES } from '../gate_abandon.js';
import { listForServer, previousDeclaration, recordTrustDecision } from './mcp_trust.js';
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
//   - trust='script_changed'     → emit `script_changed` pending + await decision
//   - trust='unknown' (no path)  → silent (no anchor; same as cebab-injected)
//
// The "block" is structural: `awaitMcpTrustDecisions` returns a Promise that
// resolves only when EVERY parked pending has been answered. The caller
// (start_multi_agent / runOneTurn) awaits before calling pickRunner so the
// spawn cannot race a decision.
//
// Register H04 (2026-08-02): a denial now STOPS THE BINARY. This block used to
// say Cebab could not "surgically prevent a single project-declared MCP from
// loading" and filed it as "future work (Phase 5+): …get an SDK option for
// per-server disable." That option exists as of SDK 0.3.201, so the gate no
// longer just records denials — `refused` below is returned to the caller,
// which hands it to the spawn as `settings.deniedMcpServers` (measured: the
// server is absent from `mcp_servers` entirely, the process never starts) plus
// `disallowedTools: mcp__<name>__*` as a second layer. Nothing is written to
// disk; the denial rides the SDK's inline flag-settings layer.
//
// What the gate guarantees:
//   - The operator sees first_seen / hash_changed BEFORE the run begins.
//   - Every decision is dual-written to mcp_trust + safety_audit (BE-1).
//   - A refusal is ENFORCED on the spawn it gated, not merely logged.
//   - Per-session deny_once is honored for THIS connection's subsequent
//     start_session calls (re-prompts on the next connection).

/**
 * Per-connection gate state. Lives on the `Conn` (in ws/server.ts), and the
 * `ws.on('close')` handler calls `abandonPendingMcpGates` on it so a parked
 * decision does not outlive the operator who was asked for it.
 *
 * Register B20: that used to read "the pending Map clears on disconnect (the
 * operator's parked decisions die with their session)". It did not. Dropping
 * the `Conn` reference does not settle a promise — the awaiting spawn stayed
 * suspended forever and kept the whole `Conn` alive through its own async
 * frame. The drain is now explicit; see `gate_abandon.ts` for why it rejects
 * instead of resolving.
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
  /**
   * Register B20: the parked promise's `reject`. Used only by
   * `abandonPendingMcpGates` when the operator's connection goes away.
   * Deliberately separate from `resolve`, which carries a DECISION and runs
   * `applyDecision` — persisting a choice nobody made.
   */
  abandon: (err: Error) => void;
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
export type GateResult = {
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
 * Returns a `GateResult` summarizing the pass (for logging / tests).
 *
 * No exception path: if the operator never replies, the promise hangs. The
 * caller (ws/server.ts) holds the await inside its `try/catch` for
 * start_multi_agent / runOneTurn; a WS disconnect upstream (which kills
 * `conn.trustGate`) is the only way out. That's intentional — the spec's
 * gate-and-block contract is "the spawn does not happen until the operator
 * decides," not "timeout after N seconds and proceed."
 */
export async function awaitMcpTrustDecisions(input: AwaitGateInput): Promise<GateResult> {
  const outcome: GateResult = { approvals: 0, persistedDenials: 0, refused: [] };
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
      case 'declaration_changed':
      case 'script_changed':
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
    const reason: 'first_seen' | 'hash_changed' | 'declaration_changed' | 'script_changed' =
      server.trust === 'hash_changed'
        ? 'hash_changed'
        : server.trust === 'declaration_changed'
          ? 'declaration_changed'
          : server.trust === 'script_changed'
            ? 'script_changed'
            : 'first_seen';
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
    // Cebab-rxg: same idea one level up. For a changed DECLARATION the useful
    // comparison is the program itself, not its hash — the reproduced attack
    // swapped `node <script>` for another script and never moved a hash at
    // all, because a bare command has none.
    let previousCommand: string | undefined;
    let previousArgs: string[] | undefined;
    if (reason === 'declaration_changed') {
      const prior = previousDeclaration(server.name, originPath);
      if (prior) {
        previousCommand = prior.command;
        previousArgs = prior.args;
      }
    }

    // Cebab-1af: the declaration is identical on both sides of a
    // `script_changed`, so a before/after of the declaration would show the
    // operator two identical lines. The files are the entire difference, and
    // the resolver already worked out which ones.
    const changedScripts = reason === 'script_changed' ? server.scriptChanges : undefined;

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
      ...(previousCommand !== undefined ? { previousCommand } : {}),
      ...(previousArgs !== undefined ? { previousArgs } : {}),
      ...(changedScripts && changedScripts.length > 0 ? { changedScripts } : {}),
    };

    // H15: fail closed rather than park an unbounded number of decisions.
    if (input.gate.pending.size >= MAX_PENDING_GATES) {
      console.warn(
        `[mcp-gate] refusing ${server.name}: ${MAX_PENDING_GATES} decisions already parked on this connection`,
      );
      applyDecision({
        projectId: input.projectId,
        gate: input.gate,
        server,
        originPath,
        decision: { kind: 'deny_once' },
        outcome,
        sessionKey,
      });
      continue;
    }

    const spawnPromise = new Promise<void>((resolveSpawn, rejectSpawn) => {
      input.gate.pending.set(pendingId, {
        pendingId,
        serverName: server.name,
        originPath,
        abandon: rejectSpawn,
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

/**
 * Cebab-ygu.6 / Cebab-ygu.17 [security]: the names a PROBE must not start.
 *
 * The authority probe is a real spawn — it exists to read
 * `system/init.mcp_servers`, and that field only exists because the CLI
 * actually tried to start each server — but it cannot prompt. Since
 * `Cebab-ws0.7` it fires ~400ms after the operator lands on a project, so a
 * TOFU modal here would mean arrowing down a sidebar throws dialogs. And it
 * ran ungated: a server the operator answered "Deny & remember" to was started
 * anyway, and a `pending_tofu` server ran before they were ever asked.
 *
 * So the rule is the strict one, and it is deliberately stricter than the
 * gate's: **a probe starts only what is already trusted.** Everything else —
 * `denied`, `pending_tofu`, `hash_changed`, `declaration_changed`,
 * `script_changed` — is refused. That list is prose; the CODE is a whitelist of
 * one, which is why `Cebab-1af` added a sixth state without touching this
 * function. A blacklist would have needed an edit here and would have started
 * the new state silently if it did not get one.
 * `deny_once` needs no case of its own: it only ever arises from a prompt,
 * which only fires when a server is not trusted, so the rule already covers it.
 *
 * The audit obligation is the gate's, not a new one. A `denied` server is a
 * standing operator decision being ENFORCED, which is exactly what
 * `mcp.trust_silent_refusal` records, so this writes the same row the gated
 * path writes. A `pending_tofu` server is not a decision — nothing was
 * refused, the operator has simply never been asked — and a row per sidebar
 * navigation would be noise in a hash chain that exists to be read.
 *
 * Returns names, so this can only refuse a server the resolver can SEE. A
 * declaration Cebab cannot attribute is still started; that is the same limit
 * `awaitMcpTrustDecisions` has (it skips rows with no `originPath` for the
 * same structural reason), not a gap this function introduces.
 */
export function refuseUnapprovedForProbe(
  projectId: number,
  servers: readonly McpServerView[],
): string[] {
  const refused: string[] = [];
  for (const server of servers) {
    // Both skips mirror `awaitMcpTrustDecisions`: Cebab pins its own injected
    // servers, and a row with no origin has no anchor for a decision.
    if (server.scope === 'cebab-injected') continue;
    if (!server.originPath) continue;
    if (server.trust === 'trusted') continue;
    refused.push(server.name);
    if (server.trust === 'denied') {
      recordSilentRefusal(projectId, server.name, server.originPath, 'denied_remember');
    }
  }
  return refused;
}

/**
 * Register B20: reject every MCP decision still parked on this connection.
 * Called from `ws.on('close')`. Returns how many were released.
 *
 * The awaiting `awaitMcpTrustDecisions` throws, which propagates out of
 * `gateProjectsForSpawn` and abandons the spawn — the correct outcome, since
 * the operator who was being asked has gone.
 */
export function abandonPendingMcpGates(gate: TrustGateState, reason: string): number {
  return abandonPendingGates(gate.pending, 'mcp-trust', reason);
}

// ---- internals ----

function applyDecision(args: {
  projectId: number;
  gate: TrustGateState;
  server: McpServerView;
  originPath: string;
  decision: TrustGateOutcome;
  outcome: GateResult;
  sessionKey: string;
}): void {
  switch (args.decision.kind) {
    case 'allow':
      recordTrustDecision({
        serverName: args.server.name,
        originPath: args.originPath,
        // Cebab-rxg: record WHAT was approved. Without these two the row
        // matches any future declaration under the same name.
        command: args.server.config?.command ?? '',
        args: args.server.config?.args ?? [],
        binarySha: args.server.binarySha ?? null,
        // Cebab-1af: record WHICH BYTES were approved, not just which program
        // was named. The row this writes is the baseline every later spawn is
        // compared against.
        scriptShas: args.server.scriptShas ?? null,
        decision: 'trusted',
      });
      args.outcome.approvals += 1;
      return;
    case 'allow_pinned':
      recordTrustDecision({
        serverName: args.server.name,
        originPath: args.originPath,
        command: args.server.config?.command ?? '',
        args: args.server.config?.args ?? [],
        binarySha: args.decision.binarySha,
        scriptShas: args.server.scriptShas ?? null,
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
        command: args.server.config?.command ?? '',
        args: args.server.config?.args ?? [],
        binarySha: args.server.binarySha ?? null,
        scriptShas: args.server.scriptShas ?? null,
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
 * What Cebab does to a refused server, recorded on every refusal row.
 * Mirrors `runner/claude.ts`'s `mcpDenialOptions`: the server is blocked from
 * loading via `settings.deniedMcpServers` and its tools are stripped via
 * `disallowedTools`.
 */
const ENFORCEMENT = 'denied_mcp_servers+disallowed_tools';

/**
 * Append a `mcp.trust_silent_refusal` row to safety_audit. Called every time
 * the gate decides NOT to prompt because a prior decision (denied_remember)
 * or per-session deny_once already covers this server.
 *
 * The row used to exist because the refusal could not be acted on — it made
 * "the operator denied this server but the binary still ran" visible to the
 * inspector after the fact. Since H04 the refusal IS acted on, so the payload
 * carries `enforcement` to say which of those two worlds a given row belongs
 * to. Rows written before that change have no `enforcement` key, which is
 * itself the honest signal: absent means the spawn went ahead anyway.
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
    payload: { projectId, serverName, originPath, enforcement: ENFORCEMENT },
  });
}
