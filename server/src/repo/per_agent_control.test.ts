import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { addParticipant, createMultiAgentSession } from './multi_agent.js';
import { upsertProject } from './projects.js';
import {
  clearParticipantPause,
  getControlState,
  isKickMode,
  isPauseExpiryAction,
  listActivePauseEntries,
  listControlStates,
  listKickedAgentNames,
  listMutedAgentNames,
  setParticipantKicked,
  setParticipantMuted,
  setParticipantPause,
} from './per_agent_control.js';

// Cluster C Phase 4a (Part 2 backend foundation, spec §5.4): per-agent
// control-state repo. Real SQLite under a tmp data dir so migration 020's
// columns actually exist and the queries hit the real schema.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-control-state-'));
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

function seedParticipants(sessionId = 'sess-1'): { orchestratorId: number; workerId: number } {
  // Project rows have to exist before participants can FK to them.
  const orchestratorRow = upsertProject('orch', '/tmp/orch');
  const workerRow = upsertProject('worker', '/tmp/worker');
  createMultiAgentSession(sessionId, 'orchestrator');
  addParticipant(sessionId, orchestratorRow.id, 'orchestrator');
  addParticipant(sessionId, workerRow.id, 'worker');
  return { orchestratorId: orchestratorRow.id, workerId: workerRow.id };
}

describe('migration 020 + repo defaults', () => {
  test('fresh participant rows default to "no control state ever applied"', () => {
    const { workerId } = seedParticipants();
    const state = getControlState('sess-1', workerId);
    expect(state).toBeDefined();
    expect(state).toEqual({
      sessionId: 'sess-1',
      projectId: workerId,
      muted: false,
      pausedUntil: null,
      pauseExpiryAction: null,
      kickedAt: null,
      kickedMode: null,
    });
  });

  test('migration 020 added the 5 columns to multi_agent_participants', () => {
    type ColInfo = { name: string; notnull: number; dflt_value: string | null };
    const cols = getDb().pragma('table_info(multi_agent_participants)') as ColInfo[];
    const colMap = new Map(cols.map((c) => [c.name, c]));
    expect(colMap.has('muted')).toBe(true);
    expect(colMap.get('muted')?.notnull).toBe(1);
    expect(colMap.get('muted')?.dflt_value).toBe('0');
    expect(colMap.has('paused_until')).toBe(true);
    expect(colMap.get('paused_until')?.notnull).toBe(0);
    expect(colMap.has('pause_expiry_action')).toBe(true);
    expect(colMap.has('kicked_at')).toBe(true);
    expect(colMap.has('kicked_mode')).toBe(true);
  });

  test('control-state index exists', () => {
    const idxs = getDb()
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'multi_agent_participants'")
      .all();
    expect(idxs.some((r) => r.name === 'multi_agent_participants_control_state')).toBe(true);
  });
});

describe('getControlState / listControlStates', () => {
  test('getControlState returns undefined for unknown participant', () => {
    seedParticipants();
    expect(getControlState('sess-1', 99_999)).toBeUndefined();
  });

  test('listControlStates returns every participant in projectId order', () => {
    const { orchestratorId, workerId } = seedParticipants();
    const states = listControlStates('sess-1');
    expect(states).toHaveLength(2);
    expect(states[0]?.projectId).toBe(Math.min(orchestratorId, workerId));
    expect(states[1]?.projectId).toBe(Math.max(orchestratorId, workerId));
  });

  test('listControlStates for unknown session returns []', () => {
    seedParticipants();
    expect(listControlStates('sess-other')).toEqual([]);
  });
});

describe('setParticipantMuted', () => {
  test('flips 0 → 1 once; re-muting is a no-op (returns false)', () => {
    const { workerId } = seedParticipants();
    expect(setParticipantMuted('sess-1', workerId, true)).toBe(true);
    expect(getControlState('sess-1', workerId)?.muted).toBe(true);
    expect(setParticipantMuted('sess-1', workerId, true)).toBe(false);
  });

  test('unmute flips 1 → 0', () => {
    const { workerId } = seedParticipants();
    setParticipantMuted('sess-1', workerId, true);
    expect(setParticipantMuted('sess-1', workerId, false)).toBe(true);
    expect(getControlState('sess-1', workerId)?.muted).toBe(false);
  });

  test('mute on unknown participant returns false (no row changed)', () => {
    seedParticipants();
    expect(setParticipantMuted('sess-1', 99_999, true)).toBe(false);
  });
});

