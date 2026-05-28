import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ClientMsg } from '@cebab/shared';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { addParticipant, createMultiAgentSession } from '../repo/multi_agent.js';
import { upsertProject } from '../repo/projects.js';
import type { PauseExpiryAction } from '@cebab/shared/protocol';
import {
  buildParticipantKickedMsg,
  buildParticipantMuteChangedMsg,
  buildParticipantPauseChangedMsg,
  executeExpireParticipant,
  executeKickParticipant,
  executeMuteParticipant,
  executePauseParticipant,
  executeResumeParticipant,
  executeUnmuteParticipant,
} from './control_verbs.js';
import {
  getControlState,
  setParticipantKicked,
  setParticipantMuted,
  setParticipantPause,
} from '../repo/per_agent_control.js';

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
      .prepare<
        [string],
        { kind: string; reason_code: string; agent_id: string }
      >('SELECT kind, reason_code, agent_id FROM safety_audit WHERE kind = ?')
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
      .prepare<
        [],
        { payload_json: string }
      >("SELECT payload_json FROM safety_audit WHERE kind = 'agent_control.muted'")
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
    expect(result).toEqual(expect.objectContaining({ ok: false, failureCode: 'already_in_state' }));
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
      .prepare<
        [],
        { reason_code: string }
      >("SELECT reason_code FROM safety_audit WHERE kind = 'agent_control.unmuted'")
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
    expect(result).toEqual(expect.objectContaining({ ok: false, failureCode: 'already_in_state' }));
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

// ===== Cluster C Phase 4c: pause + resume handlers =====

function pauseMsg(
  overrides: Partial<Extract<ClientMsg, { type: 'pause_participant' }>> = {},
): Extract<ClientMsg, { type: 'pause_participant' }> {
  return {
    type: 'pause_participant',
    sessionId: 'sess-1',
    projectId: 0, // overridden by callers
    reasonCode: 'off_task',
    timeoutMs: 60_000,
    expiryAction: 'auto_resume',
    ...overrides,
  };
}

function resumeMsgFor(
  overrides: Partial<Extract<ClientMsg, { type: 'resume_participant' }>> = {},
): Extract<ClientMsg, { type: 'resume_participant' }> {
  return {
    type: 'resume_participant',
    sessionId: 'sess-1',
    projectId: 0,
    reasonCode: 'topology_repair',
    ...overrides,
  };
}

function makeFakePauseHandle() {
  const paused = new Set<string>();
  return {
    pauseAgent: vi.fn((name: string) => {
      if (paused.has(name)) return false;
      paused.add(name);
      return true;
    }),
    resumeAgent: vi.fn((name: string) => {
      if (!paused.has(name)) return false;
      paused.delete(name);
      return true;
    }),
    getPendingDeliveries: vi.fn(() => 0),
  };
}

