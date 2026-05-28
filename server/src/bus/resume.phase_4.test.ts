import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { attemptResumeMultiAgent } from './resume.js';
import { hasLiveSession, unregisterLiveSession } from './session_registry.js';
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
    // Tiny delay so started_at differs (sort order: newest first).
    await new Promise((resolve) => setTimeout(resolve, 10));
    const newer = createMultiAgentSession(NEWER_SID, 'orchestrator');

    const sent: ServerMsg[] = [];
    const resumed = await attemptResumeMultiAgent({
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      hopBudget: 1000,
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
      supersedingTs: newer.started_at,
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
      sendServerMsg: (m) => sent.push(m),
    });

    expect(sent.find((m) => m.type === 'session_superseded')).toBeUndefined();
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
      sendServerMsg: (m) => sent.push(m),
    });

    expect(sent.find((m) => m.type === 'chain_not_reconstructed')).toBeUndefined();
  });
});