describe('setParticipantPause / clearParticipantPause', () => {
  test('begins a pause; second pause without resume returns false', () => {
    const { workerId } = seedParticipants();
    expect(setParticipantPause('sess-1', workerId, 1_700_000_010_000, 'auto_resume')).toBe(true);
    const state = getControlState('sess-1', workerId)!;
    expect(state.pausedUntil).toBe(1_700_000_010_000);
    expect(state.pauseExpiryAction).toBe('auto_resume');
    // re-pausing without clearing first is a no-op
    expect(setParticipantPause('sess-1', workerId, 9_999_999_999_999, 'auto_kick')).toBe(false);
    // existing values preserved
    expect(getControlState('sess-1', workerId)?.pausedUntil).toBe(1_700_000_010_000);
  });

  test('resume clears both pause fields; second resume returns false', () => {
    const { workerId } = seedParticipants();
    setParticipantPause('sess-1', workerId, 1_700_000_010_000, 'auto_resume');
    expect(clearParticipantPause('sess-1', workerId)).toBe(true);
    expect(getControlState('sess-1', workerId)?.pausedUntil).toBeNull();
    expect(getControlState('sess-1', workerId)?.pauseExpiryAction).toBeNull();
    // already cleared → no-op
    expect(clearParticipantPause('sess-1', workerId)).toBe(false);
  });

  test('pause leaves muted + kicked untouched (orthogonal verbs)', () => {
    const { workerId } = seedParticipants();
    setParticipantMuted('sess-1', workerId, true);
    setParticipantPause('sess-1', workerId, 1_700_000_010_000, 'auto_resume');
    const state = getControlState('sess-1', workerId)!;
    expect(state.muted).toBe(true);
    expect(state.kickedAt).toBeNull();
  });

  test('resume leaves muted + kicked untouched', () => {
    const { workerId } = seedParticipants();
    setParticipantMuted('sess-1', workerId, true);
    setParticipantKicked('sess-1', workerId, 1_700_000_009_000, 'drain');
    setParticipantPause('sess-1', workerId, 1_700_000_010_000, 'auto_resume');
    clearParticipantPause('sess-1', workerId);
    const state = getControlState('sess-1', workerId)!;
    expect(state.muted).toBe(true);
    expect(state.kickedAt).toBe(1_700_000_009_000);
  });
});

describe('setParticipantKicked', () => {
  test('marks kicked once; second kick attempt returns false', () => {
    const { workerId } = seedParticipants();
    expect(setParticipantKicked('sess-1', workerId, 1_700_000_005_000, 'drain')).toBe(true);
    const state = getControlState('sess-1', workerId)!;
    expect(state.kickedAt).toBe(1_700_000_005_000);
    expect(state.kickedMode).toBe('drain');
    // re-kick (even with a different mode) is a no-op — verb is one-way per spec §5.1
    expect(setParticipantKicked('sess-1', workerId, 1_700_000_006_000, 'hard')).toBe(false);
    expect(getControlState('sess-1', workerId)?.kickedMode).toBe('drain');
  });
});

describe('type guards', () => {
  test('isPauseExpiryAction accepts only auto_resume / auto_kick', () => {
    expect(isPauseExpiryAction('auto_resume')).toBe(true);
    expect(isPauseExpiryAction('auto_kick')).toBe(true);
    expect(isPauseExpiryAction('hard_stop')).toBe(false);
    expect(isPauseExpiryAction('')).toBe(false);
    expect(isPauseExpiryAction(undefined)).toBe(false);
    expect(isPauseExpiryAction(null)).toBe(false);
  });

  test('isKickMode accepts only drain / hard', () => {
    expect(isKickMode('drain')).toBe(true);
    expect(isKickMode('hard')).toBe(true);
    expect(isKickMode('soft')).toBe(false);
    expect(isKickMode(undefined)).toBe(false);
  });
});

// ===== Cluster C Phase 4e: reseed read helpers =====
//
// These helpers feed the R-B reconstruct path's seed arrays for the
// rebuilt router's mute/kick sets + the pause-expiry registry's timer
// rehydration. Each helper JOINs `multi_agent_participants` with
// `projects` to get the bus_agent_name (the router's key), so a
// participant whose project lacks a bus slug is filtered out — the
// router wouldn't be able to address it anyway.

function seedWithSlugs(sessionId = 'sess-1'): {
  orchestratorId: number;
  workerAId: number;
  workerBId: number;
} {
  const orch = upsertProject('orch', '/tmp/orch');
  const wa = upsertProject('worker-a', '/tmp/wa');
  const wb = upsertProject('worker-b', '/tmp/wb');
  // Slugs required for the JOIN-based helpers to return the participant.
  getDb()
    .prepare('UPDATE projects SET bus_agent_name = ?, bus_installed = 1 WHERE id = ?')
    .run('alpha', wa.id);
  getDb()
    .prepare('UPDATE projects SET bus_agent_name = ?, bus_installed = 1 WHERE id = ?')
    .run('beta', wb.id);
  createMultiAgentSession(sessionId, 'orchestrator');
  addParticipant(sessionId, orch.id, 'orchestrator');
  addParticipant(sessionId, wa.id, 'worker');
  addParticipant(sessionId, wb.id, 'worker');
  return { orchestratorId: orch.id, workerAId: wa.id, workerBId: wb.id };
}

