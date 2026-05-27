import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db.js';
import { appendSafetyAudit } from '../notifications/safety_audit.js';
import { getOperatorId } from '../notifications/operator.js';

// Cluster B Phase 4 (§4.4): TOFU repository for MCP server trust decisions.
//
// The table (`mcp_trust`, migration 016) is the lookup the spawn gate
// (Phase 4b) will consult before any MCP binary executes:
//
//   - trusted              + name+origin match    → silent, proceed
//   - trusted_pinned_hash  + name+origin+sha match → silent, proceed
//   - trusted_pinned_hash  + sha mismatch          → 'hash_changed' (gate fires)
//   - denied_remember      (any sha)               → silent refusal + safety audit
//   - no row                                       → 'first_seen' (gate fires)
//
// `deny_once` is intentionally NOT persisted — it lives in per-session
// in-memory state and expires at session end (per spec §4.4 footnote).
//
// Every persisted decision dual-writes to `safety_audit` with
// `kind='mcp.trust_decided'` so the operator's choice is forensically
// reconstructible (XCT-1 lineage).

// ---- types ----

export type PersistedDecision = 'trusted' | 'trusted_pinned_hash' | 'denied_remember';

export type TrustDecisionInput = {
  serverName: string;
  originPath: string;
  /**
   * sha256 of the resolved binary, or `null` for unresolvable targets
   * (e.g. `npx <name>`). `trusted_pinned_hash` MUST have a non-null
   * binarySha — the repository rejects the combination with a runtime
   * error (the protocol type layer should also gate this from the UI).
   */
  binarySha: string | null;
  decision: PersistedDecision;
  /** Defaults to `getOperatorId()` when absent — clients can't be trusted to report it. */
  operator?: string;
};

export type TrustLookupResult =
  | { decision: 'trusted' }
  | { decision: 'trusted_pinned_hash'; binarySha: string }
  | { decision: 'denied_remember' }
  | { decision: 'hash_changed'; previousSha: string }
  | { decision: 'first_seen' };

export type McpTrustRow = {
  id: number;
  ts: number;
  server_name: string;
  origin_path: string;
  binary_sha: string | null;
  decision: PersistedDecision;
  operator: string;
};

// ---- binary sha computation ----

/**
 * Compute sha256 of a resolved MCP server binary.
 *
 * Returns `null` for unresolvable targets:
 *   - Bare commands like `npx`, `node`, etc. (no absolute path → can't
 *     pin a hash; the binary that runs is whatever PATH lookup finds at
 *     spawn time, which can change between sessions).
 *   - Absolute paths that don't exist or aren't readable (don't surface
 *     a noisy I/O error; the resolver treats this as "unresolvable" so
 *     the inspector can still show the row, just without a pinned hash).
 *
 * `pending_tofu` / `hash_changed` states use `null` here to mean
 * "couldn't compute"; the gate UI greys out the Trust-pinned-hash
 * affordance because pinning a hash that can't be computed is
 * meaningless (a future spawn would always show `hash_changed`).
 */
export function computeBinarySha(command: string): string | null {
  if (!command) return null;
  // Heuristic for "absolute path that we can hash": starts with `/` on
  // POSIX or `<drive>:` on Windows. Bare commands like `npx`, `node`,
  // `python3` are deliberately treated as unresolvable.
  const isAbsolute = path.isAbsolute(command);
  if (!isAbsolute) return null;
  try {
    const bytes = fs.readFileSync(command);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    // File missing, permission denied, anything else — treat as
    // unresolvable. The inspector will render the server with binarySha
    // absent and the TOFU gate (Phase 4b) will fire a `first_seen` event
    // (the operator should investigate why the path doesn't resolve).
    return null;
  }
}

// ---- write path ----

/**
 * Record an operator's trust decision. Dual-writes to `mcp_trust` and
 * `safety_audit`. Conflicts on the UNIQUE(server_name, origin_path,
 * binary_sha) triple are resolved INSERT OR REPLACE so a fresh decision
 * (e.g. operator changes their mind from `denied_remember` to `trusted`)
 * overwrites the prior. The audit chain preserves every decision in
 * order, so the forensic trail is complete even when the lookup row gets
 * replaced.
 *
 * Per BE-1 invariant: the safety_audit append happens FIRST. If it
 * throws, the mcp_trust write is not attempted and the caller gets the
 * error — the AuthorityPanel will surface "decision didn't take" rather
 * than the operator believing their click stuck when it didn't.
 */
