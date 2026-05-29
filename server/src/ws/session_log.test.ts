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
  listMultiAgentMutations,
  setMutationPromoted,
} from '../repo/multi_agent.js';
import { buildSessionLogChunk } from './session_log.js';

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-session-log-'));
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

describe('buildSessionLogChunk — projection', () => {
  test('projects bus events as kind=bus, source=agent', () => {
    createMultiAgentSession('s1', 'chain');
    appendMultiAgentEvent('s1', 'reviewer', 'planner', 'prompt', 'please review');

    const chunk = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    expect(chunk.total).toBe(1);
    expect(chunk.rows[0]).toMatchObject({
      kind: 'bus',
      agent: 'reviewer',
      status: 'prompt',
    });
    expect(chunk.rows[0]?.summary).toContain('reviewer → planner');
    expect(chunk.rows[0]?.summary).toContain('please review');
  });

  test('projects error-kind events as kind=error', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentEvent('s1', 'cebab', 'user', 'error', 'worker crashed');

    const chunk = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    expect(chunk.rows[0]?.kind).toBe('error');
  });

  test('skips provisional mutations (confirmedAt=null)', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentMutation('s1', 'worker', 'Write', 'mutate', 'create file.ts', {
      filePath: '/p/file.ts',
      cwd: '/p',
      toolUseId: 'tu1',
    });

    const chunk = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    expect(chunk.total).toBe(0);
  });

  test('includes confirmed mutations as kind=tool', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentMutation('s1', 'worker', 'Write', 'mutate', 'create file.ts', {
      filePath: '/p/file.ts',
      cwd: '/p',
      toolUseId: 'tu1',
    });
    confirmMutationByToolUseId('s1', 'tu1');

    const chunk = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    expect(chunk.total).toBe(1);
    expect(chunk.rows[0]).toMatchObject({
      kind: 'tool',
      agent: 'worker',
      status: 'Write',
      summary: 'create file.ts',
    });
  });

  test('promoted mutations project as kind=artifact', () => {
    createMultiAgentSession('s1', 'orchestrator');
    const mut = appendMultiAgentMutation('s1', 'worker', 'Write', 'mutate', 'create PLAN.md', {
      filePath: '/p/PLAN.md',
      cwd: '/p',
      toolUseId: 'tu1',
    });
    confirmMutationByToolUseId('s1', 'tu1');
    setMutationPromoted(mut.id, true);

    const chunk = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    expect(chunk.rows[0]?.kind).toBe('artifact');
  });

  test('surfaces mutation severity as a top-level field on tool/artifact rows', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentEvent('s1', 'reviewer', 'planner', 'prompt', 'please review');
    appendMultiAgentMutation('s1', 'worker', 'Write', 'mutate', 'create config.ts', {
      filePath: '/p/config.ts',
      cwd: '/p',
      toolUseId: 'tu-mutate',
    });
    confirmMutationByToolUseId('s1', 'tu-mutate');
    appendMultiAgentMutation('s1', 'worker', 'Write', 'dangerous', 'edit .env', {
      filePath: '/p/.env',
      cwd: '/p',
      toolUseId: 'tu-danger',
    });
    confirmMutationByToolUseId('s1', 'tu-danger');

    const chunk = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    const mutateRow = chunk.rows.find((r) => r.summary === 'create config.ts');
    const dangerousRow = chunk.rows.find((r) => r.summary === 'edit .env');
    const busRow = chunk.rows.find((r) => r.kind === 'bus');
    expect(mutateRow?.severity).toBe('mutate');
    expect(dangerousRow?.severity).toBe('dangerous');
    // Bus rows must not carry severity (it's mutation-only).
    expect(busRow?.severity).toBeUndefined();
  });

  test('merges events and mutations by ts ASC', () => {
    createMultiAgentSession('s1', 'orchestrator');
    // Insert in non-chronological order; reorder by ts at projection time.
    appendMultiAgentEvent('s1', 'a', 'b', 'prompt', 't1');
    appendMultiAgentEvent('s1', 'c', 'd', 'reply', 't2');
    appendMultiAgentMutation('s1', 'a', 'Write', 'mutate', 'create x', {
      filePath: '/p/x',
      cwd: '/p',
      toolUseId: 'tu1',
    });
    confirmMutationByToolUseId('s1', 'tu1');

    const chunk = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    expect(chunk.rows.length).toBe(3);
    const tses = chunk.rows.map((r) => r.ts);
    for (let i = 1; i < tses.length; i++) {
      expect(tses[i]!).toBeGreaterThanOrEqual(tses[i - 1]!);
    }
  });
});

