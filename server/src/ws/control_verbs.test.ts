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
  buildParticipantKickedMsg,
  buildParticipantMuteChangedMsg,
  buildParticipantPauseChangedMsg,
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
