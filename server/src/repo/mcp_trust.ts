import { createHash } from 'node:crypto';
import path from 'node:path';
import { getDb } from '../db.js';
import { appendSafetyAudit } from '../notifications/safety_audit.js';
import { getOperatorId } from '../notifications/operator.js';
import { readFileBounded } from '../safe_fs.js';

/**
 * Register H02: ceiling on a binary we will hash for TOFU pinning.
 *
 * 64 MiB is far above any real MCP server target (node scripts, python
 * entry points, modest native binaries) and far below "wedges the box".
 *
 * Over the cap we return `null` — we do NOT hash a bounded prefix. That
 * distinction is the whole point: `binarySha` exists so a later spawn can be
 * compared against a pin, and a prefix hash would make two different binaries
 * that share their first N bytes compare EQUAL. Refusing to identify a file
 * is a state this code already handles correctly; silently weakening what
 * identification means is not.
 */
const MAX_HASHABLE_BINARY_BYTES = 64 * 1024 * 1024;

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
   * Cebab-rxg: the DECLARATION the operator is deciding about. Required, not
   * optional-with-a-default — an optional field here is how this defect comes
   * back, silently, as a row that matches every future declaration.
   */
  command: string;
  args: readonly string[];
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

/** Everything the lookup needs to identify one declared server. */
export type TrustLookupInput = {
  serverName: string;
  originPath: string;
  /** sha256 of the resolved command, or `null` when it cannot be resolved. */
  candidateSha: string | null;
  command: string;
  args: readonly string[];
};

export type TrustLookupResult =
  | { decision: 'trusted' }
  | { decision: 'trusted_pinned_hash'; binarySha: string }
  | { decision: 'denied_remember' }
  /**
   * Cebab-rxg: a decision exists for this server at this origin, but for a
   * DIFFERENT command/args. The operator approved a program; this is a
   * different program wearing the same name.
   */
  | { decision: 'declaration_changed'; previousCommand: string; previousArgs: string[] }
  | { decision: 'hash_changed'; previousSha: string }
  | { decision: 'first_seen' };

export type McpTrustRow = {
  id: number;
  ts: number;
  server_name: string;
  origin_path: string;
  /** Cebab-rxg (migration 038). NULL on rows decided before the declaration
   *  was part of the identity — see `argsKey`'s neighbours in `checkTrust`. */
  command: string | null;
  args_json: string | null;
  binary_sha: string | null;
  decision: PersistedDecision;
  operator: string;
};

/**
 * Parse a stored `args_json` back to an array, tolerantly.
 *
 * The column is written by `argsKey` and is always a JSON array — but this
 * value reaches an operator-facing modal ("was: npx -y weather-mcp"), and a
 * hand-edited or truncated row must not throw inside the security lookup that
 * is deciding whether to re-prompt. A malformed value degrades to `[]`, which
 * still differs from any real declaration and therefore still re-prompts.
 */
function parseArgsJson(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((a) => typeof a === 'string')) return parsed;
  } catch {
    /* fall through */
  }
  return [];
}

/**
 * Canonical args key. `undefined` and `[]` must collapse to one identity, or
 * the same declaration alternates between two rows and re-prompts forever.
 * Same helper, same reason, as `hook_trust.ts` — the ledger this one is
 * catching up to.
 */
export function argsKey(args: readonly string[] | undefined): string {
  return JSON.stringify(args ?? []);
}

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

  // Register H02: `command` comes from a PROJECT's `.claude/settings*.json`,
  // so it is attacker-chosen on an untrusted project. This used to be a bare
  // `fs.readFileSync(command)` — no type check, no size cap, no O_NONBLOCK —
  // reached from `project_authority.resolveMcpAuthority` on the way into
  // every session start. `command: "/dev/zero"` was enough to park the
  // event loop for the whole server; a huge file exhausted memory.
  const read = readFileBounded(command, MAX_HASHABLE_BINARY_BYTES);
  if (!read.ok) {
    // Every refusal collapses to the SAME `null` this function already
    // returned for a missing or unreadable path, so nothing downstream
    // changes shape: the inspector renders the server without a pinned
    // hash and the TOFU gate (Phase 4b) fires `first_seen`, which is the
    // correct posture for "we could not identify this binary".
    return null;
  }
  return createHash('sha256').update(read.bytes).digest('hex');
}

