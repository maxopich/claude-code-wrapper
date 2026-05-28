import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  captureSingleAgentForensics,
  computeShallowWorkdirHash,
  type SingleAgentEventRow,
} from './forensic_snapshot.js';

// Cluster C Phase 3 (spec §4.6): pure helper tests. No DB, no WS — just
// the bundle assembly logic. The integration test covering the wired
// path lives in stopped_audit.test.ts.
//
// Coverage:
//   - effectivePrompt: captured wins; falls back to last user_message; finally 'none'
//   - eventsLastN: caps at 50; preserves order
//   - pendingToolCalls: stripped to (requestId, toolName, toolInput); null when empty
//   - workdirTreeHash: stable across calls; skip-list honored; deterministic
//   - workdir hash failure path: snapshotFailedReason populated when fs throws
//   - busInboxOutbox + mutationRationale always undefined (single-agent)

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-forensic-snap-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function evt(seq: number, type: string, payload: Record<string, unknown>): SingleAgentEventRow {
  return { seq, ts: 1_700_000_000_000 + seq, type, subtype: null, raw: JSON.stringify(payload) };
}

describe('captureSingleAgentForensics — effective prompt', () => {
  test('captured prompt wins over last user event', () => {
    const out = captureSingleAgentForensics({
      sessionId: 'sess-1',
      recentEvents: [evt(1, 'user_message', { text: 'older user msg' })],
      pendingPermissions: [],
      capturedPrompt: { text: 'held prompt', projectId: 7 },
      activePermissions: { trusted: false, permissionMode: null },
      projectCwd: undefined,
      now: () => 1_800_000_000_000,
    });
    expect(out.effectivePrompt).toEqual({
      source: 'captured',
      text: 'held prompt',
      projectId: 7,
    });
  });

  test('no captured: pulls last user_message from events', () => {
    const out = captureSingleAgentForensics({
      sessionId: 'sess-1',
      recentEvents: [
        evt(1, 'user_message', { text: 'first turn' }),
        evt(2, 'assistant_message', { text: 'reply' }),
        evt(3, 'user_message', { text: 'second turn' }),
      ],
      pendingPermissions: [],
      capturedPrompt: undefined,
      activePermissions: { trusted: true, permissionMode: 'acceptEdits' },
      projectCwd: undefined,
      now: () => 1_800_000_000_000,
    });
    expect(out.effectivePrompt).toEqual({
      source: 'last-user-event',
      text: 'second turn',
      eventSeq: 3,
    });
  });

  test('no captured + no user_message: source=none', () => {
    const out = captureSingleAgentForensics({
      sessionId: 'sess-1',
      recentEvents: [evt(1, 'assistant_message', { text: 'system-only' })],
      pendingPermissions: [],
      capturedPrompt: undefined,
      activePermissions: { trusted: false, permissionMode: null },
      projectCwd: undefined,
      now: () => 1_800_000_000_000,
    });
    expect(out.effectivePrompt).toEqual({ source: 'none' });
  });

  test("malformed user_message raw doesn't throw; keeps searching older rows", () => {
    const out = captureSingleAgentForensics({
      sessionId: 'sess-1',
      recentEvents: [
        evt(1, 'user_message', { text: 'older one' }),
        // newer row with malformed raw — must not crash
        { seq: 2, ts: 1, type: 'user_message', subtype: null, raw: 'not json {' },
      ],
      pendingPermissions: [],
      capturedPrompt: undefined,
      activePermissions: { trusted: false, permissionMode: null },
      projectCwd: undefined,
      now: () => 1_800_000_000_000,
    });
    expect(out.effectivePrompt).toEqual({
      source: 'last-user-event',
      text: 'older one',
      eventSeq: 1,
    });
  });
});

describe('captureSingleAgentForensics — eventsLastN', () => {
  test('caps to last 50 events', () => {
    const events = Array.from({ length: 60 }, (_, i) => evt(i + 1, 'system_event', { i }));
    const out = captureSingleAgentForensics({
      sessionId: 'sess-1',
      recentEvents: events,
      pendingPermissions: [],
      capturedPrompt: undefined,
      activePermissions: { trusted: false, permissionMode: null },
      projectCwd: undefined,
      now: () => 1,
    });
    const captured = out.eventsLastN as { seq: number }[];
    expect(captured).toHaveLength(50);
    // last-50 of 1..60 → seq 11..60
    expect(captured[0]?.seq).toBe(11);
    expect(captured[49]?.seq).toBe(60);
  });
});

