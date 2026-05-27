import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { closeDb, getDb } from '../db.js';
import { config } from '../config.js';
import { _resetOperatorIdCache } from '../notifications/operator.js';
import { checkTrust, computeBinarySha, listForServer, recordTrustDecision } from './mcp_trust.js';
import * as safetyAudit from '../notifications/safety_audit.js';

// Cluster B Phase 4 (§4.4): TOFU repository tests cover:
//   - computeBinarySha: real-file sha vs unresolvable (npx, missing, bare cmd)
//   - recordTrustDecision: dual-write (mcp_trust + safety_audit), atomicity
//     when the audit append throws, INSERT-OR-REPLACE on conflict
//   - checkTrust: spec §4.4 decision table — trusted / trusted_pinned_hash /
//     denied_remember / hash_changed / first_seen
//   - listForServer: history ordering for AuthorityPanel disclosure
//
// All tests scaffold an isolated DB so they can mutate safety_audit and
// mcp_trust independently.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mcp-trust-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  _resetOperatorIdCache();
  getDb(); // applies migrations 001..016
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  config.dataDir = originalDataDir;
  _resetOperatorIdCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---- computeBinarySha ----

describe('computeBinarySha — resolvable vs unresolvable targets', () => {
  test('sha256 of an existing absolute-path file matches a manual hash', () => {
    const filePath = path.join(tmpRoot, 'fake-binary');
    const contents = Buffer.from('binary contents');
    fs.writeFileSync(filePath, contents);
    const expected = createHash('sha256').update(contents).digest('hex');
    expect(computeBinarySha(filePath)).toBe(expected);
  });

  test('bare command (no absolute path) returns null — unresolvable', () => {
    // The actual binary that runs depends on PATH lookup at spawn time,
    // which can change between sessions. Pinning is meaningless.
    expect(computeBinarySha('npx')).toBeNull();
    expect(computeBinarySha('node')).toBeNull();
    expect(computeBinarySha('python3')).toBeNull();
  });

  test('absolute path to a non-existent file returns null (no throw)', () => {
    // Operator might declare an MCP server with a stale path; the
    // resolver should still surface the row (the AuthorityPanel will
    // render "binary unresolvable") rather than crashing the whole
    // get_project_authority response.
    expect(computeBinarySha('/this/does/not/exist/binary')).toBeNull();
  });

  test('empty string command returns null', () => {
    expect(computeBinarySha('')).toBeNull();
  });
});

// ---- recordTrustDecision ----