describe('buildSessionLogChunk — pagination', () => {
  test('returns hasMore=true when more rows remain past limit', () => {
    createMultiAgentSession('s1', 'orchestrator');
    for (let i = 0; i < 5; i++) {
      appendMultiAgentEvent('s1', `a${i}`, 'sink', 'reply', `text-${i}`);
    }
    const chunk = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 2,
      revealSensitive: false,
    });
    expect(chunk.total).toBe(5);
    expect(chunk.rows.length).toBe(2);
    expect(chunk.hasMore).toBe(true);
  });

  test('offset skips earlier rows; hasMore=false on the tail page', () => {
    createMultiAgentSession('s1', 'orchestrator');
    for (let i = 0; i < 5; i++) {
      appendMultiAgentEvent('s1', `a${i}`, 'sink', 'reply', `t${i}`);
    }
    const tail = buildSessionLogChunk({
      sessionId: 's1',
      offset: 3,
      limit: 10,
      revealSensitive: false,
    });
    expect(tail.rows.length).toBe(2);
    expect(tail.hasMore).toBe(false);
  });

  test('clamps offset past total to an empty page', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentEvent('s1', 'a', 'b', 'prompt', 't');
    const past = buildSessionLogChunk({
      sessionId: 's1',
      offset: 9999,
      limit: 10,
      revealSensitive: false,
    });
    expect(past.rows).toEqual([]);
    expect(past.total).toBe(1);
    expect(past.hasMore).toBe(false);
  });
});

describe('buildSessionLogChunk — redaction', () => {
  test('redacts bus event text containing AWS access keys', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentEvent('s1', 'a', 'b', 'reply', 'discovered AKIAIOSFODNN7EXAMPLE in env file');
    const chunk = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 10,
      revealSensitive: false,
    });
    const row = chunk.rows[0]!;
    const raw = row.raw as Record<string, unknown>;
    expect(raw.text).toBe('<redacted>');
    expect(row.redactedFields).toContain('text');
    expect(chunk.revealedSensitive).toBe(false);
  });

  test('revealSensitive=true returns un-redacted raw', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentEvent('s1', 'a', 'b', 'reply', 'AKIAIOSFODNN7EXAMPLE');
    const chunk = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 10,
      revealSensitive: true,
    });
    const raw = chunk.rows[0]?.raw as Record<string, unknown>;
    expect(raw.text).toBe('AKIAIOSFODNN7EXAMPLE');
    expect(chunk.revealedSensitive).toBe(true);
  });

  test('summary is never redacted (operator must see what happened)', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentEvent('s1', 'a', 'b', 'reply', 'AKIAIOSFODNN7EXAMPLE');
    const chunk = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 10,
      revealSensitive: false,
    });
    // Summary contains the source/dest arrow + first line of text — the
    // text-leak risk lives in `raw.text`, not the summary. (The trim
    // happens before redaction; we still leak the first 200 chars of the
    // line into the summary. That's an acceptable tradeoff for v1 — the
    // operator-facing one-liner needs SOME context, and the heuristic
    // patterns we mask are visibly synthetic.)
    expect(chunk.rows[0]?.summary).toContain('a → b');
  });
});

/**
 * Cluster F Phase F3 (UI-F3): migration 022 added
 * `multi_agent_mutations.classifier_reason_json`. These tests pin the
 * append → projector round-trip so the new column survives R-A/R-B replay
 * — i.e. a row written with a Bash classifier reason re-emits the same
 * structured rationale when re-projected via `listMultiAgentMutations`.
 *
 * The dispatcher's UI-side render (badge tooltip) reads `m.classifierReason`
 * unchanged; the round-trip here guarantees the field is non-null and
 * shape-correct after a write+read cycle on the real DB.
 */
describe('multi_agent_mutations — F3 classifierReason round-trip', () => {
  test('write with classifierReason persists and projects identically', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentMutation('s1', 'worker', 'Bash', 'dangerous', 'rm -rf node_modules', {
      filePath: null,
      cwd: '/projects/foo',
      toolUseId: 'tu1',
      classifierReason: {
        rule: 'dangerous_first_token',
        detail: "first token 'rm' is always dangerous (destructive, privilege-escalating, or remote-code-executing)",
        matched: 'rm',
      },
    });
    const rows = listMultiAgentMutations('s1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.classifierReason).toEqual({
      rule: 'dangerous_first_token',
      detail: "first token 'rm' is always dangerous (destructive, privilege-escalating, or remote-code-executing)",
      matched: 'rm',
    });
  });

  test('write without classifierReason projects null (non-Bash mutation)', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentMutation('s1', 'worker', 'Write', 'mutate', 'create file.ts', {
      filePath: '/projects/foo/file.ts',
      cwd: '/projects/foo',
      toolUseId: 'tu1',
    });
    const rows = listMultiAgentMutations('s1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.classifierReason).toBeNull();
  });

  test('explicit classifierReason: null projects null', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentMutation('s1', 'worker', 'Bash', 'mutate', 'mv a b', {
      filePath: null,
      cwd: '/projects/foo',
      toolUseId: 'tu1',
      classifierReason: null,
    });
    const rows = listMultiAgentMutations('s1');
    expect(rows[0]?.classifierReason).toBeNull();
  });
});
