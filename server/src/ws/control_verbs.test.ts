import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ClientMsg } from '@cebab/shared';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { addParticipant, createMultiAgentSession } from '../repo/multi_agent.js';
import { upsertProject } from '../repo/projects.js';
import {
  executeMuteParticipant,
  executeUnmuteParticipant,
  buildParticipantMuteChangedMsg,
} from './control_verbs.js';
import { getControlState, setParticipantMuted } from '../repo/per_agent_control.js';

// Cluster C Phase 4b: WS handler-level tests for executeMuteParticipant /
// executeUnmuteParticipant. Exercises the full validation chain (reason
// code, topology, participant, role) + the DB flip + router-sync + audit
// dual-write. Real SQLite under a tmp data dir so the safety_audit append
// + per_agent_control updates go through production code.

let tmpRoot: string;
let originalDataDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-control-handler-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  errSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function seedSession() {
  const orchRow = upsertProject('orch', '/tmp/orch');
  const workerRow = upsertProject('worker', '/tmp/worker');
  // The worker MUST have a bus_agent_name for mute to apply (the router's
  // mute set is keyed by slug).
  getDb()
    .prepare('UPDATE projects SET bus_agent_name = ?, bus_installed = 1 WHERE id = ?')
    .run('worker-slug', workerRow.id);
  createMultiAgentSession('sess-1', 'orchestrator');
  addParticipant('sess-1', orchRow.id, 'orchestrator');
  addParticipant('sess-1', workerRow.id, 'worker');
  return { orchestratorId: orchRow.id, workerId: workerRow.id };
}

function muteMsg(
  overrides: Partial<Extract<ClientMsg, { type: 'mute_participant' }>> = {},
): Extract<ClientMsg, { type: 'mute_participant' }> {
  return {
    type: 'mute_participant',
    sessionId: 'sess-1',
    projectId: 0, // overridden by callers
    reasonCode: 'off_task',
    ...overrides,
  };
}

function makeFakeOrchestratorHandle() {
  const mutedSet = new Set<string>();
  return {
    setMute: vi.fn((name: string, muted: boolean) => {
      const was = mutedSet.has(name);
      if (muted === was) return false;
      if (muted) mutedSet.add(name);
      else mutedSet.delete(name);
      return true;
    }),
    isMuted: vi.fn((name: string) => mutedSet.has(name)),
  };
}

describe('executeMuteParticipant — happy path', () => {
  test('flips DB column, calls handle.setMute, writes safety_audit, returns ok', () => {
    const { workerId } = seedSession();
    const handle = makeFakeOrchestratorHandle();
    const result = executeMuteParticipant({
      msg: muteMsg({ projectId: workerId, reasonCode: 'runaway_loop' }),
      orchestratorHandle: handle,
      sessionMode: 'orchestrator',
    });
    expect(result.ok).toBe(true);
    expect(getControlState('sess-1', workerId)?.muted).toBe(true);
    expect(handle.setMute).toHaveBeenCalledWith('worker-slug', true);
    // safety_audit row written with kind='agent_control.muted'
    const audit = getDb()
      .prepare<[string], { kind: string; reason_code: string; agent_id: string }>(
        'SELECT kind, reason_code, agent_id FROM safety_audit WHERE kind = ?',
      )
      .get('agent_control.muted');
    expect(audit?.kind).toBe('agent_control.muted');
    expect(audit?.reason_code).toBe('runaway_loop');
    expect(audit?.agent_id).toBe('worker-slug');
  });

  test('reasonText (when provided) lands in the audit payload', () => {
    const { workerId } = seedSession();
    executeMuteParticipant({
      msg: muteMsg({ projectId: workerId, reasonCode: 'other', reasonText: 'spammy outbound' }),
      orchestratorHandle: makeFakeOrchestratorHandle(),
      sessionMode: 'orchestrator',
    });
    const audit = getDb()
      .prepare<[], { payload_json: string }>(
        "SELECT payload_json FROM safety_audit WHERE kind = 'agent_control.muted'",
      )
      .get();
    const payload = JSON.parse(audit!.payload_json) as { reasonText: string };
    expect(payload.reasonText).toBe('spammy outbound');
  });

  test('now seam controls audit row ts', () => {
    const { workerId } = seedSession();
    const appendAudit = vi.fn(() => ({ id: 'fake', hash_self: Buffer.alloc(32) }));
    executeMuteParticipant({
      msg: muteMsg({ projectId: workerId }),
      orchestratorHandle: makeFakeOrchestratorHandle(),
      sessionMode: 'orchestrator',
      appendAudit,
      now: () => 1_700_000_000_001,
    });
    expect(appendAudit).toHaveBeenCalledWith(expect.objectContaining({ ts: 1_700_000_000_001 }));
  });
});

