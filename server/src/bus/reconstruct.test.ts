// R-B: reconstruct an orchestrated bus session after a Cebab SERVER restart.
// Covers the conservative contract (rebuild + re-register READ-ONLY, no
// auto-delivery), the guard matrix (every failure falls back to "can't —
// caller marks crashed"), and the restart-sim through `attemptResumeMultiAgent`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  canReconstruct,
  isReconstructable,
  reconstructOrchestratorSession,
  RECOVERY_BANNER,
} from './reconstruct.js';
import { attemptResumeMultiAgent } from './resume.js';
import { getLiveSession, hasLiveSession, unregisterLiveSession } from './session_registry.js';
import {
  addParticipant,
  appendMultiAgentEvent,
  createMultiAgentSession,
  getMultiAgentSession,
  listMultiAgentEvents,
  upsertAgentSession,
  setProjectBusInstalled,
} from '../repo/multi_agent.js';
import {
  getControlState,
  setParticipantKicked,
  setParticipantMuted,
  setParticipantPause,
} from '../repo/per_agent_control.js';
import { appendSafetyAudit } from '../notifications/safety_audit.js';
import { upsertProject } from '../repo/projects.js';
import { __resetRegistryForTesting, getPauseExpiryRegistry } from '../ws/pause_expiry.js';

let tmpRoot: string;
let originalDataDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

const SID = 'recon-sid';

/** Create the on-disk session folder + two bus-installed worker projects +
 *  the DB rows a healthy, reconstructable orchestrated run leaves behind. */
function seedReconstructable(opts?: { mode?: 'orchestrator' | 'chain' }): {
  sessionFolder: string;
} {
  const workspace = path.join(tmpRoot, 'workspace');
  const sessionFolder = path.join(workspace, `.cebab-session-${SID}`);
  fs.mkdirSync(sessionFolder, { recursive: true });

  const coder = upsertProject('Coder', path.join(workspace, 'coder'));
  const reviewer = upsertProject('Reviewer', path.join(workspace, 'reviewer'));
  setProjectBusInstalled(coder.id, true, 'coder');
  setProjectBusInstalled(reviewer.id, true, 'reviewer');

  createMultiAgentSession(SID, opts?.mode ?? 'orchestrator', 'iter-1', sessionFolder, 'persistent');
  addParticipant(SID, coder.id, 'worker', null);
  addParticipant(SID, reviewer.id, 'worker', null);

  // The orchestrator + one worker completed turns before the restart.
  upsertAgentSession(SID, 'orchestrator', 'orch-cli-1');
  upsertAgentSession(SID, 'coder', 'coder-cli-1');

  // A little comm history: orchestrator briefed+prompted coder, coder replied.
  appendMultiAgentEvent(SID, 'cebab', 'orchestrator', 'prompt', 'roster + task');
  appendMultiAgentEvent(SID, 'orchestrator', 'coder', 'prompt', 'do the thing');
  appendMultiAgentEvent(SID, 'coder', 'orchestrator', 'reply', 'partial result');

  return { sessionFolder };
}

const cbs = () => ({ onEvent: vi.fn(), onEnded: vi.fn(), hopBudget: 1000 });

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-reconstruct-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  __resetRegistryForTesting();
});