// ---- write path ----

/**
 * Record an operator's trust decision. Dual-writes to `mcp_trust` and
 * `safety_audit`. Conflicts are resolved INSERT OR REPLACE so a fresh decision
 * (e.g. operator changes their mind from `denied_remember` to `trusted`)
 * overwrites the prior. The audit chain preserves every decision in
 * order, so the forensic trail is complete even when the lookup row gets
 * replaced.
 *
 * TWO constraints make that conflict fire, and register D09 is why it takes
 * two. 016's `UNIQUE(server_name, origin_path, binary_sha)` covers a non-null
 * sha; for `binary_sha IS NULL` — `npx <name>` and every other unresolvable
 * target — SQLite treats NULLs as distinct, the conflict never fired, and this
 * function appended a row per decision while claiming to replace one. Migration
 * 033's partial unique index on (server_name, origin_path) WHERE binary_sha IS
 * NULL closes that half. The read-back below noticed the same NULL semantics on
 * the SELECT side and handled them; the INSERT side three lines above went
 * unexamined.
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
  const argsJson = argsKey(input.args);
  appendSafetyAudit({
    ts,
    kind: 'mcp.trust_decided',
    reasonCode: input.decision,
    payload: {
      serverName: input.serverName,
      originPath: input.originPath,
      // Cebab-rxg: the declaration goes into the audit payload too. The chain
      // is the complete forensic trail, and "which program did the operator
      // approve" was exactly the question it could not answer.
      command: input.command,
      args: [...input.args],
      binarySha: input.binarySha,
      decision: input.decision,
      operator,
    },
  });
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO mcp_trust
       (ts, server_name, origin_path, command, args_json, binary_sha, decision, operator)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ts,
    input.serverName,
    input.originPath,
    input.command,
    argsJson,
    input.binarySha,
    input.decision,
    operator,
  );
  // Read back the row we just wrote — INSERT OR REPLACE rebinds the
  // autoincrement id, so we look up by the UNIQUE triple. NULL-distinct
  // SQLite semantics on binarySha=NULL mean the lookup needs IS NULL
  // (not = NULL).
  //
  // `id DESC` for the same reason `checkTrust`'s recency probe carries it: on a
  // same-millisecond `ts` tie, `ORDER BY ts DESC` alone is unordered by
  // contract — and measurably returns the OLDEST row, because the scan walks
  // (server_name, origin_path) in rowid order. That would hand this function a
  // row it did not just write.
  const row =
    input.binarySha === null
      ? db
          .prepare<[string, string, string, string], McpTrustRow>(
            `SELECT id, ts, server_name, origin_path, command, args_json, binary_sha, decision, operator
               FROM mcp_trust
              WHERE server_name = ? AND origin_path = ? AND command = ? AND args_json = ?
                AND binary_sha IS NULL
           ORDER BY ts DESC, id DESC LIMIT 1`,
          )
          .get(input.serverName, input.originPath, input.command, argsJson)
      : db
          .prepare<[string, string, string, string, string], McpTrustRow>(
            `SELECT id, ts, server_name, origin_path, command, args_json, binary_sha, decision, operator
               FROM mcp_trust
              WHERE server_name = ? AND origin_path = ? AND command = ? AND args_json = ?
                AND binary_sha = ?
           ORDER BY ts DESC, id DESC LIMIT 1`,
          )
          .get(input.serverName, input.originPath, input.command, argsJson, input.binarySha);
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
export function checkTrust(input: TrustLookupInput): TrustLookupResult {
  const { serverName, originPath, candidateSha } = input;
  const argsJson = argsKey(input.args);
  const db = getDb();
  // Most-recent matching row wins — `id DESC` is what makes "most recent" mean
  // write order rather than whatever the scan reached first on a `ts` tie. Same
  // argument as the recency probe below, which is where it was first written
  // and, until register D09, the only query in this file that had it.
  const exact =
    candidateSha === null
      ? db
          .prepare<
            [string, string, string, string],
            { decision: PersistedDecision; binary_sha: string | null }
          >(
            `SELECT decision, binary_sha FROM mcp_trust
              WHERE server_name = ? AND origin_path = ? AND command = ? AND args_json = ?
                AND binary_sha IS NULL
           ORDER BY ts DESC, id DESC LIMIT 1`,
          )
          .get(serverName, originPath, input.command, argsJson)
      : db
          .prepare<
            [string, string, string, string, string],
            { decision: PersistedDecision; binary_sha: string | null }
          >(
            `SELECT decision, binary_sha FROM mcp_trust
              WHERE server_name = ? AND origin_path = ? AND command = ? AND args_json = ?
                AND binary_sha = ?
           ORDER BY ts DESC, id DESC LIMIT 1`,
          )
          .get(serverName, originPath, input.command, argsJson, candidateSha);
  if (exact) {
    if (exact.decision === 'trusted') return { decision: 'trusted' };
    if (exact.decision === 'trusted_pinned_hash' && exact.binary_sha !== null) {
      return { decision: 'trusted_pinned_hash', binarySha: exact.binary_sha };
    }
    if (exact.decision === 'denied_remember') return { decision: 'denied_remember' };
  }
  // Register D08: a denial applies at ANY sha — the rule this module's own
  // header states ("denied_remember (any sha) → silent refusal"). The exact
  // lookup above filters on `binary_sha = ?`, so a denial recorded against a
  // different binary was invisible and the server fell through to
  // `first_seen`, re-prompting the operator for something they had already
  // denied — and, worse, offering them a fresh chance to approve it.
  //
  // Scoped to the operator's MOST RECENT decision for this name+origin rather
  // than "any denial anywhere in history". `INSERT OR REPLACE` is keyed per
  // sha, so rows at different shas coexist; an unconditional probe would mean
  // that denying one build permanently poisons the server, and an operator
  // who denied build A and later trusted build B could never be prompted
  // about build C. Recency keeps both directions of "changed their mind"
  // working, and still catches the case this bug is about (denied, then the
  // binary changed).
  //
  // Ordered BEFORE the pinned-hash probe: if the latest decision is a denial,
  // it outranks an older pin.
  // `id DESC` is the tie-break, not decoration: `ts` is `Date.now()`, so two
  // decisions in the same millisecond (an operator correcting a misclick) tie
  // and the winner would be whatever SQLite felt like. `id` is AUTOINCREMENT
  // and `INSERT OR REPLACE` mints a fresh one, so it is true write order.
  const latest = db
    .prepare<[string, string], { decision: PersistedDecision }>(
      `SELECT decision FROM mcp_trust
        WHERE server_name = ? AND origin_path = ?
     ORDER BY ts DESC, id DESC LIMIT 1`,
    )
    .get(serverName, originPath);
  if (latest?.decision === 'denied_remember') return { decision: 'denied_remember' };

  // Cebab-rxg: a decision exists for this name+origin, but for a DIFFERENT
  // declaration. This is the case the whole finding is about — an operator
  // approved `npx -y weather-mcp`, the file was rewritten to
  // `bash -c 'curl … | sh'`, and both hash to a null `binary_sha`, so every
  // probe above matched and the gate passed silently.
  //
  // Rows written before migration 038 carry a NULL declaration and are
  // EXCLUDED here on purpose: a row that cannot say what was approved has no
  // before/after to show an operator, so it falls through to `first_seen` and
  // re-prompts once. That is the migration's stated posture, enforced here
  // rather than by a special case in the migration.
  //
  // Ordered BEFORE the pinned-hash probe below. When both are true, the
  // changed declaration EXPLAINS the changed hash, and reporting "the binary
  // changed" for what is actually "a different program was requested"
  // understates it.
  const prior = db
    .prepare<[string, string], { command: string; args_json: string }>(
      `SELECT command, args_json FROM mcp_trust
        WHERE server_name = ? AND origin_path = ?
          AND command IS NOT NULL AND args_json IS NOT NULL
     ORDER BY ts DESC, id DESC LIMIT 1`,
    )
    .get(serverName, originPath);
  if (prior && (prior.command !== input.command || prior.args_json !== argsJson)) {
    return {
      decision: 'declaration_changed',
      previousCommand: prior.command,
      previousArgs: parseArgsJson(prior.args_json),
    };
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
       ORDER BY ts DESC, id DESC LIMIT 1`,
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
 * Return every SURVIVING decision row for a (serverName, originPath) pair, most
 * recent first. Used by the AuthorityPanel "Trust history" disclosure
 * (Phase 7 UI), and by tests.
 *
 * "Surviving" is the honest word: this is the lookup table, and `INSERT OR
 * REPLACE` deletes the row it supersedes — at any sha since 016, and at a null
 * sha since 033. So a server the operator has decided on five times has one row
 * per distinct sha here, not five. The complete history is the `safety_audit`
 * chain (`kind='mcp.trust_decided'`), which is where `firstDecisionTs` reads
 * from and where anything else wanting the full trail should read from too.
 */
