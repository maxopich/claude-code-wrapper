import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Cebab-ws0.7: `fromProbe` must describe what HAPPENED, not what was asked
 * for.
 *
 * The field has been on the wire since it was introduced, with a doc saying
 * `true` means "this resolve ran a fresh SDK probe" and an implementation that
 * set it from `input.mode` — the REQUESTED mode. So a probe that timed out, or
 * whose CLI died on startup, fell back to the cached snapshot and shipped it
 * labelled live. Nothing read the field, so nothing noticed; ws0.7 makes the
 * authority panel's freshness label read it, which turns a dormant inaccuracy
 * into a sentence an operator acts on.
 *
 * WHY THIS FILE MOCKS THE PROBE. There is no way to make a probe fail in mock
 * mode — `probeSessionStarted` takes no fixture argument, so it always replays
 * the healthy default. `vi.mock` is file-scoped, which is also why this cannot
 * live beside cases that need a working runner.
 */

vi.mock('../runner/probe.js', () => ({
  probeSessionStarted: async () => probeResult,
}));

let probeResult: unknown = null;

const { respondWithProjectAuthority } = await import('./server.js');
const { config } = await import('../config.js');
const { closeDb, getDb } = await import('../db.js');
const { upsertProject } = await import('../repo/projects.js');

let tmpRoot: string;
let originalDataDir: string;
let projectId: number;
let sent: Array<{ type: string; authority: { fromProbe: boolean } | null }>;

/** A Conn shaped only as far as these two functions reach into it. `send`
 *  short-circuits on a non-OPEN socket, so the frame is captured by handing
 *  the fake socket a `send` of our own rather than by opening a real one. */
function fakeConn() {
  return {
    ws: {
      readyState: 1,
      send: (raw: string) => sent.push(JSON.parse(raw)),
    } as unknown as never,
    authorityCache: new Map(),
  } as unknown as Parameters<typeof respondWithProjectAuthority>[0];
}

beforeEach(() => {
  sent = [];
  probeResult = null;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-authority-source-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  const projectDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  projectId = upsertProject('proj', projectDir).id;
});

afterEach(() => {
  // closeDb before rm: Windows cannot unlink an open SQLite file.
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('the authority snapshot reports how it was actually produced', () => {
  test('asking for a probe that returns nothing ships fromProbe: false', async () => {
    // The whole point. `mode` says what was wanted; `fromProbe` must say what
    // was obtained. Passing the requested mode straight through — which is
    // what the code did for the field's entire existence — reddens here.
    probeResult = null;
    const conn = fakeConn();
    await respondWithProjectAuthority(conn, projectId, 'probe');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('project_authority');
    expect(sent[0]!.authority?.fromProbe).toBe(false);
  });

  test('CONTROL: a probe that returns a snapshot ships fromProbe: true', async () => {
    // Without this the case above passes on an implementation that hardcodes
    // false, losing the distinction in the other direction.
    probeResult = {
      type: 'session_started',
      sessionId: 's1',
      projectId,
      model: 'opus-4',
      tools: ['Bash'],
    };
    const conn = fakeConn();
    await respondWithProjectAuthority(conn, projectId, 'probe');
    expect(sent[0]!.authority?.fromProbe).toBe(true);
  });

  test('a probe result is cached, so the next cache read serves it', async () => {
    // What makes "repeated selection reuses the cache rather than respawning"
    // true downstream: the scheduler asks `authorityCache.has(...)`, which is
    // only ever filled through this path or a real turn.
    probeResult = {
      type: 'session_started',
      sessionId: 's1',
      projectId,
      model: 'opus-4',
      tools: ['Bash'],
    };
    const conn = fakeConn();
    await respondWithProjectAuthority(conn, projectId, 'probe');
    expect((conn as unknown as { authorityCache: Map<number, unknown> }).authorityCache.size).toBe(
      1,
    );
  });

  test('mode cache never probes, however healthy the probe would have been', async () => {
    // A cache read must stay free. A `mode` that leaks into the probe branch
    // would turn every panel mount into a process spawn.
    probeResult = {
      type: 'session_started',
      sessionId: 's1',
      projectId,
      model: 'opus-4',
      tools: ['Bash'],
    };
    const conn = fakeConn();
    await respondWithProjectAuthority(conn, projectId, 'cache');
    expect(sent[0]!.authority?.fromProbe).toBe(false);
    expect((conn as unknown as { authorityCache: Map<number, unknown> }).authorityCache.size).toBe(
      0,
    );
  });

  test('a project row that does not exist still answers, without a probe', async () => {
    probeResult = {
      type: 'session_started',
      sessionId: 's1',
      projectId: 999,
      model: 'm',
      tools: [],
    };
    const conn = fakeConn();
    await respondWithProjectAuthority(conn, 4242, 'probe');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.authority?.fromProbe).not.toBe(true);
  });
});