describe('executePauseParticipant — happy path', () => {
  test('flips DB column, calls handle.pauseAgent, writes safety_audit, returns ok', () => {
    const { workerId } = seedSession();
    const handle = makeFakePauseHandle();
    handle.getPendingDeliveries.mockReturnValue(3);
    const result = executePauseParticipant({
      msg: pauseMsg({ projectId: workerId, reasonCode: 'runaway_loop', timeoutMs: 5 * 60_000 }),
      orchestratorHandle: handle,
      sessionMode: 'orchestrator',
      now: () => 1_700_000_000_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return; // type guard
    expect(result.pausedUntil).toBe(1_700_000_000_000 + 5 * 60_000);
    expect(result.queuedDeliveries).toBe(3);
    expect(getControlState('sess-1', workerId)?.pausedUntil).toBe(1_700_000_000_000 + 5 * 60_000);
    expect(handle.pauseAgent).toHaveBeenCalledWith('worker-slug');
    const audit = getDb()
      .prepare<
        [],
        { kind: string; reason_code: string; payload_json: string }
      >("SELECT kind, reason_code, payload_json FROM safety_audit WHERE kind = 'agent_control.paused'")
      .get();
    expect(audit?.kind).toBe('agent_control.paused');
    const payload = JSON.parse(audit!.payload_json) as { timeoutMs: number; expiryAction: string };
    expect(payload.timeoutMs).toBe(5 * 60_000);
    expect(payload.expiryAction).toBe('auto_resume');
  });

  test('expiryAction=auto_kick is accepted', () => {
    const { workerId } = seedSession();
    const result = executePauseParticipant({
      msg: pauseMsg({ projectId: workerId, expiryAction: 'auto_kick' }),
      orchestratorHandle: makeFakePauseHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result.ok).toBe(true);
  });
});

describe('executePauseParticipant — wire validation', () => {
  test('missing timeoutMs → pause_timeout_required', () => {
    const { workerId } = seedSession();
    const msgNoTimeout = pauseMsg({ projectId: workerId });
    // Synthesize the wire-shape failure by clearing the field on the
    // already-typed message.
    const result = executePauseParticipant({
      msg: { ...msgNoTimeout, timeoutMs: undefined as unknown as number },
      orchestratorHandle: makeFakePauseHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'pause_timeout_required' }),
    );
    expect(getControlState('sess-1', workerId)?.pausedUntil).toBeNull();
  });

  test('zero or negative timeoutMs → pause_timeout_required', () => {
    const { workerId } = seedSession();
    for (const bad of [0, -1, -100, NaN, Infinity]) {
      const result = executePauseParticipant({
        msg: pauseMsg({ projectId: workerId, timeoutMs: bad }),
        orchestratorHandle: makeFakePauseHandle(),
        sessionMode: 'orchestrator',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failureCode).toBe('pause_timeout_required');
      }
    }
  });

  test('timeout beyond 24h ceiling → pause_timeout_required', () => {
    const { workerId } = seedSession();
    const result = executePauseParticipant({
      msg: pauseMsg({ projectId: workerId, timeoutMs: 25 * 60 * 60 * 1000 }),
      orchestratorHandle: makeFakePauseHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'pause_timeout_required' }),
    );
  });

  test('invalid expiryAction → pause_expiry_action_invalid', () => {
    const { workerId } = seedSession();
    const result = executePauseParticipant({
      msg: pauseMsg({
        projectId: workerId,
        expiryAction: 'escalate' as unknown as 'auto_resume',
      }),
      orchestratorHandle: makeFakePauseHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'pause_expiry_action_invalid' }),
    );
  });

  test('orchestrator role → orchestrator_cannot_kick', () => {
    const { orchestratorId } = seedSession();
    const result = executePauseParticipant({
      msg: pauseMsg({ projectId: orchestratorId }),
      orchestratorHandle: makeFakePauseHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'orchestrator_cannot_kick' }),
    );
  });

  test('unknown participant → participant_not_found', () => {
    seedSession();
    const result = executePauseParticipant({
      msg: pauseMsg({ projectId: 99_999 }),
      orchestratorHandle: makeFakePauseHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'participant_not_found' }),
    );
  });

  test('re-pause (already paused) → already_in_state', () => {
    const { workerId } = seedSession();
    setParticipantPause('sess-1', workerId, Date.now() + 10_000, 'auto_resume');
    const handle = makeFakePauseHandle();
    const result = executePauseParticipant({
      msg: pauseMsg({ projectId: workerId }),
      orchestratorHandle: handle,
      sessionMode: 'orchestrator',
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, failureCode: 'already_in_state' }));
    expect(handle.pauseAgent).not.toHaveBeenCalled();
  });
});

describe('executeResumeParticipant', () => {
  test('flips paused → unpaused; writes agent_control.resumed audit', () => {
    const { workerId } = seedSession();
    setParticipantPause('sess-1', workerId, Date.now() + 10_000, 'auto_resume');
    const handle = makeFakePauseHandle();
    handle.pauseAgent('worker-slug'); // pre-sync the fake to "paused"

    const result = executeResumeParticipant({
      msg: resumeMsgFor({ projectId: workerId, reasonCode: 'topology_repair' }),
      orchestratorHandle: handle,
      sessionMode: 'orchestrator',
    });
    expect(result.ok).toBe(true);
    expect(getControlState('sess-1', workerId)?.pausedUntil).toBeNull();
    expect(handle.resumeAgent).toHaveBeenCalledWith('worker-slug');
    const audit = getDb()
      .prepare<
        [],
        { reason_code: string }
      >("SELECT reason_code FROM safety_audit WHERE kind = 'agent_control.resumed'")
      .get();
    expect(audit?.reason_code).toBe('topology_repair');
  });

  test('re-resume (not paused) → already_in_state', () => {
    const { workerId } = seedSession();
    const result = executeResumeParticipant({
      msg: resumeMsgFor({ projectId: workerId }),
      orchestratorHandle: makeFakePauseHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, failureCode: 'already_in_state' }));
  });
});

