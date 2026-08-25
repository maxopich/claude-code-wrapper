import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { attemptResumeMultiAgent } from './resume.js';
import { hasLiveSession, registerLiveSession, unregisterLiveSession } from './session_registry.js';
import { createMultiAgentSession, getMultiAgentSession } from '../repo/multi_agent.js';
import { _resetCoalesceState } from '../notifications/dispatcher.js';

// Cluster A Phase 4 (D2 precursor / D3 / BE-11): exercise the two
// previously-silent code paths in `bus/resume.ts` that now ship typed
// ServerMsgs + dispatcher-fanned warn toasts to the operator:
//
//   1. session_superseded — `attemptResumeMultiAgent` finds an older
//      `running` row alongside the candidate (a server restart between
//      two iteration starts) → the older row becomes a "supersede" event
//      pointing at the candidate's id/ts; was a silent `markCrashedSilent`.
//
//   2. chain_not_reconstructed — `attemptResumeMultiAgent` finds a chain
//      row, can't reconstruct (chain R-B is deferred), and now ships a
//      typed event BEFORE the generic `multi_agent_ended { reason:
//      'crashed' }` path runs. Spec BE-11.

const NEWER_SID = 'phase4-newer';
const OLDER_SID = 'phase4-older';
const CHAIN_SID = 'phase4-chain';

/** Fixed `started_at` values, so ordering is stated rather than raced for. */
const OLDER_TS = 1_700_000_000_000;
const NEWER_TS = 1_700_000_000_500;
/** Both rows on the same millisecond — the tie only `rowid DESC` can break. */
const TIED_TS = 1_700_000_001_000;

/**
 * Stamp an explicit `started_at` on a row that was just created.
 *
 * Register C19. This replaces `await new Promise(r => setTimeout(r, 10))`,
 * whose comment read "Tiny delay so started_at differs". A real sleep is not a
 * way to make two timestamps differ: on Windows the clock granularity is
 * around fifteen milliseconds, so both rows could land on the same tick and
 * the ordering — and the assertion built on it — flipped. Injecting the value
 * states the ordering the test is about instead of hoping the clock provides
 * it, and it is faster.
 *
 * `createMultiAgentSession` stamps `Date.now()` internally with no seam, and
 * adding a production parameter to serve a test is the wrong trade — this is
 * one `UPDATE` against a table the test already owns.
 */
function stampStartedAt(sessionId: string, startedAt: number): void {
  getDb()
    .prepare('UPDATE multi_agent_sessions SET started_at = ? WHERE id = ?')
    .run(startedAt, sessionId);
}

let tmpRoot: string;
let originalDataDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-phase4-resume-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetCoalesceState();
});