afterEach(() => {
  warnSpy.mockRestore();
  errSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  unregisterLiveSession(SID);
  __resetRegistryForTesting();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('reconstructOrchestratorSession (R-B happy path)', () => {
  test('rebuilds, registers READ-ONLY, sets awaiting_continue, appends the banner', () => {
    seedReconstructable();
    const before = listMultiAgentEvents(SID).length;
    const row = getMultiAgentSession(SID)!;

    const ok = reconstructOrchestratorSession(row, cbs());

    expect(ok).toBe(true);
    // Live again, re-attachable, with the roster rebuilt from the DB.
    expect(hasLiveSession(SID)).toBe(true);
    expect(getLiveSession(SID)!.mode).toBe('orchestrator');
    expect(getLiveSession(SID)!.handle.participantAgentNames).toEqual([
      'orchestrator',
      'coder',
      'reviewer',
    ]);
    // Conservative: paused for the operator.
    expect(getMultiAgentSession(SID)!.awaiting_continue).toBe(1);
    // The ONLY new event is the persisted recovery banner — nothing was
    // delivered or forwarded (no auto re-run of the interrupted turn).
    const after = listMultiAgentEvents(SID);
    expect(after.length).toBe(before + 1);
    const last = after[after.length - 1]!;
    expect(last).toMatchObject({
      source: 'cebab',
      destination: 'user',
      kind: 'intro',
      text: RECOVERY_BANNER,
    });
  });

  test('idempotent: a second call is a no-op (no duplicate banner)', () => {
    seedReconstructable();
    const row = getMultiAgentSession(SID)!;
    expect(reconstructOrchestratorSession(row, cbs())).toBe(true);
    const afterFirst = listMultiAgentEvents(SID).length;
    // Second connect in the same post-restart process → already live.
    expect(reconstructOrchestratorSession(row, cbs())).toBe(true);
    expect(listMultiAgentEvents(SID).length).toBe(afterFirst);
  });

  test('[security] reconstruction never runs an agent without an explicit continue', () => {
    seedReconstructable();
    const row = getMultiAgentSession(SID)!;
    const before = listMultiAgentEvents(SID).length;
    reconstructOrchestratorSession(row, cbs());
    // A delivered turn would produce forwarded prompt/reply events. Only the
    // cebab→user banner was added; the read-only contract holds, so an
    // interrupted turn's side effects can't be silently re-applied. (F2/F3
    // routing-filter behavior is pinned by orchestrator.security.test.ts —
    // reconstruction reuses the same createOrchestratorRouter factory.)
    const added = listMultiAgentEvents(SID).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.destination).toBe('user');
  });
});

describe('isReconstructable guard matrix (every failure → caller marks crashed)', () => {
  test('chain mode is deferred', () => {
    seedReconstructable({ mode: 'chain' });
    const row = getMultiAgentSession(SID)!;
    expect(isReconstructable(row)).toEqual({ ok: false, reason: 'not-orchestrator' });
    expect(reconstructOrchestratorSession(row, cbs())).toBe(false);
    expect(hasLiveSession(SID)).toBe(false);
  });

  test('pre-007 row (null session_folder)', () => {
    upsertProject('Coder', path.join(tmpRoot, 'coder'));
    createMultiAgentSession(SID, 'orchestrator', 'iter-1', null, 'persistent');
    const row = getMultiAgentSession(SID)!;
    expect(isReconstructable(row).ok).toBe(false);
    expect(canReconstruct(row)).toBe(false);
  });

  test('session folder gone from disk (temp-cleaned / deleted)', () => {
    const { sessionFolder } = seedReconstructable();
    fs.rmSync(sessionFolder, { recursive: true, force: true });
    const row = getMultiAgentSession(SID)!;
    expect(isReconstructable(row)).toEqual({ ok: false, reason: 'folder-missing' });
  });

  test('pre-009 row (no persisted agent-session map)', () => {
    const workspace = path.join(tmpRoot, 'workspace');
    const sessionFolder = path.join(workspace, `.cebab-session-${SID}`);
    fs.mkdirSync(sessionFolder, { recursive: true });
    const coder = upsertProject('Coder', path.join(workspace, 'coder'));
    setProjectBusInstalled(coder.id, true, 'coder');
    createMultiAgentSession(SID, 'orchestrator', 'iter-1', sessionFolder, 'persistent');
    addParticipant(SID, coder.id, 'worker', null);
    // NOTE: no upsertAgentSession — this is the migration cutover boundary.
    const row = getMultiAgentSession(SID)!;
    expect(isReconstructable(row)).toEqual({ ok: false, reason: 'no-agent-sessions' });
  });

  test('all participant projects deleted', () => {
    const workspace = path.join(tmpRoot, 'workspace');
    const sessionFolder = path.join(workspace, `.cebab-session-${SID}`);
    fs.mkdirSync(sessionFolder, { recursive: true });
    createMultiAgentSession(SID, 'orchestrator', 'iter-1', sessionFolder, 'persistent');
    upsertAgentSession(SID, 'orchestrator', 'orch-cli-1');
    // No participants rows at all.
    const row = getMultiAgentSession(SID)!;
    expect(isReconstructable(row)).toEqual({ ok: false, reason: 'no-participants' });
    expect(reconstructOrchestratorSession(row, cbs())).toBe(false);
  });
});

describe('restart simulation via attemptResumeMultiAgent', () => {
  test('a running row with no live registry entry is reconstructed, not crashed', async () => {
    seedReconstructable(); // status defaults to 'running'
    // Registry is empty (≡ the owning process died). attemptResume should
    // rebuild instead of marking crashed.
    expect(hasLiveSession(SID)).toBe(false);
    const onResumeFailed = vi.fn();

    const resumed = await attemptResumeMultiAgent({
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      onResumeFailed,
      hopBudget: 1000,
    });

    expect(resumed).not.toBeNull();
    expect(resumed!.handle.sessionId).toBe(SID);
    expect(resumed!.mode).toBe('orchestrator');
    expect(onResumeFailed).not.toHaveBeenCalled();
    expect(hasLiveSession(SID)).toBe(true);
    expect(getMultiAgentSession(SID)!.awaiting_continue).toBe(1);
    // Scrollback replays the full comm log + the recovery banner.
    const texts = resumed!.replayEvents.map((e) => e.text);
    expect(texts).toContain(RECOVERY_BANNER);
    expect(resumed!.replayEvents.length).toBeGreaterThan(1);
  });

  test('a chain row still falls back to crashed (reconstruction deferred)', async () => {
    seedReconstructable({ mode: 'chain' });
    const onResumeFailed = vi.fn();

    const resumed = await attemptResumeMultiAgent({
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      onResumeFailed,
      hopBudget: 1000,
    });

    expect(resumed).toBeNull();
    expect(onResumeFailed).toHaveBeenCalledWith(SID, 'reattach-failed');
    expect(getMultiAgentSession(SID)!.status).toBe('crashed');
  });
});

describe('Cluster A Phase 6: session_reconstructed emit on R-B success', () => {
  test('emits typed session_reconstructed + dispatcher success toast', () => {
    seedReconstructable();
    const row = getMultiAgentSession(SID)!;
    const sendServerMsg = vi.fn();

    const ok = reconstructOrchestratorSession(row, {
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      hopBudget: 1000,
      sendServerMsg,
    });

    expect(ok).toBe(true);
    // Two messages: the typed event (for forward-compat consumers) AND
    // the dispatcher's `notification` envelope (the operator-facing toast).
    const types = sendServerMsg.mock.calls.map((c) => c[0]?.type);
    expect(types).toContain('session_reconstructed');
    expect(types).toContain('notification');

    const typed = sendServerMsg.mock.calls.find((c) => c[0]?.type === 'session_reconstructed')?.[0];
    expect(typed).toMatchObject({
      type: 'session_reconstructed',
      sessionId: SID,
      reasonCode: 'reconstructed',
    });

    const toast = sendServerMsg.mock.calls.find((c) => c[0]?.type === 'notification')?.[0];
    expect(toast).toMatchObject({
      type: 'notification',
      class: 'operational',
      severity: 'success',
      // dedupeKey ties the toast to this specific session so a second
      // reconstruct (e.g. a second browser tab connecting before the
      // operator continues) doesn't double-toast.
      dedupeKey: `session_reconstructed:${SID}`,
      sessionId: SID,
      sticky: true,
      reasonCode: 'reconstructed',
    });
    // CTA is "Resume" — the operator's next action after acknowledging
    // the recovery is to continue the (paused) session.
    expect(toast.action).toEqual({ kind: 'resume', sessionId: SID });
  });

  test('no emit when sendServerMsg is absent (legacy callers still work)', () => {
    seedReconstructable();
    const row = getMultiAgentSession(SID)!;
    // Pre-Phase-6 callbacks shape — no `sendServerMsg`. Must not throw.
    expect(() =>
      reconstructOrchestratorSession(row, {
        onEvent: vi.fn(),
        onEnded: vi.fn(),
        hopBudget: 1000,
      }),
    ).not.toThrow();
    // Banner still landed in scrollback as the fallback recovery signal.
    expect(listMultiAgentEvents(SID).map((e) => e.text)).toContain(RECOVERY_BANNER);
  });
});

// ===== Cluster C Phase 4e: R-B reseed for mute / kick / pause-expiry =====
//
// On server restart, the in-memory router/runner state is gone. The
// reconstruct path now reads `multi_agent_participants` for muted +
// kicked agents and reseeds the rebuilt router's mute/kick sets, then
// reschedules pause-expiry timers for any active pauses. These tests
// verify:
//   1. The router's `isMuted` / `isKicked` probes reflect the durable
//      state immediately after reconstruct (no router events needed).
//   2. The pause-expiry registry has a scheduled timer per active
//      pause, with the original reasonCode + reasonText recovered from
//      safety_audit.
//   3. A pause whose deadline already elapsed during downtime fires on
//      the next tick + does the right side effect (auto_resume clears
//      DB; auto_kick flips kicked_at + writes the kick audit).
//
// The `OrchestratorSessionHandle`'s `isMuted` / `isKicked` are the
// router's probe methods (kept verbatim from C4b/C4d); reseed
// correctness is "does isMuted return true for a previously-muted
// agent slug, with no router events fired in between?"

function getOrchestratorHandle(sessionId: string): {
  isMuted: (n: string) => boolean;
  isKicked: (n: string) => boolean;
} {
  const live = getLiveSession(sessionId);
  if (!live || live.mode !== 'orchestrator') {
    throw new Error('expected an orchestrator handle to be live');
  }
  return live.handle as unknown as {
    isMuted: (n: string) => boolean;
    isKicked: (n: string) => boolean;
  };
}

describe('reconstructOrchestratorSession — R-B reseed (Phase 4e)', () => {
  test('reseeds mute set from multi_agent_participants.muted', () => {
    seedReconstructable();
    // Worker projects: coder + reviewer (per seedReconstructable). The
    // bus_agent_name slugs are set via setProjectBusInstalled.
    const coder = getDb()
      .prepare<[], { id: number }>("SELECT id FROM projects WHERE name = 'Coder'")
      .get()!;
    setParticipantMuted(SID, coder.id, true);

    const ok = reconstructOrchestratorSession(getMultiAgentSession(SID)!, cbs());
    expect(ok).toBe(true);

    const handle = getOrchestratorHandle(SID);
    expect(handle.isMuted('coder')).toBe(true);
    expect(handle.isMuted('reviewer')).toBe(false);
  });

  test('reseeds kick set from multi_agent_participants.kicked_at', () => {
    seedReconstructable();
    const reviewer = getDb()
      .prepare<[], { id: number }>("SELECT id FROM projects WHERE name = 'Reviewer'")
      .get()!;
    setParticipantKicked(SID, reviewer.id, Date.now() - 60_000, 'drain');

    const ok = reconstructOrchestratorSession(getMultiAgentSession(SID)!, cbs());
    expect(ok).toBe(true);

    const handle = getOrchestratorHandle(SID);
    expect(handle.isKicked('reviewer')).toBe(true);
    expect(handle.isKicked('coder')).toBe(false);
  });

  test('reseeds both mute + kick simultaneously', () => {
    seedReconstructable();
    const coder = getDb()
      .prepare<[], { id: number }>("SELECT id FROM projects WHERE name = 'Coder'")
      .get()!;
    const reviewer = getDb()
      .prepare<[], { id: number }>("SELECT id FROM projects WHERE name = 'Reviewer'")
      .get()!;
    setParticipantMuted(SID, coder.id, true);
    setParticipantKicked(SID, reviewer.id, Date.now() - 1_000, 'drain');

    reconstructOrchestratorSession(getMultiAgentSession(SID)!, cbs());

    const handle = getOrchestratorHandle(SID);
    expect(handle.isMuted('coder')).toBe(true);
    expect(handle.isKicked('reviewer')).toBe(true);
  });

  test('reschedules pause-expiry timer with reasonCode recovered from safety_audit', () => {
    seedReconstructable();
    const coder = getDb()
      .prepare<[], { id: number }>("SELECT id FROM projects WHERE name = 'Coder'")
      .get()!;
    const pausedUntil = Date.now() + 60_000;
    setParticipantPause(SID, coder.id, pausedUntil, 'auto_resume');
    // Write the pause's audit row so reseed can recover the reasonCode.
    appendSafetyAudit({
      ts: Date.now() - 1_000,
      sessionId: SID,
      agentId: 'coder',
      kind: 'agent_control.paused',
      reasonCode: 'runaway_loop',
      payload: {
        projectId: coder.id,
        agentSlug: 'coder',
        reasonText: 'looping on the same thought',
        timeoutMs: 60_000,
        expiryAction: 'auto_resume',
        pausedUntil,
      },
    });

    reconstructOrchestratorSession(getMultiAgentSession(SID)!, cbs());

    const registry = getPauseExpiryRegistry();
    expect(registry.isScheduled(SID, coder.id)).toBe(true);
    const entry = registry.getEntry(SID, coder.id);
    expect(entry?.reasonCode).toBe('runaway_loop');
    expect(entry?.reasonText).toBe('looping on the same thought');
    expect(entry?.pausedUntil).toBe(pausedUntil);
    expect(entry?.expiryAction).toBe('auto_resume');
  });

  test('falls back to topology_repair reasonCode when audit row is missing', () => {
    seedReconstructable();
    const coder = getDb()
      .prepare<[], { id: number }>("SELECT id FROM projects WHERE name = 'Coder'")
      .get()!;
    setParticipantPause(SID, coder.id, Date.now() + 30_000, 'auto_resume');
    // NO audit row — simulates a backdoor write that skipped the audit.

    reconstructOrchestratorSession(getMultiAgentSession(SID)!, cbs());

    const entry = getPauseExpiryRegistry().getEntry(SID, coder.id);
    expect(entry?.reasonCode).toBe('topology_repair');
    expect(entry?.reasonText).toBeNull();
    // Warn logged about the missing audit row.
    expect(warnSpy).toHaveBeenCalled();
  });

  test('reseeded auto_resume timer fires + clears the DB on next tick when deadline already elapsed', async () => {
    vi.useFakeTimers();
    try {
      seedReconstructable();
      const coder = getDb()
        .prepare<[], { id: number }>("SELECT id FROM projects WHERE name = 'Coder'")
        .get()!;
      // Deadline already in the past (server was down past the deadline).
      const pausedUntil = Date.now() - 1_000;
      setParticipantPause(SID, coder.id, pausedUntil, 'auto_resume');
      appendSafetyAudit({
        ts: pausedUntil - 60_000,
        sessionId: SID,
        agentId: 'coder',
        kind: 'agent_control.paused',
        reasonCode: 'off_task',
        payload: { projectId: coder.id, agentSlug: 'coder', expiryAction: 'auto_resume' },
      });

      reconstructOrchestratorSession(getMultiAgentSession(SID)!, cbs());

      // Pause column populated.
      expect(getControlState(SID, coder.id)?.pausedUntil).toBe(pausedUntil);

      // Advance through the 0ms setTimeout the registry uses for
      // past-deadline scheduling. Fake timers also let the
      // microtask-level executor run synchronously.
      vi.advanceTimersByTime(1);

      // After fire: pause cleared.
      expect(getControlState(SID, coder.id)?.pausedUntil).toBeNull();
      // Trigger audit written.
      const trigger = getDb()
        .prepare<
          [],
          { kind: string; reason_code: string; payload_json: string }
        >("SELECT kind, reason_code, payload_json FROM safety_audit WHERE kind = 'pause.expired_without_resume'")
        .get();
      expect(trigger?.kind).toBe('pause.expired_without_resume');
      expect(trigger?.reason_code).toBe('off_task');
    } finally {
      vi.useRealTimers();
    }
  });

  test('reseeded auto_kick timer fires + flips kicked_at on past-deadline reseed', () => {
    vi.useFakeTimers();
    try {
      seedReconstructable();
      const coder = getDb()
        .prepare<[], { id: number }>("SELECT id FROM projects WHERE name = 'Coder'")
        .get()!;
      const pausedUntil = Date.now() - 1_000;
      setParticipantPause(SID, coder.id, pausedUntil, 'auto_kick');
      appendSafetyAudit({
        ts: pausedUntil - 60_000,
        sessionId: SID,
        agentId: 'coder',
        kind: 'agent_control.paused',
        reasonCode: 'cost_ceiling',
        payload: { projectId: coder.id, agentSlug: 'coder', expiryAction: 'auto_kick' },
      });

      reconstructOrchestratorSession(getMultiAgentSession(SID)!, cbs());

      vi.advanceTimersByTime(1);

      // Auto-kick happened: kicked_at populated; pause cleared.
      const state = getControlState(SID, coder.id)!;
      expect(state.kickedAt).not.toBeNull();
      expect(state.kickedMode).toBe('drain');
      expect(state.pausedUntil).toBeNull();

      // Router reflects the kick.
      const handle = getOrchestratorHandle(SID);
      expect(handle.isKicked('coder')).toBe(true);

      // Both audits written: the trigger + the kick.
      const kinds = getDb()
        .prepare<[], { kind: string }>(
          "SELECT kind FROM safety_audit WHERE kind LIKE 'pause.%' OR kind LIKE 'agent_control.kicked' ORDER BY ts ASC",
        )
        .all()
        .map((r) => r.kind);
      expect(kinds).toEqual(['pause.expired_without_resume', 'agent_control.kicked']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('no active pauses → no timers scheduled (clean fresh reconstruct)', () => {
    seedReconstructable();
    reconstructOrchestratorSession(getMultiAgentSession(SID)!, cbs());
    expect(getPauseExpiryRegistry().getScheduledCount()).toBe(0);
  });

  test('multiple paused participants → each gets its own timer', () => {
    seedReconstructable();
    const coder = getDb()
      .prepare<[], { id: number }>("SELECT id FROM projects WHERE name = 'Coder'")
      .get()!;
    const reviewer = getDb()
      .prepare<[], { id: number }>("SELECT id FROM projects WHERE name = 'Reviewer'")
      .get()!;
    setParticipantPause(SID, coder.id, Date.now() + 60_000, 'auto_resume');
    setParticipantPause(SID, reviewer.id, Date.now() + 90_000, 'auto_kick');

    reconstructOrchestratorSession(getMultiAgentSession(SID)!, cbs());

    const registry = getPauseExpiryRegistry();
    expect(registry.isScheduled(SID, coder.id)).toBe(true);
    expect(registry.isScheduled(SID, reviewer.id)).toBe(true);
    expect(registry.getScheduledCount()).toBe(2);
  });
});
