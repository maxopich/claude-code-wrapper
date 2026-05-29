import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { upsertProject } from './projects.js';
import { archiveSession, createSession, softDeleteSession } from './sessions.js';
import { insertEvent, nextSeq } from './events.js';
import {
  addParticipant,
  appendMultiAgentEvent,
  archiveMultiAgentSession,
  createMultiAgentSession,
} from './multi_agent.js';
import { MIN_SEARCH_QUERY_LEN, searchSessions } from './search.js';

// Cluster I Phase C4 (UI_Findings spec §4.2): server-side coverage for the
// tier-1 cross-session LIKE scan. We spin a real SQLite under a tmp `~/.cebab`
// so the JOINs against `sessions`/`projects`/`multi_agent_*` + the
// `redactSensitive` snippet path all run through production code.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-search-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // applies 001..025
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Build a realistic single-agent SDK `assistant` envelope with one text block. */
function assistantRaw(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    ...extra,
  });
}

function seedProject(name: string): number {
  return upsertProject(name, path.join(tmpRoot, name)).id;
}

/** Create a session + push one assistant event carrying `text`. */
function seedSessionWithText(
  projectId: number,
  sessionId: string,
  text: string,
  extra: Record<string, unknown> = {},
): void {
  createSession(sessionId, projectId);
  insertEvent(sessionId, nextSeq(sessionId), 'assistant', null, assistantRaw(text, extra));
}

describe('searchSessions — single-agent LIKE scan', () => {
  test('matches a content word and returns a redacted, windowed snippet', () => {
    const pid = seedProject('p');
    seedSessionWithText(pid, 's1', 'here is the migration plan for the auth service');

    const { results, truncated } = searchSessions({ query: 'migration', scope: 'all_projects' });

    expect(results).toHaveLength(1);
    const hit = results[0]!;
    expect(hit.sessionId).toBe('s1');
    expect(hit.projectId).toBe(pid);
    expect(hit.projectName).toBe('p');
    expect(hit.matchedField).toBe('events.raw');
    expect(hit.matchedKind).toBe('assistant');
    expect(hit.snippet.toLowerCase()).toContain('migration');
    expect(truncated).toBe(false);
  });

  test('LIKE match is case-insensitive', () => {
    const pid = seedProject('p');
    seedSessionWithText(pid, 's1', 'Deploy The Thing Now');
    const { results } = searchSessions({ query: 'DEPLOY', scope: 'all_projects' });
    expect(results).toHaveLength(1);
    expect(results[0]!.snippet.toLowerCase()).toContain('deploy');
  });

  test(`queries shorter than ${MIN_SEARCH_QUERY_LEN} chars return nothing (no full-table scan)`, () => {
    const pid = seedProject('p');
    seedSessionWithText(pid, 's1', 'anything at all');
    expect(searchSessions({ query: 'a', scope: 'all_projects' }).results).toEqual([]);
    expect(searchSessions({ query: '', scope: 'all_projects' }).results).toEqual([]);
    expect(searchSessions({ query: '   ', scope: 'all_projects' }).results).toEqual([]);
  });

  test('matching a JSON key name (not a value) yields no hit — field-name noise reduction', () => {
    const pid = seedProject('p');
    // The raw envelope literally contains the keys "message" and "content",
    // but the text value does not. A content search must not surface them.
    seedSessionWithText(pid, 's1', 'the migration plan');
    expect(searchSessions({ query: 'content', scope: 'all_projects' }).results).toEqual([]);
    expect(searchSessions({ query: 'message', scope: 'all_projects' }).results).toEqual([]);
    // The value IS searchable.
    expect(searchSessions({ query: 'migration', scope: 'all_projects' }).results).toHaveLength(1);
  });

  test('no match returns an empty, non-truncated result set', () => {
    const pid = seedProject('p');
    seedSessionWithText(pid, 's1', 'nothing relevant here');
    expect(searchSessions({ query: 'zzzznope', scope: 'all_projects' })).toEqual({
      results: [],
      truncated: false,
    });
  });
});

