/**
 * The authority probe recovers the half of a project's authority that only a
 * running SDK knows (Cebab-ys9).
 *
 * WHAT WENT WRONG. `mode: 'probe'` — the Refresh affordance on the authority
 * panel — logged a line and returned the same per-connection cache it was
 * asked to refresh. So the tool list, skills, slash commands, sub-agents and
 * the per-MCP-server STATUS stayed empty until some unrelated turn happened to
 * fill the cache, and an operator asking "what does this project actually
 * load?" got zeroes that were indistinguishable from "nothing is configured".
 *
 * The status field is the one that matters most and is the easiest to lose: a
 * declared MCP server that LOADS AND FAILS contributes no tools at all, which
 * from inside a session is indistinguishable from a server that was never
 * declared. The fixture is chosen for exactly that — it carries a server that
 * is present but NOT usable — and the case below asserts on it, because a
 * fixture where every server is healthy would let a probe that silently
 * dropped `status` pass (`project_fixture_omits_the_bug_input`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { inFlightCount, __resetForTests } from './lifecycle.js';
import { probeSessionStarted } from './probe.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let originalMock: boolean;
let originalInterval: number;

beforeEach(() => {
  originalMock = config.mock;
  originalInterval = config.mockIntervalMs;
  config.mock = true;
  config.mockIntervalMs = 0;
  __resetForTests();
});

afterEach(() => {
  config.mock = originalMock;
  config.mockIntervalMs = originalInterval;
  __resetForTests();
});

describe('probeSessionStarted', () => {
  test('the fixture really does carry an MCP server that is not usable', () => {
    // Guards every assertion below: if the fixture is ever replaced with one
    // whose servers are all healthy, this fails instead of the status case
    // quietly proving nothing.
    const init = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'fixtures', 'hello.jsonl'), 'utf8').split('\n')[0]!,
    ) as { mcp_servers?: { name: string; status: string }[] };
    expect(init.mcp_servers?.length).toBeGreaterThan(0);
    expect(init.mcp_servers!.some((s) => s.status !== 'connected')).toBe(true);
  });

  test('recovers the SDK-only half of a project authority', async () => {
    const out = await probeSessionStarted({
      cwd: repoRoot,
      projectId: 1,
      settingSources: ['user', 'project', 'local'],
    });
    expect(out).not.toBeNull();
    expect(out!.type).toBe('session_started');
    const started = out as Extract<typeof out, { type: 'session_started' }>;
    // Each of these is a section the panel renders empty without a probe.
    expect(started.tools?.length).toBeGreaterThan(0);
    expect(started.skills?.length).toBeGreaterThan(0);
    expect(started.slashCommands?.length).toBeGreaterThan(0);
    // The status is the point: a server that loaded and is unusable must
    // arrive as such, not be flattened away or dropped for being unhealthy.
    expect(started.mcpServers?.some((s) => s.status !== 'connected')).toBe(true);
  });

  test('stops at init rather than running the turn out', async () => {
    // The fixture continues into assistant + result messages. A probe that
    // drained it would cost a model turn on the live path, which is the whole
    // reason this is cheap enough to run from a button.
    const out = await probeSessionStarted({
      cwd: repoRoot,
      projectId: 1,
      settingSources: ['user'],
    });
    expect(out!.type).toBe('session_started');
  });

  test('leaves no query registered when it returns', async () => {
    expect(inFlightCount()).toBe(0);
    await probeSessionStarted({ cwd: repoRoot, projectId: 1, settingSources: ['user'] });
    // Register G1 / lifecycle.ts: an unregistered query outlives the server's
    // SIGINT sweep and silently burns subscription quota. A probe fires from a
    // button, so a leak here would accumulate per click.
    expect(inFlightCount()).toBe(0);
  });
});
