/**
 * The authority probe reads each MCP server's SCOPE from the CLI's own status
 * report, in the same spawn, and copies nothing but the scope (Cebab-ajvv).
 *
 * WHY THIS MATTERS. `system/init` carries only `{ name, status }`, so a server
 * no file Cebab reads declares — a claude.ai connector, a plugin server —
 * reaches the panel as `scope: 'unknown'`. `Query.mcpServerStatus()` carries the
 * CLI's own scope label, which is the one source that can attribute it. The
 * capture is a LABEL source: it must never store the rows' `config`, which
 * carries connector URLs and ids.
 *
 * WHY ITS OWN FILE. The probe cases need `pickRunner` mocked, and `vi.mock` is
 * file-scoped — the same reason `probe.mcpDenial.test.ts` is separate. The
 * `captureMcpScopes` unit cases pass their own fake runners and are unaffected
 * by that mock.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/** Set by the mock runner so a test can assert the scope read happened BEFORE
 *  the session was closed. `null` until `mcpServerStatus` runs at all. */
let closeCalled = false;
let statusCalledAfterClose: boolean | null = null;

vi.mock('./index.js', () => ({
  pickRunner: () => ({
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'probe-sid',
        cwd: '/tmp',
        tools: [],
        // A server the file scan cannot find — the case this labels.
        mcp_servers: [{ name: 'claude.ai Mail', status: 'pending' }],
        model: 'test-model',
      };
    },
    async mcpServerStatus() {
      statusCalledAfterClose = closeCalled;
      return [
        {
          name: 'claude.ai Mail',
          status: 'pending',
          scope: 'claudeai',
          // Must never be copied.
          config: { type: 'claudeai-proxy', url: 'https://example.invalid/x', id: 'x' },
        },
      ];
    },
    close() {
      closeCalled = true;
    },
  }),
}));

const { config } = await import('../config.js');
const { closeDb, getDb } = await import('../db.js');
const { captureMcpScopes, probeAuthority, probeSessionStarted } = await import('./probe.js');
const { __resetForTests } = await import('./lifecycle.js');
const { closeLogger } = await import('./logger.js');

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  closeCalled = false;
  statusCalledAfterClose = null;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-probe-scopes-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  __resetForTests();
});

afterEach(async () => {
  closeDb();
  config.dataDir = originalDataDir;
  await closeLogger();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  __resetForTests();
});

describe('captureMcpScopes', () => {
  test("captures name → scope from the CLI's own status rows", async () => {
    const scopes = await captureMcpScopes({
      mcpServerStatus: async () => [
        { name: 'payments', status: 'connected', scope: 'project' },
        { name: 'claude.ai Mail', status: 'pending', scope: 'claudeai' },
      ],
    });
    // Reddens if the function returns an empty map.
    expect(scopes.get('payments')).toBe('project');
    expect(scopes.get('claude.ai Mail')).toBe('claudeai');
    expect(scopes.size).toBe(2);
  });

  test('copies only the scope, never the config', async () => {
    const scopes = await captureMcpScopes({
      mcpServerStatus: async () => [
        {
          name: 'claude.ai Mail',
          status: 'connected',
          scope: 'claudeai',
          config: {
            type: 'claudeai-proxy',
            url: 'https://example.invalid/x',
            id: 'secret-conn-id',
          },
        },
      ],
    });
    expect(scopes.get('claude.ai Mail')).toBe('claudeai');
    // The rows' config carries a connector URL and id; neither may be stored.
    const serialised = JSON.stringify([...scopes.entries()]);
    expect(serialised).not.toContain('example.invalid');
    expect(serialised).not.toContain('secret-conn-id');
    expect(serialised).not.toContain('claudeai-proxy');
  });

  test('answers empty when the runner cannot', async () => {
    // Missing method.
    expect((await captureMcpScopes({})).size).toBe(0);
    // A rejection.
    expect(
      (
        await captureMcpScopes({
          mcpServerStatus: async () => {
            throw new Error('boom');
          },
        })
      ).size,
    ).toBe(0);
    // A read that never settles — bounded by the short timeout.
    expect(
      (await captureMcpScopes({ mcpServerStatus: () => new Promise<unknown>(() => {}) }, 10)).size,
    ).toBe(0);
    // A non-array result.
    expect((await captureMcpScopes({ mcpServerStatus: async () => ({ nope: true }) })).size).toBe(
      0,
    );
  });

  test('skips rows without a usable name or scope', async () => {
    const scopes = await captureMcpScopes({
      mcpServerStatus: async () => [
        { name: '', status: 'connected', scope: 'project' },
        { name: 'noscope', status: 'connected', scope: '' },
        { name: 'noscope2', status: 'connected' },
        { status: 'connected', scope: 'user' },
        { name: 'good', status: 'connected', scope: 'user' },
      ],
    });
    expect(scopes.size).toBe(1);
    expect(scopes.get('good')).toBe('user');
  });
});

describe('the authority probe captures scopes in the same spawn', () => {
  test('the probe reads MCP scopes before it closes the session', async () => {
    const result = await probeAuthority({ cwd: '/tmp', projectId: 0, settingSources: ['user'] });
    expect(result).not.toBeNull();
    expect(result!.mcpScopes.get('claude.ai Mail')).toBe('claudeai');
    // Not null → the status read ran; false → it ran before close(). A probe
    // that closed first, or never read, reddens here.
    expect(statusCalledAfterClose).toBe(false);
  });

  test('probeSessionStarted still returns the bare session_started', async () => {
    const started = await probeSessionStarted({
      cwd: '/tmp',
      projectId: 0,
      settingSources: ['user'],
    });
    expect(started?.type).toBe('session_started');
  });
});