describe('[security] searchSessions — containment / redaction invariant (C4-5 / R-I5)', () => {
  const SECRET = 'supersecretvalue123';

  test('a benign-word hit never leaks a redacted sibling secret into the snippet', () => {
    const pid = seedProject('p');
    // `api_key` is a Tier-1 sensitive key → redactSensitive masks its value.
    seedSessionWithText(pid, 's1', 'hello world from the agent', { api_key: SECRET });

    const { results } = searchSessions({ query: 'hello', scope: 'all_projects' });
    expect(results).toHaveLength(1);
    const hit = results[0]!;
    expect(hit.snippet).toContain('hello');
    // The whole snippet is built from the redacted object — the secret bytes
    // are gone even though the raw row (which the LIKE scanned) still has them.
    expect(hit.snippet).not.toContain(SECRET);
    // And the UI gets told the row contained redacted content.
    expect(hit.redactedFields).toContain('api_key');
  });

  test('searching FOR the secret value returns nothing (the match lived only in a redacted field)', () => {
    const pid = seedProject('p');
    seedSessionWithText(pid, 's1', 'hello world', { api_key: SECRET });
    // The raw row contains SECRET, so the SQL LIKE matches — but after
    // redaction the value is `<redacted>`, so the query isn't found in the
    // snippet haystack and the row is dropped. No existence-or-content leak.
    const { results } = searchSessions({ query: SECRET, scope: 'all_projects' });
    expect(results).toEqual([]);
  });

  test('raw opt-in bypasses redaction (the privileged path)', () => {
    const pid = seedProject('p');
    seedSessionWithText(pid, 's1', 'hello world', { api_key: SECRET });
    const { results } = searchSessions({ query: SECRET, scope: 'all_projects', raw: true });
    expect(results).toHaveLength(1);
    expect(results[0]!.snippet).toContain(SECRET);
  });

  test('multi-agent text secrets (Tier-3 inline) never surface in snippets', () => {
    const pid = seedProject('p');
    const sid = 'bus-1';
    createMultiAgentSession(sid, 'orchestrator');
    addParticipant(sid, pid, 'orchestrator');
    // An AWS access key inside a hop body — Tier-3 inline pattern
    // (`AKIA` + 16 [0-9A-Z]); the canonical AWS docs example value.
    const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
    appendMultiAgentEvent(sid, 'orchestrator', 'worker', 'prompt', `use creds ${AWS_KEY} please`);

    // `redactSensitive` masks the WHOLE `text` value when it contains an
    // inline secret (same as the per-session view), so the redacted path can
    // neither find nor snippet the key — searching it returns nothing.
    expect(searchSessions({ query: AWS_KEY, scope: 'all_projects' }).results).toEqual([]);

    // The raw opt-in surfaces it, proving the row IS otherwise matchable —
    // the redacted path's empty result is masking, not a missing row.
    const raw = searchSessions({ query: AWS_KEY, scope: 'all_projects', raw: true });
    expect(raw.results).toHaveLength(1);
    expect(raw.results[0]!.snippet).toContain(AWS_KEY);
  });
});

describe('searchSessions — archived / soft-deleted filtering', () => {
  test('archived sessions are excluded by default, included with includeArchived', () => {
    const pid = seedProject('p');
    seedSessionWithText(pid, 'live', 'shared keyword alpha');
    seedSessionWithText(pid, 'arch', 'shared keyword alpha');
    archiveSession('arch');

    const def = searchSessions({ query: 'keyword', scope: 'all_projects' });
    expect(def.results.map((r) => r.sessionId)).toEqual(['live']);

    const incl = searchSessions({ query: 'keyword', scope: 'all_projects', includeArchived: true });
    expect(incl.results.map((r) => r.sessionId).sort()).toEqual(['arch', 'live']);
  });

  test('soft-deleted sessions are NEVER returned — even with includeArchived', () => {
    const pid = seedProject('p');
    seedSessionWithText(pid, 'live', 'shared keyword beta');
    seedSessionWithText(pid, 'gone', 'shared keyword beta');
    softDeleteSession('gone');

    expect(
      searchSessions({ query: 'keyword', scope: 'all_projects' }).results.map((r) => r.sessionId),
    ).toEqual(['live']);
    expect(
      searchSessions({
        query: 'keyword',
        scope: 'all_projects',
        includeArchived: true,
      }).results.map((r) => r.sessionId),
    ).toEqual(['live']);
  });

  test('archived multi-agent sessions are excluded by default', () => {
    const pid = seedProject('p');
    const sid = 'bus-arch';
    createMultiAgentSession(sid, 'chain');
    addParticipant(sid, pid, 'worker', 0);
    appendMultiAgentEvent(sid, 'user', 'worker', 'prompt', 'archived bus keyword gamma');
    archiveMultiAgentSession(sid);

    expect(searchSessions({ query: 'gamma', scope: 'all_projects' }).results).toEqual([]);
    expect(
      searchSessions({ query: 'gamma', scope: 'all_projects', includeArchived: true }).results,
    ).toHaveLength(1);
  });
});

