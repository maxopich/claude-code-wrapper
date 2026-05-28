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
  listControlStates,
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
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'multi_agent_participants'",
      )
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