describe('executePauseParticipant — missing live handle', () => {
  test('DB is still flipped + audit written; warn logged', () => {
    const { workerId } = seedSession();
    const result = executePauseParticipant({
      msg: pauseMsg({ projectId: workerId }),
      orchestratorHandle: undefined,
      sessionMode: 'orchestrator',
    });
    expect(result.ok).toBe(true);
    expect(getControlState('sess-1', workerId)?.pausedUntil).toBeGreaterThan(0);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('buildParticipantPauseChangedMsg', () => {
  test('shapes the wire envelope with pausedUntil + expiryAction + queuedDeliveries', () => {
    const env = buildParticipantPauseChangedMsg({
      sessionId: 'sess-x',
      projectId: 42,
      pausedUntil: 1_700_000_000_000 + 60_000,
      expiryAction: 'auto_resume',
      reasonCode: 'cost_ceiling',
      reasonText: 'tokens too high',
      queuedDeliveries: 5,
      ts: 1_700_000_000_000,
    });
    expect(env).toEqual({
      type: 'participant_pause_changed',
      sessionId: 'sess-x',
      projectId: 42,
      pausedUntil: 1_700_000_000_000 + 60_000,
      expiryAction: 'auto_resume',
      reasonCode: 'cost_ceiling',
      reasonText: 'tokens too high',
      actor: 'operator',
      ts: 1_700_000_000_000,
      queuedDeliveries: 5,
    });
  });

  test('resume shape: pausedUntil=null, expiryAction=null, queuedDeliveries reported', () => {
    const env = buildParticipantPauseChangedMsg({
      sessionId: 'sess-x',
      projectId: 42,
      pausedUntil: null,
      expiryAction: null,
      reasonCode: 'topology_repair',
      queuedDeliveries: 0,
      ts: 1,
    });
    expect(env.pausedUntil).toBeNull();
    expect(env.expiryAction).toBeNull();
    expect(env.queuedDeliveries).toBe(0);
    expect('reasonText' in env).toBe(false);
  });
});

// ===== Cluster C Phase 4d: kick handler =====

function kickMsg(
  overrides: Partial<Extract<ClientMsg, { type: 'kick_participant' }>> = {},
): Extract<ClientMsg, { type: 'kick_participant' }> {
  return {
    type: 'kick_participant',
    sessionId: 'sess-1',
    projectId: 0, // overridden by callers
    reasonCode: 'off_task',
    mode: 'drain',
    ...overrides,
  };
}

function makeFakeKickHandle() {
  const kicked = new Set<string>();
  return {
    kickAgent: vi.fn((name: string) => {
      if (kicked.has(name)) return false;
      kicked.add(name);
      return true;
    }),
    isKicked: vi.fn((name: string) => kicked.has(name)),
  };
}

describe('executeKickParticipant — happy path (drain mode)', () => {
  test('flips DB column, calls handle.kickAgent, writes safety_audit, returns ok', () => {
    const { workerId } = seedSession();
    const handle = makeFakeKickHandle();
    const result = executeKickParticipant({
      msg: kickMsg({ projectId: workerId, reasonCode: 'runaway_loop' }),
      orchestratorHandle: handle,
      sessionMode: 'orchestrator',
      now: () => 1_700_000_000_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe('drain');
    expect(result.kickedAt).toBe(1_700_000_000_000);
    expect(getControlState('sess-1', workerId)?.kickedAt).toBe(1_700_000_000_000);
    expect(getControlState('sess-1', workerId)?.kickedMode).toBe('drain');
    expect(handle.kickAgent).toHaveBeenCalledWith('worker-slug');
    const audit = getDb()
      .prepare<
        [],
        { kind: string; reason_code: string; payload_json: string; agent_id: string }
      >("SELECT kind, reason_code, payload_json, agent_id FROM safety_audit WHERE kind = 'agent_control.kicked'")
      .get();
    expect(audit?.kind).toBe('agent_control.kicked');
    expect(audit?.reason_code).toBe('runaway_loop');
    expect(audit?.agent_id).toBe('worker-slug');
    const payload = JSON.parse(audit!.payload_json) as {
      projectId: number;
      agentSlug: string;
      mode: string;
      kickedAt: number;
    };
    expect(payload.mode).toBe('drain');
    expect(payload.kickedAt).toBe(1_700_000_000_000);
    expect(payload.agentSlug).toBe('worker-slug');
  });

  test('reasonText (when provided) lands in the audit payload', () => {
    const { workerId } = seedSession();
    executeKickParticipant({
      msg: kickMsg({
        projectId: workerId,
        reasonCode: 'other',
        reasonText: 'persistent off-task replies after pause',
      }),
      orchestratorHandle: makeFakeKickHandle(),
      sessionMode: 'orchestrator',
    });
    const audit = getDb()
      .prepare<
        [],
        { payload_json: string }
      >("SELECT payload_json FROM safety_audit WHERE kind = 'agent_control.kicked'")
      .get();
    const payload = JSON.parse(audit!.payload_json) as { reasonText: string };
    expect(payload.reasonText).toBe('persistent off-task replies after pause');
  });
});

describe('executeKickParticipant — wire validation', () => {
  test("reasonCode='other' without reasonText → already_in_state misuse", () => {
    const { workerId } = seedSession();
    const result = executeKickParticipant({
      msg: kickMsg({ projectId: workerId, reasonCode: 'other' }),
      orchestratorHandle: makeFakeKickHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/'other' requires non-empty reasonText/);
    }
    // No DB flip
    expect(getControlState('sess-1', workerId)?.kickedAt).toBeNull();
  });

  test('mode=hard → hard_kill_unsupported_v1 (rejected before session lookup)', () => {
    // hard-mode kick rejected with the dedicated v1 code so the operator UI
    // can phrase the rejection cleanly. The check runs BEFORE session
    // lookup so a misbehaving client gets the more-accurate code.
    const result = executeKickParticipant({
      msg: kickMsg({ sessionId: 'sess-nope', projectId: 1, mode: 'hard' }),
      orchestratorHandle: makeFakeKickHandle(),
      sessionMode: null,
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'hard_kill_unsupported_v1' }),
    );
  });

  test('unknown mode → already_in_state misuse', () => {
    const { workerId } = seedSession();
    const result = executeKickParticipant({
      msg: kickMsg({ projectId: workerId, mode: 'shutdown' as unknown as 'drain' }),
      orchestratorHandle: makeFakeKickHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/invalid kick mode/);
    }
    // DB not mutated
    expect(getControlState('sess-1', workerId)?.kickedAt).toBeNull();
  });
});

describe('executeKickParticipant — topology + participant guards', () => {
  test('unknown session → participant_not_found', () => {
    const result = executeKickParticipant({
      msg: kickMsg({ sessionId: 'sess-nope', projectId: 1 }),
      orchestratorHandle: makeFakeKickHandle(),
      sessionMode: null,
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'participant_not_found' }),
    );
  });

  test('chain mode → chain_topology_broken (every chain kick rejected in v1)', () => {
    const { workerId } = seedSession();
    const result = executeKickParticipant({
      msg: kickMsg({ projectId: workerId }),
      orchestratorHandle: undefined,
      sessionMode: 'chain',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'chain_topology_broken' }),
    );
    // DB not mutated
    expect(getControlState('sess-1', workerId)?.kickedAt).toBeNull();
  });

  test('orchestrator role → orchestrator_cannot_kick', () => {
    const { orchestratorId } = seedSession();
    const result = executeKickParticipant({
      msg: kickMsg({ projectId: orchestratorId }),
      orchestratorHandle: makeFakeKickHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'orchestrator_cannot_kick' }),
    );
  });

  test('unknown participant project → participant_not_found', () => {
    seedSession();
    const result = executeKickParticipant({
      msg: kickMsg({ projectId: 99_999 }),
      orchestratorHandle: makeFakeKickHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'participant_not_found' }),
    );
  });

  test('participant without bus_agent_name → participant_not_found', () => {
    const { workerId } = seedSession();
    getDb().prepare('UPDATE projects SET bus_agent_name = NULL WHERE id = ?').run(workerId);
    const result = executeKickParticipant({
      msg: kickMsg({ projectId: workerId }),
      orchestratorHandle: makeFakeKickHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'participant_not_found' }),
    );
  });

  test('re-kick (already kicked) → participant_already_kicked', () => {
    const { workerId } = seedSession();
    setParticipantKicked('sess-1', workerId, Date.now() - 1000, 'drain'); // pre-kick via repo
    const handle = makeFakeKickHandle();
    const result = executeKickParticipant({
      msg: kickMsg({ projectId: workerId }),
      orchestratorHandle: handle,
      sessionMode: 'orchestrator',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, failureCode: 'participant_already_kicked' }),
    );
    // Router not poked for the idempotent no-op
    expect(handle.kickAgent).not.toHaveBeenCalled();
  });
});