describe('executeMuteParticipant — failure codes', () => {
  test('unknown session → participant_not_found', () => {
    const result = executeMuteParticipant({
      msg: muteMsg({ sessionId: 'sess-nope', projectId: 1 }),
      orchestratorHandle: makeFakeOrchestratorHandle(),
      sessionMode: null,
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'participant_not_found' }),
    );
  });

  test('chain mode → chain_mute_unsupported', () => {
    const { workerId } = seedSession();
    const result = executeMuteParticipant({
      msg: muteMsg({ projectId: workerId }),
      orchestratorHandle: undefined,
      sessionMode: 'chain',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'chain_mute_unsupported' }),
    );
    // DB not mutated
    expect(getControlState('sess-1', workerId)?.muted).toBe(false);
  });

  test('orchestrator role → orchestrator_cannot_kick (reused as "cannot mute orchestrator")', () => {
    const { orchestratorId } = seedSession();
    const result = executeMuteParticipant({
      msg: muteMsg({ projectId: orchestratorId }),
      orchestratorHandle: makeFakeOrchestratorHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'orchestrator_cannot_kick' }),
    );
  });

  test('unknown participant project → participant_not_found', () => {
    seedSession();
    const result = executeMuteParticipant({
      msg: muteMsg({ projectId: 99_999 }),
      orchestratorHandle: makeFakeOrchestratorHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'participant_not_found' }),
    );
  });

  test('participant without bus_agent_name → participant_not_found', () => {
    const { workerId } = seedSession();
    // Strip the slug to simulate "bus integration not installed for this project"
    getDb().prepare('UPDATE projects SET bus_agent_name = NULL WHERE id = ?').run(workerId);
    const result = executeMuteParticipant({
      msg: muteMsg({ projectId: workerId }),
      orchestratorHandle: makeFakeOrchestratorHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'participant_not_found' }),
    );
  });

  test("reasonCode='other' without reasonText → already_in_state misuse", () => {
    const { workerId } = seedSession();
    const result = executeMuteParticipant({
      msg: muteMsg({ projectId: workerId, reasonCode: 'other' }),
      orchestratorHandle: makeFakeOrchestratorHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/'other' requires non-empty reasonText/);
    }
  });

  test('re-mute (already muted) → already_in_state', () => {
    const { workerId } = seedSession();
    setParticipantMuted('sess-1', workerId, true); // pre-mute via repo
    const handle = makeFakeOrchestratorHandle();
    const result = executeMuteParticipant({
      msg: muteMsg({ projectId: workerId }),
      orchestratorHandle: handle,
      sessionMode: 'orchestrator',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'already_in_state' }),
    );
    // Router not poked for a no-op
    expect(handle.setMute).not.toHaveBeenCalled();
  });
});

describe('executeUnmuteParticipant', () => {
  test('flips muted=true → false; writes agent_control.unmuted audit row', () => {
    const { workerId } = seedSession();
    setParticipantMuted('sess-1', workerId, true);
    const handle = makeFakeOrchestratorHandle();
    handle.setMute('worker-slug', true); // pre-sync router

    const unmuteMsg: Extract<ClientMsg, { type: 'unmute_participant' }> = {
      type: 'unmute_participant',
      sessionId: 'sess-1',
      projectId: workerId,
      reasonCode: 'topology_repair',
    };
    const result = executeUnmuteParticipant({
      msg: unmuteMsg,
      orchestratorHandle: handle,
      sessionMode: 'orchestrator',
    });
    expect(result.ok).toBe(true);
    expect(getControlState('sess-1', workerId)?.muted).toBe(false);
    expect(handle.setMute).toHaveBeenLastCalledWith('worker-slug', false);
    const audit = getDb()
      .prepare<[], { reason_code: string }>(
        "SELECT reason_code FROM safety_audit WHERE kind = 'agent_control.unmuted'",
      )
      .get();
    expect(audit?.reason_code).toBe('topology_repair');
  });

  test('re-unmute (already unmuted) → already_in_state', () => {
    const { workerId } = seedSession();
    const result = executeUnmuteParticipant({
      msg: {
        type: 'unmute_participant',
        sessionId: 'sess-1',
        projectId: workerId,
        reasonCode: 'forensics',
      },
      orchestratorHandle: makeFakeOrchestratorHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'already_in_state' }),
    );
  });
});

describe('executeMuteParticipant — missing live handle (live session torn down)', () => {
  test('DB is still flipped + audit written; warn logged about missing handle', () => {
    const { workerId } = seedSession();
    const result = executeMuteParticipant({
      msg: muteMsg({ projectId: workerId }),
      orchestratorHandle: undefined, // simulates between-tick teardown
      sessionMode: 'orchestrator',
    });
    expect(result.ok).toBe(true);
    expect(getControlState('sess-1', workerId)?.muted).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('buildParticipantMuteChangedMsg', () => {
  test('shapes the wire envelope with actor=operator + supplied fields', () => {
    const env = buildParticipantMuteChangedMsg({
      sessionId: 'sess-x',
      projectId: 42,
      muted: true,
      reasonCode: 'cost_ceiling',
      reasonText: 'tokens too high',
      ts: 1_700_000_000_000,
    });
    expect(env).toEqual({
      type: 'participant_mute_changed',
      sessionId: 'sess-x',
      projectId: 42,
      muted: true,
      reasonCode: 'cost_ceiling',
      reasonText: 'tokens too high',
      actor: 'operator',
      ts: 1_700_000_000_000,
    });
  });

  test('omits reasonText when undefined (not the literal "undefined")', () => {
    const env = buildParticipantMuteChangedMsg({
      sessionId: 'sess-x',
      projectId: 42,
      muted: false,
      reasonCode: 'topology_repair',
      ts: 1,
    });
    expect('reasonText' in env).toBe(false);
  });
});