afterEach(() => {
  warnSpy.mockRestore();
  errSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  unregisterLiveSession(NEWER_SID);
  unregisterLiveSession(OLDER_SID);
  unregisterLiveSession(CHAIN_SID);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('[BE-11 / D3] attemptResumeMultiAgent emits session_superseded for orphan rows', () => {
  test('older active row is reported as session_superseded with the candidate id/ts', async () => {
    // Two `running` rows. Both have NO session_folder so neither can be
    // R-B reconstructed; we're only interested in the older-row sweep, not
    // the reattach.
    createMultiAgentSession(OLDER_SID, 'orchestrator');
    stampStartedAt(OLDER_SID, OLDER_TS);
    createMultiAgentSession(NEWER_SID, 'orchestrator');
    stampStartedAt(NEWER_SID, NEWER_TS);

    const sent: ServerMsg[] = [];
    const resumed = await attemptResumeMultiAgent({
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      hopBudget: 1000,
      maxTurns: 50,
      sendServerMsg: (m) => sent.push(m),
    });

    // The candidate (newer) wasn't reconstructable either (no folder), so
    // resume returns null + onResumeFailed is called for the candidate.
    // The orphan (older) was crashed AND announced as superseded.
    expect(resumed).toBeNull();
    expect(getMultiAgentSession(OLDER_SID)!.status).toBe('crashed');

    const superseded = sent.find((m) => m.type === 'session_superseded');
    expect(superseded).toMatchObject({
      type: 'session_superseded',
      sessionId: OLDER_SID,
      supersedingSessionId: NEWER_SID,
      supersedingTs: NEWER_TS,
    });

    const toast = sent.find((m) => m.type === 'notification');
    expect(toast).toMatchObject({
      type: 'notification',
      class: 'operational',
      severity: 'warn',
      sessionId: OLDER_SID,
      sticky: true,
      // Cluster D Phase 5: action flipped from {kind:'reopen'} to
      // {kind:'archive'} — reopen needs the workspace-diff modal (5b)
      // and would be a dead-end on the toast until then. App.tsx's
      // onNotificationAction routes `archive` to `archive_session`
      // which the ws/server.ts handler now implements.
      action: { kind: 'archive', sessionId: OLDER_SID },
      dedupeKey: `session_superseded:${OLDER_SID}`,
      // Cluster A Phase 6: §7 floor sub-code label so the inbox filter
      // chip can group the row with `reconstructed` / `reconstruction_failed`.
      reasonCode: 'swept_competing',
    });
  });

  test('no orphan rows → no session_superseded emission', async () => {
    // Just one running row — no older active rows to sweep.
    createMultiAgentSession(NEWER_SID, 'orchestrator');

    const sent: ServerMsg[] = [];
    await attemptResumeMultiAgent({
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      hopBudget: 1000,
      maxTurns: 50,
      sendServerMsg: (m) => sent.push(m),
    });

    expect(sent.find((m) => m.type === 'session_superseded')).toBeUndefined();
  });

  /**
   * Register C20 — THE case that catches the missing tiebreaker, and the only
   * one that can. The two tests above stamp DISTINCT timestamps, so they pass
   * whether or not `listActiveMultiAgentSessions` breaks ties; they are the
   * control for the primary sort, not a gate on C20.
   *
   * Measured before writing: with equal `started_at` and no tiebreaker, the
   * planner walks `multi_agent_sessions_status_idx` in index order, which
   * within an equal key is rowid ASC — so the OLDER row came back first and
   * became the resume candidate, while the NEWER row was marked crashed. That
   * is backwards for a query documented as "most recent first", and it is what
   * this case pins.
   *
   * `, rowid ASC` would keep the index and cost nothing, and would leave this
   * test red — which is the whole reason `rowid DESC` is what shipped. See
   * SESSION_ORDER in `repo/multi_agent.ts`.
   */
  test('same-millisecond rows: the LATER-inserted one is the candidate, not the older', async () => {
    createMultiAgentSession(OLDER_SID, 'orchestrator');
    createMultiAgentSession(NEWER_SID, 'orchestrator');
    // Identical timestamps: insertion order is the only thing left to sort on.
    stampStartedAt(OLDER_SID, TIED_TS);
    stampStartedAt(NEWER_SID, TIED_TS);

    const sent: ServerMsg[] = [];
    await attemptResumeMultiAgent({
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      hopBudget: 1000,
      maxTurns: 50,
      sendServerMsg: (m) => sent.push(m),
    });

    // NEWER_SID was inserted second, so it is the candidate and survives the
    // sweep; OLDER_SID is the orphan.
    expect(getMultiAgentSession(OLDER_SID)!.status).toBe('crashed');
    expect(sent.find((m) => m.type === 'session_superseded')).toMatchObject({
      sessionId: OLDER_SID,
      supersedingSessionId: NEWER_SID,
      supersedingTs: TIED_TS,
    });
  });
});

// Register B02 [security]. The sweep above assumes every older `running` row
// is a dead orphan. It wasn't: `start_multi_agent`'s guard was
// per-CONNECTION, so two browser windows could each start a session and both
// stay live in this process. Marking the older one `crashed` while its
// AgentRunner kept delivering turns told the operator a lie AND left agents
// executing with no session the UI could stop.
//
// Two halves: the sweep now tears down a live orphan before reporting it
// crashed (here), and the start guard is process-wide (see
// `ws/start_guard_global.test.ts`) so the overlap can't be created any more.
describe('[B02] the supersede sweep does not crash-mark a still-live session [security]', () => {
  /** Register a fake live session whose stop() we can observe. */
  function registerFakeLive(sessionId: string, stop: () => Promise<void>) {
    registerLiveSession({
      sessionId,
      mode: 'orchestrator',
      handle: {
        sessionId,
        iterationId: 'iter-1',
        participantAgentNames: [],
        lifecycle: 'temp',
        sessionFolder: '',
        stop,
        detach: () => {},
        retry: async () => {},
        continueThroughMutation: async () => {},
      },
      rebind: () => 1,
      sendServerMsg: () => {},
    });
  }

  test('a live older session is STOPPED before it is marked crashed', async () => {
    createMultiAgentSession(OLDER_SID, 'orchestrator');
    await new Promise((resolve) => setTimeout(resolve, 10));
    createMultiAgentSession(NEWER_SID, 'orchestrator');

    const stopped: string[] = [];
    registerFakeLive(OLDER_SID, async () => {
      // Assert ordering from inside stop(): the row must still be `running`
      // here. If the sweep marked it crashed first, the operator would have
      // been told the session died while its agents were mid-teardown.
      expect(getMultiAgentSession(OLDER_SID)!.status).toBe('running');
      stopped.push(OLDER_SID);
    });

    await attemptResumeMultiAgent({
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      hopBudget: 1000,
      maxTurns: 50,
      sendServerMsg: vi.fn(),
    });

    expect(stopped).toEqual([OLDER_SID]);
    expect(getMultiAgentSession(OLDER_SID)!.status).toBe('crashed');
  });

  test('a dead older row still sweeps without a stop (unchanged behaviour)', async () => {
    // Nothing registered → nothing to stop. This is the ordinary
    // server-restart case and must not regress.
    createMultiAgentSession(OLDER_SID, 'orchestrator');
    await new Promise((resolve) => setTimeout(resolve, 10));
    createMultiAgentSession(NEWER_SID, 'orchestrator');

    const sent: ServerMsg[] = [];
    await attemptResumeMultiAgent({
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      hopBudget: 1000,
      maxTurns: 50,
      sendServerMsg: (m) => sent.push(m),
    });

    expect(getMultiAgentSession(OLDER_SID)!.status).toBe('crashed');
    expect(sent.find((m) => m.type === 'session_superseded')).toBeDefined();
  });

  test('a stop() that throws still leaves the row crashed, never running', async () => {
    // The row must not stay `running` — that is the state that makes a dead
    // session look resumable and re-enter this sweep forever.
    createMultiAgentSession(OLDER_SID, 'orchestrator');
    await new Promise((resolve) => setTimeout(resolve, 10));
    createMultiAgentSession(NEWER_SID, 'orchestrator');

    registerFakeLive(OLDER_SID, async () => {
      throw new Error('teardown exploded');
    });

    const sent: ServerMsg[] = [];
    await expect(
      attemptResumeMultiAgent({
        onEvent: vi.fn(),
        onEnded: vi.fn(),
        hopBudget: 1000,
        maxTurns: 50,
        sendServerMsg: (m) => sent.push(m),
      }),
    ).resolves.not.toThrow();

    expect(getMultiAgentSession(OLDER_SID)!.status).toBe('crashed');
    expect(sent.find((m) => m.type === 'session_superseded')).toBeDefined();
  });
});

describe('[BE-11 / D2 precursor] attemptResumeMultiAgent emits chain_not_reconstructed', () => {
  test('chain row produces chain_not_reconstructed BEFORE onResumeFailed fires', async () => {
    createMultiAgentSession(CHAIN_SID, 'chain');
    expect(hasLiveSession(CHAIN_SID)).toBe(false);

    const sent: ServerMsg[] = [];
    const calls: string[] = [];
    const onResumeFailed = vi.fn(() => calls.push('onResumeFailed'));

    const resumed = await attemptResumeMultiAgent({
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      hopBudget: 1000,
      maxTurns: 50,
      onResumeFailed,
      sendServerMsg: (m) => {
        sent.push(m);
        calls.push(`sendServerMsg:${m.type}`);
      },
    });

    expect(resumed).toBeNull();
    expect(getMultiAgentSession(CHAIN_SID)!.status).toBe('crashed');
    expect(onResumeFailed).toHaveBeenCalledWith(CHAIN_SID, 'reattach-failed');

    // BE-11: typed event ships BEFORE onResumeFailed.
    const chainEventIdx = calls.findIndex((c) => c === 'sendServerMsg:chain_not_reconstructed');
    const failedIdx = calls.findIndex((c) => c === 'onResumeFailed');
    expect(chainEventIdx).toBeGreaterThanOrEqual(0);
    expect(failedIdx).toBeGreaterThan(chainEventIdx);

    expect(sent.find((m) => m.type === 'chain_not_reconstructed')).toMatchObject({
      type: 'chain_not_reconstructed',
      sessionId: CHAIN_SID,
    });
    expect(sent.find((m) => m.type === 'notification')).toMatchObject({
      type: 'notification',
      class: 'operational',
      severity: 'warn',
      sessionId: CHAIN_SID,
      sticky: true,
      dedupeKey: `chain_not_reconstructed:${CHAIN_SID}`,
      // Cluster D Phase 7: the notification now carries an `archive`
      // action so the operator can clear the dead chain row from the
      // Iterations list without dropping to the panel. Same shape as
      // the swept-session toast (Phase 5).
      action: { kind: 'archive', sessionId: CHAIN_SID },
    });
  });

  test('orchestrator row whose folder is gone does NOT emit chain_not_reconstructed', async () => {
    // A non-chain row that's just not reconstructable for OTHER reasons
    // (no folder/iteration/agent-sessions) stays silent — chain-mode is
    // the only Phase 4 typed surface for the resume-bail path.
    createMultiAgentSession(NEWER_SID, 'orchestrator', null, null, 'persistent');

    const sent: ServerMsg[] = [];
    await attemptResumeMultiAgent({
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      hopBudget: 1000,
      maxTurns: 50,
      sendServerMsg: (m) => sent.push(m),
    });

    expect(sent.find((m) => m.type === 'chain_not_reconstructed')).toBeUndefined();
  });
});