describe('executeKickParticipant — missing live handle (live session torn down)', () => {
  test('DB is still flipped + audit written; warn logged about missing handle', () => {
    const { workerId } = seedSession();
    const result = executeKickParticipant({
      msg: kickMsg({ projectId: workerId }),
      orchestratorHandle: undefined, // simulates between-tick teardown
      sessionMode: 'orchestrator',
    });
    expect(result.ok).toBe(true);
    expect(getControlState('sess-1', workerId)?.kickedAt).not.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('buildParticipantKickedMsg', () => {
  test('shapes the wire envelope with actor=operator + supplied fields', () => {
    const env = buildParticipantKickedMsg({
      sessionId: 'sess-x',
      projectId: 42,
      mode: 'drain',
      reasonCode: 'cost_ceiling',
      reasonText: 'tokens too high',
      ts: 1_700_000_000_000,
    });
    expect(env).toEqual({
      type: 'participant_kicked',
      sessionId: 'sess-x',
      projectId: 42,
      mode: 'drain',
      reasonCode: 'cost_ceiling',
      reasonText: 'tokens too high',
      actor: 'operator',
      ts: 1_700_000_000_000,
    });
  });

  test('omits reasonText when undefined (not the literal "undefined")', () => {
    const env = buildParticipantKickedMsg({
      sessionId: 'sess-x',
      projectId: 42,
      mode: 'drain',
      reasonCode: 'topology_repair',
      ts: 1,
    });
    expect('reasonText' in env).toBe(false);
  });
});

// ===== Cluster C Phase 4c2: pause expiry executor =====

function makeFakeExpireHandle() {
  const resumed = new Set<string>();
  const kicked = new Set<string>();
  return {
    resumeAgent: vi.fn((name: string) => {
      if (resumed.has(name)) return false;
      resumed.add(name);
      return true;
    }),
    kickAgent: vi.fn((name: string) => {
      if (kicked.has(name)) return false;
      kicked.add(name);
      return true;
    }),
  };
}

function buildExpireEntry(
  workerId: number,
  overrides: Partial<{
    pausedUntil: number;
    expiryAction: PauseExpiryAction;
    reasonCode: 'off_task' | 'runaway_loop' | 'cost_ceiling' | 'topology_repair' | 'other';
    reasonText: string | null;
  }> = {},
) {
  return {
    sessionId: 'sess-1',
    projectId: workerId,
    agentName: 'worker-slug',
    pausedUntil: Date.now() + 60_000,
    expiryAction: 'auto_resume' as PauseExpiryAction,
    reasonCode: 'off_task' as const,
    reasonText: null as string | null,
    ...overrides,
  };
}

describe('executeExpireParticipant — auto_resume', () => {
  test('writes pause.expired_without_resume audit + clears DB + calls handle.resumeAgent', () => {
    const { workerId } = seedSession();
    setParticipantPause('sess-1', workerId, Date.now() + 10_000, 'auto_resume');
    const handle = makeFakeExpireHandle();
    const entry = buildExpireEntry(workerId, { expiryAction: 'auto_resume' });
    const result = executeExpireParticipant({
      entry,
      orchestratorHandle: handle,
      now: () => 1_700_000_000_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('auto_resume');
    expect(result.kickAuditId).toBeUndefined();
    expect(getControlState('sess-1', workerId)?.pausedUntil).toBeNull();
    expect(handle.resumeAgent).toHaveBeenCalledWith('worker-slug');
    const audit = getDb()
      .prepare<
        [],
        { kind: string; reason_code: string; payload_json: string; agent_id: string }
      >("SELECT kind, reason_code, payload_json, agent_id FROM safety_audit WHERE kind = 'pause.expired_without_resume'")
      .get();
    expect(audit?.kind).toBe('pause.expired_without_resume');
    expect(audit?.reason_code).toBe('off_task');
    expect(audit?.agent_id).toBe('worker-slug');
    const payload = JSON.parse(audit!.payload_json) as {
      expiryAction: string;
      pausedUntil: number;
      divergedState?: string;
    };
    expect(payload.expiryAction).toBe('auto_resume');
    expect(payload.divergedState).toBeUndefined(); // state wasn't diverged
  });

  test('reasonText carried into the audit payload when set', () => {
    const { workerId } = seedSession();
    setParticipantPause('sess-1', workerId, Date.now() + 10_000, 'auto_resume');
    const entry = buildExpireEntry(workerId, {
      reasonText: 'tokens hitting ceiling',
      reasonCode: 'cost_ceiling',
    });
    executeExpireParticipant({
      entry,
      orchestratorHandle: makeFakeExpireHandle(),
    });
    const audit = getDb()
      .prepare<
        [],
        { payload_json: string }
      >("SELECT payload_json FROM safety_audit WHERE kind = 'pause.expired_without_resume'")
      .get();
    const payload = JSON.parse(audit!.payload_json) as { reasonText: string };
    expect(payload.reasonText).toBe('tokens hitting ceiling');
  });
});

describe('executeExpireParticipant — auto_kick', () => {
  test('writes BOTH trigger audit + agent_control.kicked audit; flips DB + router', () => {
    const { workerId } = seedSession();
    setParticipantPause('sess-1', workerId, Date.now() + 10_000, 'auto_kick');
    const handle = makeFakeExpireHandle();
    const entry = buildExpireEntry(workerId, {
      expiryAction: 'auto_kick',
      reasonCode: 'runaway_loop',
      reasonText: 'still emitting after pause',
    });
    const result = executeExpireParticipant({
      entry,
      orchestratorHandle: handle,
      now: () => 1_700_000_000_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('auto_kick');
    expect(result.kickedAt).toBe(1_700_000_000_000);
    expect(result.kickAuditId).toBeDefined();
    expect(result.kickAuditId).not.toBe(result.triggerAuditId);

    expect(getControlState('sess-1', workerId)?.kickedAt).toBe(1_700_000_000_000);
    expect(getControlState('sess-1', workerId)?.kickedMode).toBe('drain');
    // Pause column also cleared as part of the kick escalation.
    expect(getControlState('sess-1', workerId)?.pausedUntil).toBeNull();
    expect(handle.kickAgent).toHaveBeenCalledWith('worker-slug');
    expect(handle.resumeAgent).not.toHaveBeenCalled();

    // Two safety_audit rows: the trigger + the resulting kick.
    const audits = getDb()
      .prepare<
        [],
        { kind: string; reason_code: string; payload_json: string }
      >("SELECT kind, reason_code, payload_json FROM safety_audit WHERE kind LIKE 'pause.%' OR kind LIKE 'agent_control.kicked' ORDER BY ts ASC")
      .all();
    expect(audits.map((r) => r.kind)).toEqual([
      'pause.expired_without_resume',
      'agent_control.kicked',
    ]);
    // Kick audit's payload tags the trigger so forensic queries can
    // distinguish operator-kicked rows from expiry-escalated rows.
    const kickPayload = JSON.parse(audits[1]!.payload_json) as {
      triggerKind: string;
      triggerAuditId: string;
      mode: string;
    };
    expect(kickPayload.triggerKind).toBe('pause.expired_without_resume');
    expect(kickPayload.triggerAuditId).toBe(result.triggerAuditId);
    expect(kickPayload.mode).toBe('drain');
  });
});

describe('executeExpireParticipant — diverged state (defense-in-depth)', () => {
  test('participant resumed between schedule + fire → noop_diverged + audit only', () => {
    const { workerId } = seedSession();
    // Pause was scheduled, but operator already resumed (paused_until is NULL).
    const handle = makeFakeExpireHandle();
    const entry = buildExpireEntry(workerId);
    const result = executeExpireParticipant({
      entry,
      orchestratorHandle: handle,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('noop_diverged');
    expect(result.divergedState).toBe('resumed');
    expect(handle.resumeAgent).not.toHaveBeenCalled();
    expect(handle.kickAgent).not.toHaveBeenCalled();
    // Trigger audit STILL wrote so the forensic trail captures the
    // timer fire (even though no state changed).
    const audit = getDb()
      .prepare<
        [],
        { payload_json: string }
      >("SELECT payload_json FROM safety_audit WHERE kind = 'pause.expired_without_resume'")
      .get();
    const payload = JSON.parse(audit!.payload_json) as { divergedState: string };
    expect(payload.divergedState).toBe('resumed');
  });

  test('participant kicked between schedule + fire → noop_diverged kicked', () => {
    const { workerId } = seedSession();
    setParticipantKicked('sess-1', workerId, Date.now() - 1_000, 'drain');
    const handle = makeFakeExpireHandle();
    const entry = buildExpireEntry(workerId, { expiryAction: 'auto_kick' });
    const result = executeExpireParticipant({
      entry,
      orchestratorHandle: handle,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('noop_diverged');
    expect(result.divergedState).toBe('kicked');
    expect(handle.kickAgent).not.toHaveBeenCalled();
  });

  test('participant deleted between schedule + fire → noop_diverged participant_missing', () => {
    const handle = makeFakeExpireHandle();
    // No seeded participant — getControlState returns undefined.
    const entry = buildExpireEntry(99_999);
    const result = executeExpireParticipant({
      entry,
      orchestratorHandle: handle,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.divergedState).toBe('participant_missing');
    expect(handle.kickAgent).not.toHaveBeenCalled();
  });
});

describe('executeExpireParticipant — missing live handle', () => {
  test('auto_resume still writes audit + clears DB; warn logged about handle', () => {
    const { workerId } = seedSession();
    setParticipantPause('sess-1', workerId, Date.now() + 10_000, 'auto_resume');
    const result = executeExpireParticipant({
      entry: buildExpireEntry(workerId),
      orchestratorHandle: undefined,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('auto_resume');
    expect(getControlState('sess-1', workerId)?.pausedUntil).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  test('auto_kick still flips DB + writes both audits; warn logged about handle', () => {
    const { workerId } = seedSession();
    setParticipantPause('sess-1', workerId, Date.now() + 10_000, 'auto_kick');
    const result = executeExpireParticipant({
      entry: buildExpireEntry(workerId, { expiryAction: 'auto_kick' }),
      orchestratorHandle: undefined,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('auto_kick');
    expect(getControlState('sess-1', workerId)?.kickedAt).not.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ===== Cluster C Phase 4f: forensic capture on kick + auto-kick =====
//
// The kick paths now write a controllability_forensics row keyed to the
// kick's safety_audit_id, populated with the agent's bus inbox/outbox
// + mutation tail. These tests verify the row lands + carries the
// expected per-participant shape.

describe('executeKickParticipant — forensic capture (Phase 4f)', () => {
  test('writes a controllability_forensics row keyed to the kick audit', async () => {
    const { workerId } = seedSession();
    // Seed bus events so the forensic bundle has tail content.
    const { appendMultiAgentEvent } = await import('../repo/multi_agent.js');
    appendMultiAgentEvent('sess-1', 'orchestrator', 'worker-slug', 'prompt', 'do thing');
    appendMultiAgentEvent('sess-1', 'worker-slug', 'orchestrator', 'reply', 'on it');

    const result = executeKickParticipant({
      msg: kickMsg({ projectId: workerId, reasonCode: 'runaway_loop' }),
      orchestratorHandle: makeFakeKickHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const forensicsRow = getDb()
      .prepare<
        [string],
        {
          safety_audit_id: string;
          agent_slug: string;
          bus_inbox_outbox_json: string;
          events_last_n_json: string;
        }
      >(
        'SELECT safety_audit_id, agent_slug, bus_inbox_outbox_json, events_last_n_json FROM controllability_forensics WHERE safety_audit_id = ?',
      )
      .get(result.auditId);

    expect(forensicsRow).toBeDefined();
    expect(forensicsRow?.safety_audit_id).toBe(result.auditId);
    expect(forensicsRow?.agent_slug).toBe('worker-slug');
    const bio = JSON.parse(forensicsRow!.bus_inbox_outbox_json) as {
      inbox: Array<{ kind: string; textPreview: string }>;
      outbox: Array<{ kind: string; textPreview: string }>;
      totalSessionEvents: number;
    };
    expect(bio.inbox).toHaveLength(1);
    expect(bio.inbox[0]?.textPreview).toBe('do thing');
    expect(bio.outbox).toHaveLength(1);
    expect(bio.outbox[0]?.textPreview).toBe('on it');
    expect(bio.totalSessionEvents).toBe(2);
  });

  test('forensic write failure does NOT propagate; audit row stays', () => {
    const { workerId } = seedSession();
    const throwingAppend = vi.fn(() => {
      throw new Error('forensics db full');
    });
    const result = executeKickParticipant({
      msg: kickMsg({ projectId: workerId }),
      orchestratorHandle: makeFakeKickHandle(),
      sessionMode: 'orchestrator',
      appendForensicsRow: throwingAppend,
    });
    // Kick succeeded (audit + DB intact) despite the forensic write failure.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const auditCount = getDb()
      .prepare<
        [],
        { c: number }
      >("SELECT COUNT(*) as c FROM safety_audit WHERE kind = 'agent_control.kicked'")
      .get()!.c;
    expect(auditCount).toBe(1);
    // Forensic writer was called + threw; the error log fired.
    expect(throwingAppend).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  test('forensic row mutation tail surfaces agent-attributed mutations only', async () => {
    const { workerId } = seedSession();
    const { appendMultiAgentMutation } = await import('../repo/multi_agent.js');
    appendMultiAgentMutation('sess-1', 'worker-slug', 'Write', 'mutate', 'wrote A', {
      filePath: '/tmp/A',
      cwd: '/tmp',
      toolUseId: null,
    });
    // A mutation by a DIFFERENT agent that should NOT appear in the forensic row.
    appendMultiAgentMutation('sess-1', 'other-agent', 'Write', 'mutate', 'wrote B', {
      filePath: '/tmp/B',
      cwd: '/tmp',
      toolUseId: null,
    });

    const result = executeKickParticipant({
      msg: kickMsg({ projectId: workerId }),
      orchestratorHandle: makeFakeKickHandle(),
      sessionMode: 'orchestrator',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = getDb()
      .prepare<
        [string],
        { mutation_rationale_json: string }
      >('SELECT mutation_rationale_json FROM controllability_forensics WHERE safety_audit_id = ?')
      .get(result.auditId)!;
    const mr = JSON.parse(row.mutation_rationale_json) as {
      recentMutations: Array<{ toolName: string; summary: string }>;
      totalMutations: number;
    };
    expect(mr.recentMutations).toHaveLength(1);
    expect(mr.recentMutations[0]?.summary).toBe('wrote A');
    expect(mr.totalMutations).toBe(1);
  });
});

describe('executeExpireParticipant auto_kick — forensic capture (Phase 4f)', () => {
  test('auto_kick path writes a forensic row keyed to the agent_control.kicked audit', async () => {
    const { workerId } = seedSession();
    setParticipantPause('sess-1', workerId, Date.now() + 10_000, 'auto_kick');
    const { appendMultiAgentEvent } = await import('../repo/multi_agent.js');
    appendMultiAgentEvent('sess-1', 'orchestrator', 'worker-slug', 'prompt', 'first prompt');

    const result = executeExpireParticipant({
      entry: buildExpireEntry(workerId, { expiryAction: 'auto_kick' }),
      orchestratorHandle: makeFakeExpireHandle(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('auto_kick');
    expect(result.kickAuditId).toBeDefined();

    // The forensic row is keyed to the KICK audit, not the trigger audit.
    const row = getDb()
      .prepare<
        [string],
        { agent_slug: string; bus_inbox_outbox_json: string }
      >('SELECT agent_slug, bus_inbox_outbox_json FROM controllability_forensics WHERE safety_audit_id = ?')
      .get(result.kickAuditId!);
    expect(row).toBeDefined();
    expect(row?.agent_slug).toBe('worker-slug');
    const bio = JSON.parse(row!.bus_inbox_outbox_json) as {
      inbox: Array<{ textPreview: string }>;
    };
    expect(bio.inbox.map((e) => e.textPreview)).toEqual(['first prompt']);

    // No forensic row is written for the TRIGGER audit
    // (pause.expired_without_resume) — that audit captures the trigger
    // event; the state-at-kick bundle hangs off the kick audit row.
    const triggerRow = getDb()
      .prepare<
        [string],
        { c: number }
      >('SELECT COUNT(*) as c FROM controllability_forensics WHERE safety_audit_id = ?')
      .get(result.triggerAuditId)!;
    expect(triggerRow.c).toBe(0);
  });

  test('auto_resume path does NOT write a forensic row (no state change to capture)', () => {
    const { workerId } = seedSession();
    setParticipantPause('sess-1', workerId, Date.now() + 10_000, 'auto_resume');
    const result = executeExpireParticipant({
      entry: buildExpireEntry(workerId, { expiryAction: 'auto_resume' }),
      orchestratorHandle: makeFakeExpireHandle(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('auto_resume');
    // No forensic rows for any audit produced on this path.
    const count = getDb()
      .prepare<[], { c: number }>('SELECT COUNT(*) as c FROM controllability_forensics')
      .get()!.c;
    expect(count).toBe(0);
  });
});