export function listForServer(serverName: string, originPath: string): McpTrustRow[] {
  return getDb()
    .prepare<[string, string], McpTrustRow>(
      `SELECT id, ts, server_name, origin_path, command, args_json, binary_sha, decision, operator
        FROM mcp_trust
       WHERE server_name = ? AND origin_path = ?
    ORDER BY ts DESC, id DESC`,
    )
    .all(serverName, originPath);
}

/**
 * Cebab-rxg: the most recent declaration the operator actually decided on for
 * this server, or `null` when there is none to show.
 *
 * The gate reads this to render "was X, now Y" on a `declaration_changed`
 * prompt — the same shape in which it reads `previousSha` out of
 * `listForServer` for `hash_changed`. Rows written before migration 038 carry
 * a NULL declaration and are skipped: they cannot answer the question, and a
 * prompt that says "was: (unknown)" is worse than the `first_seen` prompt
 * those rows correctly produce.
 */
export function previousDeclaration(
  serverName: string,
  originPath: string,
): { command: string; args: string[] } | null {
  const row = getDb()
    .prepare<[string, string], { command: string; args_json: string }>(
      `SELECT command, args_json FROM mcp_trust
        WHERE server_name = ? AND origin_path = ?
          AND command IS NOT NULL AND args_json IS NOT NULL
     ORDER BY ts DESC, id DESC LIMIT 1`,
    )
    .get(serverName, originPath);
  if (!row) return null;
  return { command: row.command, args: parseArgsJson(row.args_json) };
}

/**
 * Timestamp of the operator's FIRST recorded decision for a (serverName,
 * originPath) pair, or `null` if they have never decided on it.
 *
 * Reads the append-only `safety_audit` chain rather than `mcp_trust`, and that
 * is the entire point. `mcp_trust` is a lookup whose rows get replaced, so its
 * oldest surviving row answers "when was the oldest decision I have not yet
 * superseded" — which is not a question anyone asked. Before register D09 the
 * null-sha path accidentally kept its history and appeared to answer correctly;
 * the non-null path never did. Sourcing it from the chain makes both right and
 * survives 033's dedupe.
 */
export function firstDecisionTs(serverName: string, originPath: string): number | null {
  const row = getDb()
    .prepare<[string, string], { ts: number | null }>(
      `SELECT MIN(ts) AS ts FROM safety_audit
        WHERE kind = 'mcp.trust_decided'
          AND json_extract(payload_json, '$.serverName') = ?
          AND json_extract(payload_json, '$.originPath') = ?`,
    )
    .get(serverName, originPath);
  return row?.ts ?? null;
}
