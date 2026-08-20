import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { upsertProject } from '../repo/projects.js';
import { handleClientMsg } from './server.js';

/**
 * Cebab-ws0.7: the two ends of the probe-on-selection wiring.
 *
 * `probe_schedule.test.ts` proves the scheduler decides correctly. Nothing
 * there says it is ever ASKED, or ever stood down — and a feature wired to
 * nothing passes every test of its parts.
 *
 * The two ends are covered differently on purpose, and the second one is the
 * weaker test:
 *
 *   - The TRIGGER is a real behaviour: `handleClientMsg` takes a `Conn`, so a
 *     fake one with a recording scheduler observes it directly.
 *   - The TEARDOWN lives in a closure inside `onConnection`, which nothing can
 *     reach from outside. So it is checked by reading the source, the same way
 *     `projects_emit_site.test.ts` checks its invariant — with the same
 *     anti-vacuity guard, because a scan that finds no region passes for the
 *     same reason a scan that finds no violation does.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SOURCE = path.join(HERE, 'server.ts');

let tmpRoot: string;
let originalDataDir: string;
let projectId: number;

function recordingConn(selected: number[]) {
  return {
    ws: { readyState: 0 } as unknown as never,
    authorityCache: new Map(),
    inFlight: new Map(),
    probeScheduler: {
      onProjectSelected: (id: number) => selected.push(id),
      cancel: () => {},
    },
  } as unknown as Parameters<typeof handleClientMsg>[0];
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-probe-wiring-'));
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

describe('probe-on-selection is actually wired up', () => {
  test('open_project tells the scheduler which project was selected', async () => {
    // `open_project` is what `selectProject` sends on every sidebar click, so
    // this is the selection signal. Deleting the one line in the handler
    // reddens here and nowhere else.
    const selected: number[] = [];
    await handleClientMsg(recordingConn(selected), { type: 'open_project', projectId });
    expect(selected).toEqual([projectId]);
  });

  test('a project that does not exist selects nothing', async () => {
    // The handler returns early for an unknown id; telling the scheduler about
    // it would arm a timer for a probe that can never resolve a project.
    const selected: number[] = [];
    await handleClientMsg(recordingConn(selected), { type: 'open_project', projectId: 4242 });
    expect(selected).toEqual([]);
  });

  test('the close handler stands the scheduler down', () => {
    const src = fs.readFileSync(SERVER_SOURCE, 'utf8');
    // The STATEMENT, not the phrase: several comments in this file discuss
    // `ws.on('close')` and the first mention is one of them.
    const start = src.indexOf("ws.on('close', () => {");
    // Anti-vacuity, in both directions: the region has to exist, and it has to
    // be the real one rather than a two-line stub a rename left behind. The
    // neighbours are the two timers whose teardown obligation this shares.
    expect(start).toBeGreaterThan(-1);
    const region = src.slice(start, start + 6000);
    expect(region).toContain('clearInterval(heartbeatTimer)');
    expect(region).toContain('conn.probeScheduler.cancel()');
  });
});