describe('captureSingleAgentForensics — pending tool calls', () => {
  test('strips resolver; passes through requestId+toolName+toolInput', () => {
    const out = captureSingleAgentForensics({
      sessionId: 'sess-1',
      recentEvents: [],
      pendingPermissions: [
        { requestId: 'req-1', toolName: 'Edit', toolInput: { file_path: '/x' } },
        { requestId: 'req-2', toolName: 'Bash', toolInput: { command: 'ls' } },
      ],
      capturedPrompt: undefined,
      activePermissions: { trusted: false, permissionMode: null },
      projectCwd: undefined,
      now: () => 1,
    });
    expect(out.pendingToolCalls).toEqual([
      { requestId: 'req-1', toolName: 'Edit', toolInput: { file_path: '/x' } },
      { requestId: 'req-2', toolName: 'Bash', toolInput: { command: 'ls' } },
    ]);
  });

  test('empty pending → null', () => {
    const out = captureSingleAgentForensics({
      sessionId: 'sess-1',
      recentEvents: [],
      pendingPermissions: [],
      capturedPrompt: undefined,
      activePermissions: { trusted: false, permissionMode: null },
      projectCwd: undefined,
      now: () => 1,
    });
    expect(out.pendingToolCalls).toBeNull();
  });
});

describe('computeShallowWorkdirHash', () => {
  test('stable hash across two calls on the same tree', () => {
    fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(tmpRoot, 'b.txt'), 'world');
    fs.mkdirSync(path.join(tmpRoot, 'sub'));
    const h1 = computeShallowWorkdirHash(tmpRoot);
    const h2 = computeShallowWorkdirHash(tmpRoot);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  test('hash changes when a file is added', () => {
    fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'hello');
    const before = computeShallowWorkdirHash(tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, 'b.txt'), 'world');
    const after = computeShallowWorkdirHash(tmpRoot);
    expect(after).not.toBe(before);
  });

  test('skips node_modules / .git / dist / build', () => {
    fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'hello');
    const baseline = computeShallowWorkdirHash(tmpRoot);
    fs.mkdirSync(path.join(tmpRoot, 'node_modules'));
    fs.mkdirSync(path.join(tmpRoot, '.git'));
    fs.mkdirSync(path.join(tmpRoot, 'dist'));
    fs.writeFileSync(path.join(tmpRoot, 'node_modules/x.js'), 'junk');
    const after = computeShallowWorkdirHash(tmpRoot);
    expect(after).toBe(baseline);
  });
});

describe('captureSingleAgentForensics — workdir hash failure path', () => {
  test('non-existent projectCwd populates snapshotFailedReason; hash stays null', () => {
    const out = captureSingleAgentForensics({
      sessionId: 'sess-1',
      recentEvents: [],
      pendingPermissions: [],
      capturedPrompt: undefined,
      activePermissions: { trusted: false, permissionMode: null },
      projectCwd: path.join(tmpRoot, 'does-not-exist'),
      now: () => 1,
    });
    expect(out.workdirTreeHash).toBeNull();
    expect(out.snapshotFailedReason).toMatch(/^workdir_hash_failed:/);
  });

  test('missing projectCwd → hash null + no snapshotFailedReason (nothing to capture)', () => {
    const out = captureSingleAgentForensics({
      sessionId: 'sess-1',
      recentEvents: [],
      pendingPermissions: [],
      capturedPrompt: undefined,
      activePermissions: { trusted: false, permissionMode: null },
      projectCwd: undefined,
      now: () => 1,
    });
    expect(out.workdirTreeHash).toBeNull();
    expect(out.snapshotFailedReason).toBeNull();
  });
});

describe('captureSingleAgentForensics — single-agent invariants', () => {
  test('busInboxOutbox + mutationRationale always undefined for single-agent', () => {
    const out = captureSingleAgentForensics({
      sessionId: 'sess-1',
      recentEvents: [],
      pendingPermissions: [],
      capturedPrompt: undefined,
      activePermissions: { trusted: false, permissionMode: null },
      projectCwd: undefined,
      now: () => 1,
    });
    expect(out.busInboxOutbox).toBeUndefined();
    expect(out.mutationRationale).toBeUndefined();
    expect(out.agentSlug).toBeNull();
  });

  test('ts comes from injected now()', () => {
    const out = captureSingleAgentForensics({
      sessionId: 'sess-1',
      recentEvents: [],
      pendingPermissions: [],
      capturedPrompt: undefined,
      activePermissions: { trusted: false, permissionMode: null },
      projectCwd: undefined,
      now: () => 999_888_777_666,
    });
    expect(out.ts).toBe(999_888_777_666);
  });

  test('activePermissions flows through verbatim', () => {
    const out = captureSingleAgentForensics({
      sessionId: 'sess-1',
      recentEvents: [],
      pendingPermissions: [],
      capturedPrompt: undefined,
      activePermissions: { trusted: true, permissionMode: 'acceptEdits' },
      projectCwd: undefined,
      now: () => 1,
    });
    expect(out.activePermissions).toEqual({ trusted: true, permissionMode: 'acceptEdits' });
  });
});
