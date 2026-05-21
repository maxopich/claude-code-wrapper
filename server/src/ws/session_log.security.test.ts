/**
 * [security] tests for the Logs surface — confirm sensitive data never
 * leaves the server unredacted unless `revealSensitive=true` was explicitly
 * passed. The Logs button is one click; without these guarantees, a casual
 * operator click would silently elevate every prior session's cached
 * `.env` / credentials writes to operator-visible terrain.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  appendMultiAgentEvent,
  appendMultiAgentMutation,
  confirmMutationByToolUseId,
  createMultiAgentSession,
} from '../repo/multi_agent.js';
import { buildSessionLogChunk } from './session_log.js';

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-session-log-sec-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('[security] buildSessionLogChunk redaction', () => {
  test('Bearer tokens in bus events are masked by default', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentEvent(
      's1',
      'worker',
      'orchestrator',
      'reply',
      'curl -H "Authorization: Bearer abcd1234efgh5678ijklmn"',
    );
    const chunk = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 10,
      revealSensitive: false,
    });
    expect(chunk.rows[0]).toBeDefined();
    const raw = chunk.rows[0]!.raw as Record<string, unknown>;
    expect(raw.text).toBe('<redacted>');
    expect(chunk.rows[0]!.redactedFields).toContain('text');
  });

  test('Mutation rows on sensitive paths mask filePath ONLY when path itself is sensitive', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentMutation('s1', 'worker', 'Write', 'mutate', 'create .env (40 B)', {
      filePath: '/project/.env',
      cwd: '/project',
      toolUseId: 'tu1',
    });
    confirmMutationByToolUseId('s1', 'tu1');
    const chunk = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 10,
      revealSensitive: false,
    });
    const raw = chunk.rows[0]!.raw as Record<string, unknown>;
    // file_path itself stays visible — operator MUST see what was touched.
    expect(raw.filePath).toBe('/project/.env');
  });

  test('revealedSensitive flag round-trips on the chunk so the client can detect a leak', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentEvent('s1', 'a', 'b', 'reply', 'AKIAIOSFODNN7EXAMPLE');

    const masked = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 10,
      revealSensitive: false,
    });
    expect(masked.revealedSensitive).toBe(false);
    const unmasked = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 10,
      revealSensitive: true,
    });
    expect(unmasked.revealedSensitive).toBe(true);
    // Sanity: the unmasked chunk really does contain the raw secret pattern.
    expect((unmasked.rows[0]!.raw as Record<string, unknown>).text).toContain('AKIA');
  });

  test('provisional mutations (confirmedAt=null) NEVER leak into the log', () => {
    // The mutation tap fires BEFORE the SDK runs the tool (race window
    // documented in runner.ts). A worker that's paused or crashes mid-tool
    // leaves a provisional row. The Logs surface must not project these —
    // they may not have happened on disk, and showing them in a "log of
    // what occurred" is misleading.
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentMutation('s1', 'worker', 'Write', 'mutate', 'create x', {
      filePath: '/p/x',
      cwd: '/p',
      toolUseId: 'tu1',
    });
    // intentionally do NOT call confirmMutationByToolUseId
    const chunk = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 10,
      revealSensitive: false,
    });
    expect(chunk.total).toBe(0);
  });
});
