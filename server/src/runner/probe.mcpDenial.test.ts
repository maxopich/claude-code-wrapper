/**
 * A probe must not start an MCP server the operator has not approved
 * (Cebab-ygu.6 / Cebab-ygu.17).
 *
 * WHY ITS OWN FILE. The assertion is about the OPTIONS handed to the spawn, so
 * it needs `pickRunner` mocked — and `vi.mock` is file-scoped, so putting it
 * beside the happy-path cases in `probe.test.ts` would mock the runner they
 * depend on. Same reason `probe.spawnFailure.test.ts` is separate.
 *
 * WHAT WENT WRONG. `gateProjectsForSpawn`'s header claimed to list "every path
 * to a spawn" and did not list this one, so the probe ran ungated: a server the
 * operator answered "Deny & remember" to was started by it anyway, with no
 * prompt, no refusal and no safety_audit row. Since `Cebab-ws0.7` the probe
 * also fires ~400ms after the operator lands on a project, so this was not even
 * gated behind a click.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type CapturedOpts = { deniedMcpServers?: readonly string[] } & Record<string, unknown>;
const captured: CapturedOpts[] = [];

vi.mock('./index.js', () => ({
  pickRunner: (opts: CapturedOpts) => {
    captured.push(opts);
    // Minimal init, shaped like the fixture's first line: the probe breaks at
    // the first `system/init` and translates it.
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'probe-sid',
          cwd: '/tmp',
          tools: [],
          mcp_servers: [],
          model: 'test-model',
        };
      },
      close() {},
    };
  },
}));

const { config } = await import('../config.js');
const { closeDb, getDb } = await import('../db.js');
const { probeSessionStarted } = await import('./probe.js');
const { upsertProject, setProjectTrusted } = await import('../repo/projects.js');
const { computeBinarySha, recordTrustDecision } = await import('../repo/mcp_trust.js');
const { __resetForTests } = await import('./lifecycle.js');

let tmpRoot: string;
let projectDir: string;
let originalDataDir: string;
let projectId: number;

/** A project whose `.mcp.json` declares one server, trusted so the resolver
 *  reads project scope at all. */
function seedProject(server: { command: string; args?: string[] }): string {
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.mcp.json'),
    JSON.stringify({ mcpServers: { payments: server } }),
  );
  projectId = upsertProject('acme', projectDir).id;
  setProjectTrusted(projectId, true);
  return path.join(projectDir, '.mcp.json');
}

beforeEach(() => {
  captured.length = 0;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-probe-denial-'));
  projectDir = path.join(tmpRoot, 'acme');
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  __resetForTests();
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  __resetForTests();
});

async function probe(): Promise<void> {
  await probeSessionStarted({
    cwd: projectDir,
    projectId,
    settingSources: ['user', 'project', 'local'],
  });
}

describe('[security] the authority probe honours the MCP trust ledger', () => {
  test('a denied server is kept out of the spawn', async () => {
    // The exact failure scenario in both beads: a standing "Deny & remember",
    // then a probe.
    const originPath = seedProject({ command: '/bin/echo', args: ['hi'] });
    recordTrustDecision({
      serverName: 'payments',
      originPath,
      command: '/bin/echo',
      args: ['hi'],
      binarySha: null,
      decision: 'denied_remember',
    });

    await probe();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.deniedMcpServers).toEqual(['payments']);
  });

  test('a never-approved server is kept out too', async () => {
    // No decision at all — `pending_tofu`. The gated path would prompt; a
    // probe has nobody to prompt, so it refuses.
    seedProject({ command: '/bin/echo', args: ['hi'] });

    await probe();

    expect(captured[0]!.deniedMcpServers).toEqual(['payments']);
  });

  test('the refusal is recorded for a standing denial', async () => {
    const originPath = seedProject({ command: '/bin/echo', args: ['hi'] });
    recordTrustDecision({
      serverName: 'payments',
      originPath,
      command: '/bin/echo',
      args: ['hi'],
      binarySha: null,
      decision: 'denied_remember',
    });

    await probe();

    const rows = getDb()
      .prepare<[], { reason_code: string }>(
        `SELECT reason_code FROM safety_audit WHERE kind = 'mcp.trust_silent_refusal'`,
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason_code).toBe('denied_remember');
  });

  test('an approved server spawns byte-identically to before this existed', async () => {
    // The control, and the reason it is worth a case of its own: a fix that
    // refused everything would pass every assertion above while making the
    // panel report nothing for anybody. `mcpDenialOptions` returns `{}` for an
    // empty list, so the key must be ABSENT rather than an empty array — an
    // empty array would add a `settings` layer to every ordinary spawn.
    const originPath = seedProject({ command: '/bin/echo', args: ['hi'] });
    recordTrustDecision({
      serverName: 'payments',
      originPath,
      command: '/bin/echo',
      args: ['hi'],
      // The SHA the resolver will compute, not a bare null: a null-sha row
      // does not match a resolvable binary, which is pre-existing lookup
      // semantics and would make this case pass for the wrong reason (refused
      // because unrecognised, not because the fix refuses everything).
      // Returns null on a platform without /bin/echo, which still matches.
      binarySha: computeBinarySha('/bin/echo'),
      decision: 'trusted',
    });

    await probe();

    expect(captured[0]).not.toHaveProperty('deniedMcpServers');
  });

  test('a probe with no project row refuses nothing', async () => {
    // The live smoke scripts pass `projectId: 0`. With no project there is no
    // authority, so there are no NAMES to refuse — structural, not a policy
    // choice, and worth pinning so nobody "fixes" it into a blanket refusal
    // that would break `mcp_scope_smoke.ts`.
    seedProject({ command: '/bin/echo', args: ['hi'] });
    await probeSessionStarted({ cwd: projectDir, projectId: 0, settingSources: ['user'] });
    expect(captured[0]).not.toHaveProperty('deniedMcpServers');
  });
});
