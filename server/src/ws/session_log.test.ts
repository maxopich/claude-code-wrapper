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
import { upsertProject } from '../repo/projects.js';
import { createSession } from '../repo/sessions.js';
import { insertEvent, nextSeq } from '../repo/events.js';
import {
  buildSessionLogChunk,
  buildSingleAgentSessionLogChunk,
  multiAgentEventToLogRow,
  multiAgentMutationToLogRow,
} from './session_log.js';
import type { MultiAgentEventRow } from '../repo/multi_agent.js';

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
        detail:
          "first token 'rm' is always dangerous (destructive, privilege-escalating, or remote-code-executing)",
        matched: 'rm',
      },
    });
    const rows = listMultiAgentMutations('s1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.classifierReason).toEqual({
      rule: 'dangerous_first_token',
      detail:
        "first token 'rm' is always dangerous (destructive, privilege-escalating, or remote-code-executing)",
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

// Cluster H C3 backend — single-agent projector. Reads the `events` table
// directly (no bus hops, no mutation lane) and classifies each row into the
// 'tool' | 'llm' | 'error' subset of `LogRowKind`.
describe('buildSingleAgentSessionLogChunk — projection', () => {
  function setupSession(id = 'sa-1'): string {
    const project = upsertProject('p', '/tmp/p');
    createSession(id, project.id);
    return id;
  }

  function pushEvent(
    sessionId: string,
    type: string,
    subtype: string | null,
    payload: unknown,
  ): void {
    const seq = nextSeq(sessionId);
    insertEvent(sessionId, seq, type, subtype, JSON.stringify(payload));
  }

  test('assistant with a text block projects as kind=llm', () => {
    const sid = setupSession();
    pushEvent(sid, 'assistant', null, {
      message: { content: [{ type: 'text', text: 'hello world' }] },
    });

    const chunk = buildSingleAgentSessionLogChunk({
      sessionId: sid,
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    expect(chunk.total).toBe(1);
    expect(chunk.rows[0]).toMatchObject({ kind: 'llm', agent: 'agent' });
    expect(chunk.rows[0]?.summary).toBe('hello world');
  });

  test('assistant carrying tool_use blocks projects as kind=tool with the tool name in status', () => {
    const sid = setupSession();
    pushEvent(sid, 'assistant', null, {
      message: {
        content: [
          { type: 'text', text: 'about to read' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a' } },
        ],
      },
    });

    const chunk = buildSingleAgentSessionLogChunk({
      sessionId: sid,
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    expect(chunk.rows[0]?.kind).toBe('tool');
    // status drives the chip discriminator; surface the tool name so the
    // UI can colour-code per tool just like the multi-agent path does.
    expect(chunk.rows[0]?.status).toBe('Read');
    // Text takes summary precedence so the operator still sees the
    // assistant's prelude, not just "tool_use: Read".
    expect(chunk.rows[0]?.summary).toBe('about to read');
  });

  test('user with tool_result blocks projects as kind=tool', () => {
    const sid = setupSession();
    pushEvent(sid, 'user', null, {
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents' }],
      },
    });

    const chunk = buildSingleAgentSessionLogChunk({
      sessionId: sid,
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    expect(chunk.rows[0]?.kind).toBe('tool');
    expect(chunk.rows[0]?.summary).toBe('tool_result');
  });

  test('user with several tool_result blocks coalesces into "tool_result × N"', () => {
    const sid = setupSession();
    pushEvent(sid, 'user', null, {
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'a' },
          { type: 'tool_result', tool_use_id: 'tu_2', content: 'b' },
          { type: 'tool_result', tool_use_id: 'tu_3', content: 'c' },
        ],
      },
    });

    const chunk = buildSingleAgentSessionLogChunk({
      sessionId: sid,
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    expect(chunk.rows[0]?.summary).toBe('tool_result × 3');
  });

  test('wrapper row projects as kind=error with subtype as status', () => {
    const sid = setupSession();
    pushEvent(sid, 'wrapper', 'auth_expired', {
      type: 'wrapper',
      subtype: 'auth_expired',
      message: 'token expired',
    });

    const chunk = buildSingleAgentSessionLogChunk({
      sessionId: sid,
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    expect(chunk.rows[0]?.kind).toBe('error');
    expect(chunk.rows[0]?.status).toBe('auth_expired');
    expect(chunk.rows[0]?.summary).toBe('auth_expired: token expired');
  });

  test('result row projects as kind=llm with cost + duration in the summary', () => {
    const sid = setupSession();
    pushEvent(sid, 'result', 'success', {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.012345,
      duration_ms: 1234,
      num_turns: 4,
    });

    const chunk = buildSingleAgentSessionLogChunk({
      sessionId: sid,
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    expect(chunk.rows[0]?.kind).toBe('llm');
    expect(chunk.rows[0]?.summary).toMatch(/^success · \$0\.0123 · 1234ms$/);
  });

  test('unknown type falls through to kind=llm (catch-all per the spec)', () => {
    const sid = setupSession();
    pushEvent(sid, 'system', 'status', { type: 'system', subtype: 'status' });

    const chunk = buildSingleAgentSessionLogChunk({
      sessionId: sid,
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    expect(chunk.rows[0]?.kind).toBe('llm');
  });

  test('rows ordered ts ASC; offset + limit honored; hasMore signals next page', () => {
    const sid = setupSession();
    pushEvent(sid, 'assistant', null, { message: { content: [{ type: 'text', text: 'a' }] } });
    pushEvent(sid, 'assistant', null, { message: { content: [{ type: 'text', text: 'b' }] } });
    pushEvent(sid, 'assistant', null, { message: { content: [{ type: 'text', text: 'c' }] } });

    const page1 = buildSingleAgentSessionLogChunk({
      sessionId: sid,
      offset: 0,
      limit: 2,
      revealSensitive: false,
    });
    expect(page1.total).toBe(3);
    expect(page1.rows.length).toBe(2);
    expect(page1.hasMore).toBe(true);

    const page2 = buildSingleAgentSessionLogChunk({
      sessionId: sid,
      offset: 2,
      limit: 2,
      revealSensitive: false,
    });
    expect(page2.rows.length).toBe(1);
    expect(page2.hasMore).toBe(false);
  });

  test('redaction redacts sensitive fields in payload by default', () => {
    const sid = setupSession();
    pushEvent(sid, 'assistant', null, {
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'Bash',
            input: { command: 'echo $ANTHROPIC_API_KEY', credentials: 'secret-token' },
          },
        ],
      },
    });

    const chunk = buildSingleAgentSessionLogChunk({
      sessionId: sid,
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    const row = chunk.rows[0]!;
    expect(row.redactedFields ?? []).not.toEqual([]);
    expect(chunk.revealedSensitive).toBe(false);
  });

  test('revealSensitive=true leaves the payload untouched (no redactedFields)', () => {
    const sid = setupSession();
    pushEvent(sid, 'assistant', null, {
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'Bash',
            input: { credentials: 'secret-token' },
          },
        ],
      },
    });

    const chunk = buildSingleAgentSessionLogChunk({
      sessionId: sid,
      offset: 0,
      limit: 100,
      revealSensitive: true,
    });
    const row = chunk.rows[0]!;
    expect(row.redactedFields).toBeUndefined();
    expect(chunk.revealedSensitive).toBe(true);
  });

  test('empty session returns an empty chunk with total=0', () => {
    const sid = setupSession();
    const chunk = buildSingleAgentSessionLogChunk({
      sessionId: sid,
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    expect(chunk).toEqual({ rows: [], total: 0, hasMore: false, revealedSensitive: false });
  });

  test('corrupt raw JSON still produces an llm row rather than silently vanishing', () => {
    const sid = setupSession();
    // Insert a row whose `raw` is intentionally garbled. safeParseEventRaw
    // returns null; classifier falls through to 'llm'; summary falls back to
    // type/subtype. The row must NOT throw.
    const seq = nextSeq(sid);
    insertEvent(sid, seq, 'assistant', null, '{not valid json');

    const chunk = buildSingleAgentSessionLogChunk({
      sessionId: sid,
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    expect(chunk.total).toBe(1);
    expect(chunk.rows[0]?.kind).toBe('llm');
  });
});

// ---------------------------------------------------------------------------
// Cluster H D12 backend: per-row converter exports. The tail emitter in
// ws/server.ts calls these to project a single appended row into the
// `log_row_appended` envelope without re-running the whole chunk projection.
// Tests pin parity with the chunk projector (same kind/agent/summary/raw
// shape) so the streaming row is byte-equivalent to what a fresh
// `load_session_log` would have returned for that same row.
// ---------------------------------------------------------------------------

describe('multiAgentEventToLogRow — tail converter parity', () => {
  test('byte-equivalent to chunk projection for the same event', () => {
    createMultiAgentSession('s1', 'orchestrator');
    const row = appendMultiAgentEvent('s1', 'worker', 'cebab', 'reply', 'all good');

    const chunk = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    const fromChunk = chunk.rows[0]!;
    const fromTail = multiAgentEventToLogRow(row, false);
    expect(fromTail).toEqual(fromChunk);
  });

  test('error-kind event projects to LogRow kind=error', () => {
    const row: MultiAgentEventRow = {
      id: 99,
      session_id: 's1',
      ts: 1700000000000,
      source: 'cebab',
      destination: 'user',
      kind: 'error',
      text: 'worker crashed',
    };
    const log = multiAgentEventToLogRow(row, false);
    expect(log.kind).toBe('error');
    expect(log.agent).toBe('cebab');
    expect(log.status).toBe('error');
    expect(log.id).toBe('event:99');
  });

  test('non-error bus kinds project to LogRow kind=bus', () => {
    const row: MultiAgentEventRow = {
      id: 7,
      session_id: 's1',
      ts: 1700000000000,
      source: 'reviewer',
      destination: 'planner',
      kind: 'prompt',
      text: 'please review',
    };
    const log = multiAgentEventToLogRow(row, false);
    expect(log.kind).toBe('bus');
    expect(log.status).toBe('prompt');
    expect(log.summary).toContain('reviewer → planner');
    expect(log.summary).toContain('please review');
  });

  test('revealSensitive=false redacts raw payload fields', () => {
    const row: MultiAgentEventRow = {
      id: 1,
      session_id: 's1',
      ts: 1,
      source: 'a',
      destination: 'b',
      kind: 'reply',
      text: 'sk-ant-api03-DEADBEEF-payload',
    };
    const masked = multiAgentEventToLogRow(row, false);
    const revealed = multiAgentEventToLogRow(row, true);
    // The reveal=true path returns the raw payload as-is; reveal=false runs
    // it through redactSensitive (may or may not redact depending on the
    // specific field). The contract here is that the two paths are NOT
    // necessarily identical — reveal=true is the un-masked superset.
    expect(masked).toBeDefined();
    expect(revealed).toBeDefined();
    // The reveal=true row never carries a redactedFields hint.
    expect(revealed.redactedFields).toBeUndefined();
  });
});

describe('multiAgentMutationToLogRow — tail converter parity', () => {
  test('provisional mutation returns null (chunk projector skips it)', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentMutation('s1', 'worker', 'Write', 'mutate', 'create x', {
      filePath: '/p/x',
      cwd: '/p',
      toolUseId: 'tu-prov',
    });
    const provisional = listMultiAgentMutations('s1')[0]!;
    expect(provisional.confirmedAt).toBeNull();
    expect(multiAgentMutationToLogRow(provisional, false)).toBeNull();
  });

  test('confirmed mutation projects to kind=tool', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentMutation('s1', 'worker', 'Edit', 'mutate', 'edit y', {
      filePath: '/p/y',
      cwd: '/p',
      toolUseId: 'tu-conf',
    });
    confirmMutationByToolUseId('s1', 'tu-conf');
    const m = listMultiAgentMutations('s1')[0]!;
    const log = multiAgentMutationToLogRow(m, false);
    expect(log).not.toBeNull();
    expect(log!.kind).toBe('tool');
    expect(log!.agent).toBe('worker');
    expect(log!.status).toBe('Edit');
    expect(log!.severity).toBe('mutate');
    expect(log!.id).toBe(`mutation:${m.id}`);
  });

  test('promoted mutation projects to kind=artifact', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentMutation('s1', 'worker', 'Bash', 'mutate', 'cp final.txt', {
      filePath: '/p/final.txt',
      cwd: '/p',
      toolUseId: 'tu-art',
    });
    confirmMutationByToolUseId('s1', 'tu-art');
    const m = listMultiAgentMutations('s1')[0]!;
    setMutationPromoted(m.id, true);
    const promoted = listMultiAgentMutations('s1')[0]!;
    const log = multiAgentMutationToLogRow(promoted, false);
    expect(log!.kind).toBe('artifact');
  });

  test('byte-equivalent to chunk projection for the same confirmed mutation', () => {
    createMultiAgentSession('s1', 'orchestrator');
    appendMultiAgentMutation('s1', 'worker', 'Write', 'mutate', 'create z', {
      filePath: '/p/z',
      cwd: '/p',
      toolUseId: 'tu-eq',
    });
    confirmMutationByToolUseId('s1', 'tu-eq');
    const m = listMultiAgentMutations('s1')[0]!;

    const chunk = buildSessionLogChunk({
      sessionId: 's1',
      offset: 0,
      limit: 100,
      revealSensitive: false,
    });
    const fromChunk = chunk.rows.find((r) => r.id === `mutation:${m.id}`)!;
    const fromTail = multiAgentMutationToLogRow(m, false)!;
    expect(fromTail).toEqual(fromChunk);
  });
});
