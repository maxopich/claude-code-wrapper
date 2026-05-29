import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { upsertProject } from '../repo/projects.js';
import { createSession } from '../repo/sessions.js';
import { translate } from './translate.js';

// Cluster G Phase 2b (UI-A3): translate(system.init) projects the
// per-session `mock` flag (migration 023, sessions.mock column) onto
// the `session_started` ServerMsg. This is what lets the ChatHeader's
// `MockBadge` (Phase 2b) and the multi-agent surfaces (Phase 2c) tell
// "this session was created in mock mode" apart from "the current
// process is running in mock mode" (the global `settings.mockMode`).
//
// The two dimensions can diverge: an operator can restart Cebab in
// live mode and re-open a historical mock session — the global flag
// says live, the session row still says mock. The audit-tag dimension
// (safety_audit.mode) carries the runtime mode at WRITE time and so
// always matches `config.mock`; this `session_started.mock` carries
// the CREATE-time mode and so always matches the row.

function initMsg(sessionId: string, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'claude-sonnet-4',
    tools: ['Bash', 'Read'],
    ...extra,
  } as unknown as SDKMessage;
}

// ---- isolated fs + DB scaffolding ----

let tmpRoot: string;
let originalDataDir: string;
let originalMock: boolean;
let projectId: number;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-translate-mock-'));
  originalDataDir = config.dataDir;
  originalMock = config.mock;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  const project = upsertProject('proj', '/tmp/proj');
  projectId = project.id;
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  config.mock = originalMock;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('translate(system.init) — Cluster G Phase 2b mock projection', () => {
  test('session created under MOCK runtime → session_started carries mock=true', () => {
    config.mock = true;
    createSession('sess-mock', projectId, null);
    const out = translate(initMsg('sess-mock'), projectId);
    expect(out).toMatchObject({
      type: 'session_started',
      sessionId: 'sess-mock',
      projectId,
      mock: true,
    });
  });

  test('session created under live runtime → session_started omits mock', () => {
    // Additive-optional contract per existing Cluster B Phase 2 tests:
    // omitted-when-absent, NEVER included as `false` (that would prevent
    // older clients from cleanly ignoring the field; also makes the
    // wire envelope minimal on the common live path).
    config.mock = false;
    createSession('sess-live', projectId, null);
    const out = translate(initMsg('sess-live'), projectId);
    expect(out).not.toBeNull();
    if (out === null) return; // narrowing
    expect(out).toMatchObject({
      type: 'session_started',
      sessionId: 'sess-live',
      projectId,
    });
    expect('mock' in out).toBe(false);
  });

  test('CREATE-time mode wins over runtime mode (the divergence case)', () => {
    // The key invariant: a session created in mock keeps the badge even
    // after the operator restarts Cebab in live mode. This is what makes
    // the audit trail meaningful — the operator can't accidentally
    // launder a mock session's history into a "live" record by toggling
    // MOCK off.
    config.mock = true;
    createSession('sess-historical-mock', projectId, null);
    config.mock = false; // operator "restarted Cebab in live mode"
    const out = translate(initMsg('sess-historical-mock'), projectId);
    expect(out).toMatchObject({
      type: 'session_started',
      sessionId: 'sess-historical-mock',
      mock: true,
    });
  });

  test('unknown session id (no row) → session_started omits mock (no false-positive)', () => {
    // Defence-in-depth: if `init` fires for a session_id that was never
    // persisted (smoke-test path, future refactor), the projection must
    // not invent a value. getSession returns undefined → spread-omit.
    config.mock = true;
    const out = translate(initMsg('sess-never-created'), projectId);
    expect(out).not.toBeNull();
    if (out === null) return;
    expect('mock' in out).toBe(false);
  });
});