describe('listMutedAgentNames', () => {
  test('returns slugs of every muted participant for the session', () => {
    const { workerAId, workerBId } = seedWithSlugs();
    setParticipantMuted('sess-1', workerAId, true);
    setParticipantMuted('sess-1', workerBId, true);
    expect(listMutedAgentNames('sess-1').sort()).toEqual(['alpha', 'beta']);
  });

  test('excludes unmuted participants', () => {
    const { workerAId } = seedWithSlugs();
    setParticipantMuted('sess-1', workerAId, true);
    expect(listMutedAgentNames('sess-1')).toEqual(['alpha']);
  });

  test('skips participants whose bus_agent_name is NULL (unhealthy row)', () => {
    const { workerAId, workerBId } = seedWithSlugs();
    setParticipantMuted('sess-1', workerAId, true);
    setParticipantMuted('sess-1', workerBId, true);
    // Strip the slug from worker A — JOIN filters them out.
    getDb().prepare('UPDATE projects SET bus_agent_name = NULL WHERE id = ?').run(workerAId);
    expect(listMutedAgentNames('sess-1')).toEqual(['beta']);
  });

  test('returns empty for unknown session', () => {
    expect(listMutedAgentNames('sess-unknown')).toEqual([]);
  });

  test('scope is per session (other sessions do not bleed in)', () => {
    const { workerAId: a1 } = seedWithSlugs('sess-1');
    // Create a second session whose worker uses a different slug.
    const otherWorker = upsertProject('other-worker', '/tmp/ow');
    getDb()
      .prepare('UPDATE projects SET bus_agent_name = ?, bus_installed = 1 WHERE id = ?')
      .run('gamma', otherWorker.id);
    createMultiAgentSession('sess-2', 'orchestrator');
    addParticipant('sess-2', otherWorker.id, 'worker');
    setParticipantMuted('sess-1', a1, true);
    setParticipantMuted('sess-2', otherWorker.id, true);
    expect(listMutedAgentNames('sess-1')).toEqual(['alpha']);
    expect(listMutedAgentNames('sess-2')).toEqual(['gamma']);
  });
});

describe('listKickedAgentNames', () => {
  test('returns slugs of every kicked participant', () => {
    const { workerAId } = seedWithSlugs();
    setParticipantKicked('sess-1', workerAId, 1_700_000_000_000, 'drain');
    expect(listKickedAgentNames('sess-1')).toEqual(['alpha']);
  });

  test('excludes non-kicked participants', () => {
    seedWithSlugs();
    expect(listKickedAgentNames('sess-1')).toEqual([]);
  });

  test('kick is irreversible — DB row stays in the list after any subsequent action', () => {
    const { workerAId } = seedWithSlugs();
    setParticipantKicked('sess-1', workerAId, 1_700_000_000_000, 'drain');
    setParticipantMuted('sess-1', workerAId, true); // muting AFTER kick doesn't remove from kicked list
    expect(listKickedAgentNames('sess-1')).toEqual(['alpha']);
  });
});

describe('listActivePauseEntries', () => {
  test('returns full pause snapshot for every actively-paused participant', () => {
    const { workerAId, workerBId } = seedWithSlugs();
    setParticipantPause('sess-1', workerAId, 1_700_000_010_000, 'auto_resume');
    setParticipantPause('sess-1', workerBId, 1_700_000_020_000, 'auto_kick');
    const entries = listActivePauseEntries('sess-1');
    expect(entries).toHaveLength(2);
    const byAgent = new Map(entries.map((e) => [e.agentName, e]));
    expect(byAgent.get('alpha')).toEqual({
      projectId: workerAId,
      agentName: 'alpha',
      pausedUntil: 1_700_000_010_000,
      pauseExpiryAction: 'auto_resume',
    });
    expect(byAgent.get('beta')).toEqual({
      projectId: workerBId,
      agentName: 'beta',
      pausedUntil: 1_700_000_020_000,
      pauseExpiryAction: 'auto_kick',
    });
  });

  test('excludes participants whose pause was cleared', () => {
    const { workerAId, workerBId } = seedWithSlugs();
    setParticipantPause('sess-1', workerAId, 1_700_000_010_000, 'auto_resume');
    setParticipantPause('sess-1', workerBId, 1_700_000_010_000, 'auto_resume');
    clearParticipantPause('sess-1', workerAId);
    expect(listActivePauseEntries('sess-1').map((e) => e.agentName)).toEqual(['beta']);
  });

  test('filters rows with corrupted pause_expiry_action via the type guard', () => {
    const { workerAId } = seedWithSlugs();
    setParticipantPause('sess-1', workerAId, 1_700_000_010_000, 'auto_resume');
    // Simulate corruption (would never happen via the typed repo writes).
    getDb()
      .prepare('UPDATE multi_agent_participants SET pause_expiry_action = ? WHERE project_id = ?')
      .run('escalate', workerAId);
    expect(listActivePauseEntries('sess-1')).toEqual([]);
  });

  test('skips participants without bus_agent_name', () => {
    const { workerAId } = seedWithSlugs();
    setParticipantPause('sess-1', workerAId, 1_700_000_010_000, 'auto_resume');
    getDb().prepare('UPDATE projects SET bus_agent_name = NULL WHERE id = ?').run(workerAId);
    expect(listActivePauseEntries('sess-1')).toEqual([]);
  });
});
