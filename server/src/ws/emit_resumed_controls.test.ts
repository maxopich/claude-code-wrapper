import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  addParticipant,
  createMultiAgentSession,
  getMultiAgentSession,
} from '../repo/multi_agent.js';
import { upsertProject } from '../repo/projects.js';
import { executeKickParticipant, executeMuteParticipant } from './control_verbs.js';
import { emitResumedSession } from './server.js';
import type { ResumedSession } from '../bus/resume.js';
import type { OrchestratorSessionHandle } from '../bus/orchestrator.js';

// `Cebab-vie.6` / `Cebab-vie.4`: the attach envelope itself.
//
// `buildParticipantControlSnapshots` having the right answer is worth nothing
// if the envelope does not carry it, and that is not a hypothetical failure —
// it is the shape of the bug being fixed, since a `multi_agent_started` with
// no control state looks exactly like a session with no controls.
//
// So this calls the REAL `emitResumedSession` with a capturing socket rather
// than re-deriving the field. The neighbouring `multi_agent_started.mock.test.ts`
// takes the other approach — it re-implements the handler's projection inline
// under a comment saying so — and therefore cannot fail when the handler drops
// the field it is about. Reverting either emit site to a literal `[]` reddens
// the cases below.

const SID = 'sess-attach';

let tmpRoot: string;
let originalDataDir: string;
let sent: ServerMsg[];
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-attach-controls-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  sent = [];
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Capturing stand-in for the browser socket. `send()` gates on OPEN (1). */
function fakeConn(): Parameters<typeof emitResumedSession>[0] {
  return {
    ws: {
      readyState: 1,
      send: (raw: string) => sent.push(JSON.parse(raw) as ServerMsg),
    },
    multiAgent: null,
    multiAgentSinkEpoch: 0,
  } as unknown as Parameters<typeof emitResumedSession>[0];
}

function resumed(sessionId = SID): ResumedSession {
  const row = getMultiAgentSession(sessionId)!;
  const handle = {
    sessionId,
    mode: 'orchestrator' as const,
    participantAgentNames: [] as string[],
    lifecycle: row.lifecycle ?? 'persistent',
    sessionFolder: row.session_folder ?? null,
    hopBudget: 100,
    maxTurns: 50,
    pauseOnDangerous: false,
    executeMode: false,
  };
  return {
    handle: handle as unknown as OrchestratorSessionHandle,
    mode: 'orchestrator',
    row,
    replayEvents: [],
    sinkEpoch: 1,
  };
}

function seed(): { workerId: number } {
  const orchRow = upsertProject('orch', path.join(tmpRoot, 'orch'));
  const workerRow = upsertProject('worker', path.join(tmpRoot, 'worker'));
  getDb()
    .prepare('UPDATE projects SET bus_agent_name = ?, bus_installed = 1 WHERE id = ?')
    .run('worker-slug', workerRow.id);
  createMultiAgentSession(SID, 'orchestrator');
  addParticipant(SID, orchRow.id, 'orchestrator');
  addParticipant(SID, workerRow.id, 'worker');
  return { workerId: workerRow.id };
}

function started(): Extract<ServerMsg, { type: 'multi_agent_started' }> {
  const msg = sent.find((m) => m.type === 'multi_agent_started');
  expect(msg).toBeDefined();
  return msg as Extract<ServerMsg, { type: 'multi_agent_started' }>;
}

describe('[security] emitResumedSession — the re-attach envelope carries standing controls', () => {
  test('a live mute reaches the browser on attach', () => {
    const { workerId } = seed();
    const result = executeMuteParticipant({
      msg: {
        type: 'mute_participant',
        sessionId: SID,
        projectId: workerId,
        reasonCode: 'runaway_loop',
        reasonText: 'same edit on repeat',
      },
      orchestratorHandle: { setMute: () => true, isMuted: () => false },
      sessionMode: 'orchestrator',
    });
    expect(result.ok).toBe(true);

    emitResumedSession(fakeConn(), resumed());

    expect(started().participantControls).toEqual([
      expect.objectContaining({
        projectId: workerId,
        muted: true,
        mutedReasonCode: 'runaway_loop',
        mutedReasonText: 'same edit on repeat',
      }),
    ]);
  });

  test('a kick reaches it too, so the menu comes back on its forensics-only branch', () => {
    const { workerId } = seed();
    const result = executeKickParticipant({
      msg: {
        type: 'kick_participant',
        sessionId: SID,
        projectId: workerId,
        reasonCode: 'tool_misuse',
        mode: 'drain',
      },
      orchestratorHandle: { kickAgent: () => true, isKicked: () => false },
      sessionMode: 'orchestrator',
    });
    expect(result.ok).toBe(true);

    emitResumedSession(fakeConn(), resumed());

    const [ctrl] = started().participantControls;
    expect(ctrl.projectId).toBe(workerId);
    expect(ctrl.kickedAt).not.toBeNull();
    expect(ctrl.kickMode).toBe('drain');
  });

  test('a session with nothing controlled attaches with an empty array, not a missing field', () => {
    seed();
    emitResumedSession(fakeConn(), resumed());
    // The distinction the required wire field exists to preserve: `[]` is a
    // measured "nothing is restrained", where an omitted field would be
    // indistinguishable from an emit site that forgot to look.
    expect(started().participantControls).toEqual([]);
    expect('participantControls' in started()).toBe(true);
  });
});