export function recordTrustDecision(input: TrustDecisionInput): McpTrustRow {
  if (input.decision === 'trusted_pinned_hash' && input.binarySha === null) {
    throw new Error(
      `recordTrustDecision: trusted_pinned_hash requires a non-null binarySha (server=${input.serverName})`,
    );
  }
  const operator = input.operator ?? getOperatorId();
  const ts = Date.now();
  // Order matters: safety audit MUST succeed before the trust write
  // lands. If the audit throws (chain broken, db error), the trust
  // decision is not recorded — operator sees the failure and can retry
  // with the chain repaired.
  appendSafetyAudit({
    ts,
    kind: 'mcp.trust_decided',
    reasonCode: input.decision,
    payload: {
      serverName: input.serverName,
      originPath: input.originPath,
      binarySha: input.binarySha,
      decision: input.decision,
      operator,
    },
  });
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO mcp_trust
       (ts, server_name, origin_path, binary_sha, decision, operator)
       VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(ts, input.serverName, input.originPath, input.binarySha, input.decision, operator);
  // Read back the row we just wrote — INSERT OR REPLACE rebinds the
  // autoincrement id, so we look up by the UNIQUE triple. NULL-distinct
  // SQLite semantics on binarySha=NULL mean the lookup needs IS NULL
  // (not = NULL).
  const row =
    input.binarySha === null
      ? db
          .prepare<[string, string], McpTrustRow>(
            `SELECT id, ts, server_name, origin_path, binary_sha, decision, operator
               FROM mcp_trust
              WHERE server_name = ? AND origin_path = ? AND binary_sha IS NULL
           ORDER BY ts DESC LIMIT 1`,
          )
          .get(input.serverName, input.originPath)
      : db
          .prepare<[string, string, string], McpTrustRow>(
            `SELECT id, ts, server_name, origin_path, binary_sha, decision, operator
               FROM mcp_trust
              WHERE server_name = ? AND origin_path = ? AND binary_sha = ?
           ORDER BY ts DESC LIMIT 1`,
          )
          .get(input.serverName, input.originPath, input.binarySha);
  if (!row) {
    // Sanity check — we just inserted; the lookup MUST find it.
    throw new Error('recordTrustDecision: row not found after INSERT OR REPLACE');
  }
  return row;
}

// ---- read path ----

/**
 * Look up the current trust state for a (serverName, originPath,
 * binarySha) tuple. Implements the spec §4.4 decision table.
 *
 * `hash_changed` fires only when a `trusted_pinned_hash` row exists for
 * the same name+origin but with a DIFFERENT sha. A `trusted` (unpinned)
 * row doesn't care about sha changes — that's the whole point of the
 * unpinned variant.
 *
 * No `hash_changed` if the candidate sha is null (unresolvable target).
 * In that case the spec's contract says we fall back to `first_seen`
 * because there's nothing meaningful to compare.
 */
export function checkTrust(
  serverName: string,
  originPath: string,
  candidateSha: string | null,
): TrustLookupResult {
  const db = getDb();
  // Most-recent matching row wins.
  const exact =
    candidateSha === null
      ? db
          .prepare<[string, string], { decision: PersistedDecision; binary_sha: string | null }>(
            `SELECT decision, binary_sha FROM mcp_trust
              WHERE server_name = ? AND origin_path = ? AND binary_sha IS NULL
           ORDER BY ts DESC LIMIT 1`,
          )
          .get(serverName, originPath)
      : db
          .prepare<
            [string, string, string],
            { decision: PersistedDecision; binary_sha: string | null }
          >(
            `SELECT decision, binary_sha FROM mcp_trust
              WHERE server_name = ? AND origin_path = ? AND binary_sha = ?
           ORDER BY ts DESC LIMIT 1`,
          )
          .get(serverName, originPath, candidateSha);
  if (exact) {
    if (exact.decision === 'trusted') return { decision: 'trusted' };
    if (exact.decision === 'trusted_pinned_hash' && exact.binary_sha !== null) {
      return { decision: 'trusted_pinned_hash', binarySha: exact.binary_sha };
    }
    if (exact.decision === 'denied_remember') return { decision: 'denied_remember' };
  }
  // No exact match — check for a pinned-hash row at the same name+origin
  // with a DIFFERENT sha. Only triggers when the candidate sha is real
  // (null candidates can't meaningfully mismatch).
  if (candidateSha !== null) {
    const pinned = db
      .prepare<[string, string], { binary_sha: string }>(
        `SELECT binary_sha FROM mcp_trust
          WHERE server_name = ? AND origin_path = ?
            AND decision = 'trusted_pinned_hash' AND binary_sha IS NOT NULL
       ORDER BY ts DESC LIMIT 1`,
      )
      .get(serverName, originPath);
    if (pinned && pinned.binary_sha !== candidateSha) {
      return { decision: 'hash_changed', previousSha: pinned.binary_sha };
    }
  }
  // Default: never seen this server-at-origin OR fall-through (sha
  // mismatch on unpinned row, etc.).
  return { decision: 'first_seen' };
}

/**
 * Return every decision row for a (serverName, originPath) pair, most
 * recent first. Used by the AuthorityPanel "Trust history" disclosure
 * (Phase 7 UI), and by tests.
 */
export function listForServer(serverName: string, originPath: string): McpTrustRow[] {
  return getDb()
    .prepare<[string, string], McpTrustRow>(
      `SELECT id, ts, server_name, origin_path, binary_sha, decision, operator
        FROM mcp_trust
       WHERE server_name = ? AND origin_path = ?
    ORDER BY ts DESC`,
    )
    .all(serverName, originPath);
}
