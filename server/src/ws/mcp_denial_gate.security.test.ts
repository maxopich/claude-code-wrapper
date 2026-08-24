import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { upsertProject, setProjectTrusted } from '../repo/projects.js';
import { recordTrustDecision } from '../repo/mcp_trust.js';
import { makeTrustGateState, denyOnceKey } from '../repo/mcp_trust_gate.js';
import { makeStartGateState } from '../repo/session_start_gate.js';
import { BUS_SETTING_SCOPES } from '../repo/project_authority.js';
import { gateProjectsForSpawn } from './server.js';

// [security] Register H04 + Cebab-x1n.6.22 — the seam where a Deny becomes
// binding.
//
// `gateProjectsForSpawn` used to return `void`. It computed a complete refusal
// list inside `awaitMcpTrustDecisions` (`outcome.refused`, written at four
// sites, read at NONE — grep confirmed zero consumers across server/, web/ and
// shared/) and dropped it on the floor. The operator clicked Deny, Cebab
// persisted the decision and wrote a hash-chained audit row saying so, and the
// SDK then loaded the binary anyway.
//
// These cases cover the join between the two halves of that fix:
//   - the gate can now SEE a `.mcp.json` server at all (before, it scanned
//     only `mcpServers` in `.claude/settings*.json` — a key the CLI does not
//     load MCP servers from at any scope, measured against SDK 0.3.201), and
//   - a refusal comes back OUT of the gate so the caller can hand it to the
//     spawn as `settings.deniedMcpServers` + `disallowedTools`.
//
// Both are required. Enforcement with no detection denies nothing real;
// detection with no enforcement is the defect this replaces.

let tmpRoot: string;
let projectDir: string;
let originalDataDir: string;
let projectId: number;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mcp-denial-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  projectDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  projectId = upsertProject('proj', projectDir).id;
  setProjectTrusted(projectId, true);
});

afterEach(() => {
  // closeDb before rm: Windows cannot unlink an open SQLite file.
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeMcpJson(servers: Record<string, unknown>): void {
  fs.writeFileSync(path.join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
}

function fakeConn(over: { trustGate?: ReturnType<typeof makeTrustGateState> } = {}) {
  return {
    // readyState 0 (CONNECTING) — `send` no-ops, so nothing needs a socket.
    ws: { readyState: 0 } as unknown as never,
    authorityCache: new Map(),
    trustGate: over.trustGate ?? makeTrustGateState(),
    startGate: makeStartGateState(),
  } as unknown as Parameters<typeof gateProjectsForSpawn>[0];
}

describe('[security] gateProjectsForSpawn returns denials the spawn can act on', () => {
  test('a previously denied .mcp.json server comes back as a denial', async () => {
    writeMcpJson({ evil: { command: '/bin/echo' } });
    recordTrustDecision({
      serverName: 'evil',
      // Cebab-rxg: the declaration is part of the identity now; it must match
      // the `.mcp.json` written above. (The denial would apply at ANY
      // declaration via register D08's recency probe — these say it plainly.)
      command: '/bin/echo',
      args: [],
      originPath: path.join(projectDir, '.mcp.json'),
      binarySha: null,
      decision: 'denied_remember',
    });

    const denials = await gateProjectsForSpawn(fakeConn(), [projectId], BUS_SETTING_SCOPES);

    // The whole point: the caller can now name the server it must block.
    expect(denials.get(projectId)).toEqual(['evil']);
  });

  test('a per-session deny_once also comes back', async () => {
    writeMcpJson({ evil: { command: '/bin/echo' } });
    const trustGate = makeTrustGateState();
    trustGate.denyOnce.add(denyOnceKey(projectId, 'evil', path.join(projectDir, '.mcp.json')));

    const denials = await gateProjectsForSpawn(
      fakeConn({ trustGate }),
      [projectId],
      BUS_SETTING_SCOPES,
    );

    expect(denials.get(projectId)).toEqual(['evil']);
  });

  test('nothing denied yields an empty map, not a phantom entry', async () => {
    // Bare command (no path) so `computeBinarySha` returns null on BOTH
    // sides — `checkTrust` matches a stored trust row on `binary_sha = ?`,
    // so a null-sha row never matches a resolvable binary. (Denials are
    // exempt: register D08 made those apply at any sha.)
    writeMcpJson({ fine: { command: 'echo' } });
    recordTrustDecision({
      serverName: 'fine',
      command: 'echo',
      args: [],
      originPath: path.join(projectDir, '.mcp.json'),
      binarySha: null,
      decision: 'trusted',
    });

    const denials = await gateProjectsForSpawn(fakeConn(), [projectId], BUS_SETTING_SCOPES);

    // A spurious name here would strip a legitimate server's tools from every
    // run — the failure mode in the opposite direction, and just as bad.
    expect(denials.size).toBe(0);
  });

  test('a project with no MCP declarations at all denies nothing', async () => {
    const denials = await gateProjectsForSpawn(fakeConn(), [projectId], BUS_SETTING_SCOPES);
    expect(denials.size).toBe(0);
  });

  test('the denial is keyed per project so a multi-project bus start stays attributable', async () => {
    // A chain/orchestrator start gates several projects in one call. Returning
    // a flat list would let one participant's denial strip another's servers.
    const otherDir = path.join(tmpRoot, 'other');
    fs.mkdirSync(path.join(otherDir, '.claude'), { recursive: true });
    const otherId = upsertProject('other', otherDir).id;
    setProjectTrusted(otherId, true);

    writeMcpJson({ evil: { command: '/bin/echo' } });
    recordTrustDecision({
      serverName: 'evil',
      command: '/bin/echo',
      args: [],
      originPath: path.join(projectDir, '.mcp.json'),
      binarySha: null,
      decision: 'denied_remember',
    });
    fs.writeFileSync(
      path.join(otherDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { harmless: { command: 'echo' } } }),
    );
    recordTrustDecision({
      serverName: 'harmless',
      command: 'echo',
      args: [],
      originPath: path.join(otherDir, '.mcp.json'),
      binarySha: null,
      decision: 'trusted',
    });

    const denials = await gateProjectsForSpawn(
      fakeConn(),
      [projectId, otherId],
      BUS_SETTING_SCOPES,
    );

    expect(denials.get(projectId)).toEqual(['evil']);
    expect(denials.get(otherId)).toBeUndefined();
  });

  test('an untrusted single-agent project is not prompted about .mcp.json', async () => {
    // Trust-derived scopes are ['user'], and .mcp.json does not load under
    // those (measured) — so there is nothing to gate and nothing to deny.
    setProjectTrusted(projectId, false);
    writeMcpJson({ evil: { command: '/bin/echo' } });

    const denials = await gateProjectsForSpawn(fakeConn(), [projectId]);

    expect(denials.size).toBe(0);
  });

  test('the refusal is recorded in the hash-chained audit log as enforced', async () => {
    writeMcpJson({ evil: { command: '/bin/echo' } });
    recordTrustDecision({
      serverName: 'evil',
      command: '/bin/echo',
      args: [],
      originPath: path.join(projectDir, '.mcp.json'),
      binarySha: null,
      decision: 'denied_remember',
    });

    await gateProjectsForSpawn(fakeConn(), [projectId], BUS_SETTING_SCOPES);

    const row = getDb()
      .prepare(`SELECT payload_json FROM safety_audit WHERE kind = 'mcp.trust_silent_refusal'`)
      .get() as { payload_json: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.payload_json)).toMatchObject({
      serverName: 'evil',
      enforcement: 'denied_mcp_servers+disallowed_tools',
    });
  });
});