describe('searchSessions — scope', () => {
  test('this_project restricts single-agent hits to the named projectId', () => {
    const p1 = seedProject('p1');
    const p2 = seedProject('p2');
    seedSessionWithText(p1, 's1', 'cross project term delta');
    seedSessionWithText(p2, 's2', 'cross project term delta');

    const scoped = searchSessions({ query: 'delta', scope: 'this_project', projectId: p1 });
    expect(scoped.results.map((r) => r.sessionId)).toEqual(['s1']);

    const all = searchSessions({ query: 'delta', scope: 'all_projects' });
    expect(all.results.map((r) => r.sessionId).sort()).toEqual(['s1', 's2']);
  });

  test('this_project restricts multi-agent hits via the participant join', () => {
    const p1 = seedProject('p1');
    const p2 = seedProject('p2');
    const busA = 'bus-a';
    createMultiAgentSession(busA, 'orchestrator');
    addParticipant(busA, p1, 'orchestrator');
    appendMultiAgentEvent(busA, 'orchestrator', 'user', 'final', 'epsilon result body');

    // Scoped to p2 → the bus session (rooted in p1) is excluded.
    expect(
      searchSessions({ query: 'epsilon', scope: 'this_project', projectId: p2 }).results,
    ).toEqual([]);
    // Scoped to p1 → found.
    expect(
      searchSessions({ query: 'epsilon', scope: 'this_project', projectId: p1 }).results,
    ).toHaveLength(1);
  });
});

describe('searchSessions — multi-agent stream', () => {
  test('matches multi_agent_events.text with the hop kind as matchedKind', () => {
    const pid = seedProject('p');
    const sid = 'bus-1';
    createMultiAgentSession(sid, 'orchestrator');
    addParticipant(sid, pid, 'orchestrator');
    appendMultiAgentEvent(
      sid,
      'orchestrator',
      'worker',
      'reply',
      'please refactor the parser module',
    );

    const { results } = searchSessions({ query: 'refactor', scope: 'all_projects' });
    expect(results).toHaveLength(1);
    const hit = results[0]!;
    expect(hit.sessionId).toBe(sid);
    expect(hit.matchedField).toBe('multi_agent_events.text');
    expect(hit.matchedKind).toBe('reply');
    // A bus session spans projects → no single owner is named.
    expect(hit.projectId).toBeUndefined();
    expect(hit.projectName).toBeUndefined();
  });

  test('single-agent + multi-agent hits merge, newest-first', () => {
    const pid = seedProject('p');
    seedSessionWithText(pid, 's1', 'omega appears here');
    const sid = 'bus-1';
    createMultiAgentSession(sid, 'chain');
    addParticipant(sid, pid, 'worker', 0);
    appendMultiAgentEvent(sid, 'user', 'worker', 'prompt', 'omega appears in the bus too');

    const { results } = searchSessions({ query: 'omega', scope: 'all_projects' });
    expect(results).toHaveLength(2);
    expect(new Set(results.map((r) => r.matchedField))).toEqual(
      new Set(['events.raw', 'multi_agent_events.text']),
    );
    // Sorted newest-first.
    expect(results[0]!.ts).toBeGreaterThanOrEqual(results[1]!.ts);
  });
});

describe('searchSessions — limit + truncation + LIKE escaping', () => {
  test('clamps to limit and flags truncated when the cap is hit', () => {
    const pid = seedProject('p');
    createSession('s1', pid);
    for (let i = 0; i < 5; i++) {
      insertEvent('s1', nextSeq('s1'), 'assistant', null, assistantRaw(`lambda hit number ${i}`));
    }
    const { results, truncated } = searchSessions({
      query: 'lambda',
      scope: 'all_projects',
      limit: 2,
    });
    expect(results).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  test('LIKE wildcards in the query are matched literally (escaped)', () => {
    const pid = seedProject('p');
    seedSessionWithText(pid, 'pct', 'progress is 100%done today');
    seedSessionWithText(pid, 'plain', 'progress is 100Xdone today');
    // "100%" must match only the literal-percent row, not act as a wildcard.
    const { results } = searchSessions({ query: '100%', scope: 'all_projects' });
    expect(results.map((r) => r.sessionId)).toEqual(['pct']);
  });
});
