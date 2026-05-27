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
import { upsertProject } from '../repo/projects.js';

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
});

afterEach(() => {
  warnSpy.mockRestore();
  errSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  unregisterLiveSession(SID);
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