describe('recordTrustDecision — dual-write contract', () => {
  test('persists row in mcp_trust with the requested decision', () => {
    const row = recordTrustDecision({
      serverName: 'svr',
      originPath: '/p/settings.json',
      binarySha: 'sha-1',
      decision: 'trusted',
    });
    expect(row).toMatchObject({
      server_name: 'svr',
      origin_path: '/p/settings.json',
      binary_sha: 'sha-1',
      decision: 'trusted',
    });
    // operator resolved via getOperatorId() (non-empty fallback works).
    expect(typeof row.operator).toBe('string');
    expect(row.operator.length).toBeGreaterThan(0);
  });

  test('also writes a safety_audit row with kind=mcp.trust_decided', () => {
    recordTrustDecision({
      serverName: 'svr',
      originPath: '/p/settings.json',
      binarySha: 'sha-x',
      decision: 'trusted_pinned_hash',
    });
    const audit = getDb()
      .prepare<
        [],
        { kind: string; reason_code: string; payload_json: string }
      >(`SELECT kind, reason_code, payload_json FROM safety_audit WHERE kind = 'mcp.trust_decided'`)
      .all();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      kind: 'mcp.trust_decided',
      reason_code: 'trusted_pinned_hash',
    });
    const payload = JSON.parse(audit[0].payload_json);
    expect(payload).toMatchObject({
      serverName: 'svr',
      originPath: '/p/settings.json',
      binarySha: 'sha-x',
      decision: 'trusted_pinned_hash',
    });
  });

  test('[security] BE-1 contract: safety_audit failure leaves mcp_trust untouched', () => {
    // The dispatcher invariant from Cluster A says safety_audit MUST
    // succeed before the operator-facing effect lands. Same contract
    // applies here: if the audit chain is broken (or any append throws),
    // the trust decision must NOT be recorded — the operator's screen
    // should reflect the failure rather than them believing their click
    // stuck.
    const spy = vi.spyOn(safetyAudit, 'appendSafetyAudit').mockImplementation(() => {
      throw new Error('audit_write_failed');
    });
    expect(() =>
      recordTrustDecision({
        serverName: 'svr',
        originPath: '/p/settings.json',
        binarySha: 'sha-1',
        decision: 'trusted',
      }),
    ).toThrowError(/audit_write_failed/);
    // mcp_trust row count must be exactly 0.
    const count = getDb().prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM mcp_trust`).get();
    expect(count?.n).toBe(0);
    spy.mockRestore();
  });

  test('trusted_pinned_hash rejects null binarySha with a clear error', () => {
    // The protocol type and the WS handler should both gate this, but
    // the repository is the last line of defense — a NULL pinned hash
    // is structurally meaningless.
    expect(() =>
      recordTrustDecision({
        serverName: 'svr',
        originPath: '/p/settings.json',
        binarySha: null,
        decision: 'trusted_pinned_hash',
      }),
    ).toThrowError(/trusted_pinned_hash requires a non-null binarySha/);
  });

  test('INSERT OR REPLACE on conflict: same (name, origin, sha) triple overwrites prior decision', () => {
    recordTrustDecision({
      serverName: 'svr',
      originPath: '/p/settings.json',
      binarySha: 'sha-1',
      decision: 'trusted',
    });
    recordTrustDecision({
      serverName: 'svr',
      originPath: '/p/settings.json',
      binarySha: 'sha-1',
      decision: 'denied_remember',
    });
    const rows = listForServer('svr', '/p/settings.json');
    // ONE row in mcp_trust (the conflict triple was replaced) but TWO
    // audit rows (the forensic trail preserves every decision).
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('denied_remember');
    const audits = getDb()
      .prepare<
        [],
        { reason_code: string }
      >(`SELECT reason_code FROM safety_audit WHERE kind = 'mcp.trust_decided' ORDER BY ts`)
      .all();
    expect(audits.map((a) => a.reason_code)).toEqual(['trusted', 'denied_remember']);
  });

  test('different binary_sha for same (name, origin) creates a distinct row (history preserved)', () => {
    recordTrustDecision({
      serverName: 'svr',
      originPath: '/p/settings.json',
      binarySha: 'sha-v1',
      decision: 'trusted_pinned_hash',
    });
    recordTrustDecision({
      serverName: 'svr',
      originPath: '/p/settings.json',
      binarySha: 'sha-v2',
      decision: 'denied_remember',
    });
    const rows = listForServer('svr', '/p/settings.json');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.binary_sha).sort()).toEqual(['sha-v1', 'sha-v2']);
  });
});

// ---- checkTrust ----

describe('checkTrust — spec §4.4 decision table', () => {
  test('no recorded row → first_seen', () => {
    expect(checkTrust('never-seen', '/p/settings.json', 'sha')).toEqual({
      decision: 'first_seen',
    });
  });

  test('exact match on trusted (unpinned) → trusted (any sha)', () => {
    recordTrustDecision({
      serverName: 'svr',
      originPath: '/p/settings.json',
      binarySha: 'old-sha',
      decision: 'trusted',
    });
    // Same sha → trusted
    expect(checkTrust('svr', '/p/settings.json', 'old-sha')).toEqual({ decision: 'trusted' });
    // Different sha — but the EXACT row matched on old-sha is trusted,
    // so a fresh-sha query falls through to first_seen (no pinned row
    // exists). The lookup is conservative: trusted-unpinned doesn't
    // implicitly trust other shas, but it also doesn't trigger
    // hash_changed (that's only for trusted_pinned_hash).
    expect(checkTrust('svr', '/p/settings.json', 'new-sha')).toEqual({ decision: 'first_seen' });
  });

  test('trusted_pinned_hash + sha match → trusted_pinned_hash (carries the pinned sha)', () => {
    recordTrustDecision({
      serverName: 'svr',
      originPath: '/p/settings.json',
      binarySha: 'pinned-sha',
      decision: 'trusted_pinned_hash',
    });
    expect(checkTrust('svr', '/p/settings.json', 'pinned-sha')).toEqual({
      decision: 'trusted_pinned_hash',
      binarySha: 'pinned-sha',
    });
  });

  test('trusted_pinned_hash + sha mismatch → hash_changed (carries the previous sha)', () => {
    recordTrustDecision({
      serverName: 'svr',
      originPath: '/p/settings.json',
      binarySha: 'old-pinned',
      decision: 'trusted_pinned_hash',
    });
    expect(checkTrust('svr', '/p/settings.json', 'new-incoming')).toEqual({
      decision: 'hash_changed',
      previousSha: 'old-pinned',
    });
  });

  test('denied_remember always wins regardless of sha (no future spawn)', () => {
    recordTrustDecision({
      serverName: 'svr',
      originPath: '/p/settings.json',
      binarySha: 'sha-1',
      decision: 'denied_remember',
    });
    expect(checkTrust('svr', '/p/settings.json', 'sha-1')).toEqual({ decision: 'denied_remember' });
  });

  test('null candidate sha (unresolvable target) never triggers hash_changed', () => {
    // The spec contract: if we can't compute a sha for the incoming
    // binary, we have nothing to compare against the pinned hash —
    // fall back to first_seen so the operator gets a fresh prompt.
    recordTrustDecision({
      serverName: 'svr',
      originPath: '/p/settings.json',
      binarySha: 'pinned-sha',
      decision: 'trusted_pinned_hash',
    });
    expect(checkTrust('svr', '/p/settings.json', null)).toEqual({ decision: 'first_seen' });
  });

  test('cross-origin: same server name at a different origin path does NOT match', () => {
    // A server with the same name in a sibling project's
    // .claude/settings.local.json is a different trust subject. Operators
    // trust per (name, origin, sha) — never just by name.
    recordTrustDecision({
      serverName: 'svr',
      originPath: '/p1/settings.json',
      binarySha: 'sha',
      decision: 'trusted',
    });
    expect(checkTrust('svr', '/p2/settings.json', 'sha')).toEqual({ decision: 'first_seen' });
  });

  test('most recent decision wins on the same triple (after INSERT OR REPLACE)', () => {
    recordTrustDecision({
      serverName: 'svr',
      originPath: '/p/settings.json',
      binarySha: 'sha',
      decision: 'trusted',
    });
    recordTrustDecision({
      serverName: 'svr',
      originPath: '/p/settings.json',
      binarySha: 'sha',
      decision: 'denied_remember',
    });
    expect(checkTrust('svr', '/p/settings.json', 'sha')).toEqual({ decision: 'denied_remember' });
  });
});

// ---- listForServer ----

describe('listForServer — history ordering', () => {
  test('returns rows in DESC ts order (most recent first)', async () => {
    recordTrustDecision({
      serverName: 'svr',
      originPath: '/p/settings.json',
      binarySha: 'sha-1',
      decision: 'trusted',
    });
    await new Promise((r) => setTimeout(r, 5)); // ensure distinct ts
    recordTrustDecision({
      serverName: 'svr',
      originPath: '/p/settings.json',
      binarySha: 'sha-2',
      decision: 'denied_remember',
    });
    const rows = listForServer('svr', '/p/settings.json');
    expect(rows).toHaveLength(2);
    expect(rows[0].binary_sha).toBe('sha-2'); // newest first
    expect(rows[1].binary_sha).toBe('sha-1');
  });

  test('returns empty when no decisions recorded', () => {
    expect(listForServer('nope', '/p/settings.json')).toEqual([]);
  });
});
