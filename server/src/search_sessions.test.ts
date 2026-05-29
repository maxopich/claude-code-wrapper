import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared';
import { config } from './config.js';
import { closeDb, getDb } from './db.js';
import { upsertProject } from './repo/projects.js';
import { createSession } from './repo/sessions.js';
import { insertEvent, nextSeq } from './repo/events.js';
import { executeSearchSessions, type SearchSessionsInput } from './search_sessions.js';

// Cluster I Phase C4 (UI_Findings spec §4.2): coverage for the WS delegate's
// privilege gate. `repo/search.test.ts` exercises the LIKE scan + containment;
// here we pin the raw-search audit contract: redacted needs no audit, raw is
// audit-gated, and a failed audit downgrades to redacted (never ships raw
// bytes without a recorded intent).

let tmpRoot: string;
let originalDataDir: string;
let sent: ServerMsg[];

function captureSend(msg: ServerMsg): void {
  sent.push(msg);
}

function lastResults(): Extract<ServerMsg, { type: 'search_results' }> {
  const msg = sent.at(-1);
  if (!msg || msg.type !== 'search_results') throw new Error('expected a search_results reply');
  return msg;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-search-exec-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // applies 001..025
  sent = [];
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const SECRET = 'supersecretvalue123';

function seedSecretEvent(): void {
  const pid = upsertProject('p', path.join(tmpRoot, 'p')).id;
  createSession('s1', pid);
  insertEvent(
    's1',
    nextSeq('s1'),
    'assistant',
    null,
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello world' }] },
      api_key: SECRET,
    }),
  );
}

function msg(overrides: Partial<SearchSessionsInput> = {}): SearchSessionsInput {
  return { type: 'search_sessions', query: 'hello', scope: 'all_projects', ...overrides };
}

describe('executeSearchSessions — reply shape', () => {
  test('echoes query + scope and forwards results with raw:false by default', () => {
    seedSecretEvent();
    const appendAudit = vi.fn();
    executeSearchSessions({
      msg: msg({ query: 'hello', scope: 'all_projects' }),
      send: captureSend,
      appendAudit: appendAudit as never,
    });
    const reply = lastResults();
    expect(reply.query).toBe('hello');
    expect(reply.scope).toBe('all_projects');
    expect(reply.raw).toBe(false);
    expect(reply.results).toHaveLength(1);
    expect(appendAudit).not.toHaveBeenCalled();
  });
});

describe('[security] executeSearchSessions — raw-search audit gate', () => {
  test('a redacted (default) search writes NO audit row', () => {
    seedSecretEvent();
    const appendAudit = vi.fn();
    executeSearchSessions({
      msg: msg({ raw: false }),
      send: captureSend,
      appendAudit: appendAudit as never,
    });
    expect(appendAudit).not.toHaveBeenCalled();
  });

  test('a raw search writes a session.searched/searched_raw audit row BEFORE returning', () => {
    seedSecretEvent();
    const appendAudit = vi.fn();
    executeSearchSessions({
      msg: msg({
        query: SECRET,
        scope: 'this_project',
        projectId: 1,
        includeArchived: true,
        raw: true,
      }),
      send: captureSend,
      appendAudit: appendAudit as never,
    });

    expect(appendAudit).toHaveBeenCalledTimes(1);
    const row = appendAudit.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.kind).toBe('session.searched');
    expect(row.reasonCode).toBe('searched_raw');
    const payload = row.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      scope: 'this_project',
      includeArchived: true,
      queryLength: SECRET.length,
    });
    // The reply is raw, and the audit row never persists the literal query.
    expect(lastResults().raw).toBe(true);
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  test('audit-write failure DOWNGRADES to a redacted search (no raw bytes ship)', () => {
    seedSecretEvent();
    const appendAudit = vi.fn(() => {
      throw new Error('audit unavailable');
    });
    executeSearchSessions({
      msg: msg({ query: SECRET, raw: true }),
      send: captureSend,
      appendAudit: appendAudit as never,
    });

    const reply = lastResults();
    // Downgraded: the flag flips to false (despite msg.raw === true) AND the
    // redacted scan dropped the secret-only match, so no unredacted byte ships.
    // (reply.query legitimately echoes the search term — assert on results.)
    expect(reply.raw).toBe(false);
    expect(reply.results).toEqual([]);
    expect(JSON.stringify(reply.results)).not.toContain(SECRET);
  });

  test('forwards the truncated flag from the scan', () => {
    const pid = upsertProject('p', path.join(tmpRoot, 'p')).id;
    createSession('s1', pid);
    for (let i = 0; i < 4; i++) {
      insertEvent(
        's1',
        nextSeq('s1'),
        'assistant',
        null,
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: `kappa ${i}` }] },
        }),
      );
    }
    executeSearchSessions({
      msg: msg({ query: 'kappa', limit: 2 }),
      send: captureSend,
      appendAudit: vi.fn() as never,
    });
    expect(lastResults().truncated).toBe(true);
  });
});
