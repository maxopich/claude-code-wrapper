import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { addParticipant, createMultiAgentSession } from '../repo/multi_agent.js';
import { upsertProject } from '../repo/projects.js';
import { getControlState } from '../repo/per_agent_control.js';
import {
  executeKickParticipant,
  executeMuteParticipant,
  executePauseParticipant,
  executeResumeParticipant,
  executeUnmuteParticipant,
} from './control_verbs.js';
import { buildParticipantControlSnapshots } from './participant_control_snapshot.js';

// `Cebab-vie.6` / `Cebab-vie.4`: what a re-attaching browser is told about the
// controls standing over this session.
//
// Driven through the REAL verbs against real SQLite rather than by writing the
// participant columns directly, because half of what the snapshot carries does
// not live on those columns: mute/pause/kick reasons are only ever written to
// the hash chain, so a fixture that seeds the flags by hand would leave the
// audit join with nothing to find and every reason assertion would pass
// vacuously on an empty table.

const SID = 'sess-controls';

let tmpRoot: string;
let originalDataDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-control-snapshot-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Three workers so every case can control one and leave the others clear. */
function seedSession(sessionId = SID): { orchestratorId: number; workers: number[] } {
  const orchRow = upsertProject('orch', path.join(tmpRoot, 'orch'));
  createMultiAgentSession(sessionId, 'orchestrator');
  addParticipant(sessionId, orchRow.id, 'orchestrator');
  const workers: number[] = [];
  for (const name of ['alpha', 'beta', 'gamma']) {
    const row = upsertProject(name, path.join(tmpRoot, name));
    // A bus slug is required for the verbs to reach the router mirror.
    getDb()
      .prepare('UPDATE projects SET bus_agent_name = ?, bus_installed = 1 WHERE id = ?')
      .run(`${name}-slug`, row.id);
    addParticipant(sessionId, row.id, 'worker');
    workers.push(row.id);
  }
  return { orchestratorId: orchRow.id, workers };
}

function muteHandle() {
  const muted = new Set<string>();
  return {
    setMute: (name: string, on: boolean) => {
      const was = muted.has(name);
      if (on === was) return false;
      if (on) muted.add(name);
      else muted.delete(name);
      return true;
    },
    isMuted: (name: string) => muted.has(name),
  };
}

function pauseHandle() {
  const paused = new Set<string>();
  return {
    pauseAgent: (name: string) => (paused.has(name) ? false : (paused.add(name), true)),
    resumeAgent: (name: string) => paused.delete(name),
    hasAgent: () => true,
    getPendingDeliveries: () => 0,
  };
}

function kickHandle() {
  const kicked = new Set<string>();
  return {
    kickAgent: (name: string) => (kicked.has(name) ? false : (kicked.add(name), true)),
    isKicked: (name: string) => kicked.has(name),
  };
}

function mute(projectId: number, reasonCode = 'off_task', reasonText?: string) {
  return executeMuteParticipant({
    msg: {
      type: 'mute_participant',
      sessionId: SID,
      projectId,
      reasonCode: reasonCode as 'off_task',
      ...(reasonText ? { reasonText } : {}),
    },
    orchestratorHandle: muteHandle(),
    sessionMode: 'orchestrator',
  });
}

function pause(
  projectId: number,
  timeoutMs = 15 * 60_000,
  expiry: 'auto_resume' | 'auto_kick' = 'auto_resume',
) {
  return executePauseParticipant({
    msg: {
      type: 'pause_participant',
      sessionId: SID,
      projectId,
      reasonCode: 'forensics',
      reasonText: 'holding for inspection',
      timeoutMs,
      expiryAction: expiry,
    },
    orchestratorHandle: pauseHandle(),
    sessionMode: 'orchestrator',
  });
}

function kick(projectId: number) {
  return executeKickParticipant({
    msg: {
      type: 'kick_participant',
      sessionId: SID,
      projectId,
      reasonCode: 'tool_misuse',
      reasonText: 'kept editing outside its folder',
      mode: 'drain',
    },
    orchestratorHandle: kickHandle(),
    sessionMode: 'orchestrator',
  });
}

describe('[security] buildParticipantControlSnapshots — the state a refresh used to discard', () => {
  test('a session with no verbs applied yields nothing, though every participant HAS a row', () => {
    const { workers } = seedSession();
    // The green control that makes the rest meaningful: `listControlStates`
    // returns one row per participant, so "empty" here is the FILTER working,
    // not an empty table. Reverting the filter turns this into 4 blank entries.
    expect(getControlState(SID, workers[0])).toBeDefined();
    expect(buildParticipantControlSnapshots(SID)).toEqual([]);
  });

  test('a muted participant ships muted:true with the reason recovered from the chain', () => {
    const { workers } = seedSession();
    expect(mute(workers[0], 'runaway_loop', 'looping on the same file').ok).toBe(true);
    const snaps = buildParticipantControlSnapshots(SID);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      projectId: workers[0],
      muted: true,
      mutedReasonCode: 'runaway_loop',
      mutedReasonText: 'looping on the same file',
      pausedUntil: null,
      kickedAt: null,
    });
  });

  test('a paused participant ships its deadline, expiry action and reason', () => {
    const { workers } = seedSession();
    const result = pause(workers[1], 15 * 60_000, 'auto_kick');
    expect(result.ok).toBe(true);
    const snaps = buildParticipantControlSnapshots(SID);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      projectId: workers[1],
      muted: false,
      pauseExpiryAction: 'auto_kick',
      pauseReasonCode: 'forensics',
      pauseReasonText: 'holding for inspection',
      kickedAt: null,
    });
    expect(snaps[0].pausedUntil).toBeGreaterThan(Date.now());
  });

  test('a kicked participant ships kickedAt, its mode and its reason', () => {
    const { workers } = seedSession();
    expect(kick(workers[2]).ok).toBe(true);
    const snaps = buildParticipantControlSnapshots(SID);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      projectId: workers[2],
      kickMode: 'drain',
      kickReasonCode: 'tool_misuse',
      kickReasonText: 'kept editing outside its folder',
    });
    expect(snaps[0].kickedAt).not.toBeNull();
  });

  test('mute AND pause on one participant produce ONE entry carrying both', () => {
    const { workers } = seedSession();
    expect(mute(workers[0]).ok).toBe(true);
    expect(pause(workers[0]).ok).toBe(true);
    const snaps = buildParticipantControlSnapshots(SID);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].muted).toBe(true);
    expect(snaps[0].pausedUntil).not.toBeNull();
    // Each half keeps its own reason — the two audit lookups are per-kind, so
    // a single latest-row lookup would smear the pause reason over the mute.
    expect(snaps[0].mutedReasonCode).toBe('off_task');
    expect(snaps[0].pauseReasonCode).toBe('forensics');
  });

  test('an expired pause deadline ships VERBATIM — the liveness rule stays on the client', () => {
    const { workers } = seedSession();
    // A pause whose deadline is already behind us: the shape a session that
    // was paused before a long Cebab downtime comes back in. The client asks
    // `pausedUntil > Date.now()` in three places; a server-side filter here
    // would be a fourth answer, decided at attach time and then frozen.
    getDb()
      .prepare(
        `UPDATE multi_agent_participants SET paused_until = ?, pause_expiry_action = 'auto_resume'
         WHERE session_id = ? AND project_id = ?`,
      )
      .run(Date.now() - 60_000, SID, workers[0]);
    const snaps = buildParticipantControlSnapshots(SID);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].pausedUntil).toBeLessThan(Date.now());
  });

  test('a participant muted and then unmuted is omitted, not sent blank', () => {
    const { workers } = seedSession();
    expect(mute(workers[0]).ok).toBe(true);
    const unmute = executeUnmuteParticipant({
      msg: {
        type: 'unmute_participant',
        sessionId: SID,
        projectId: workers[0],
        reasonCode: 'topology_repair',
      },
      // Fresh handle whose set already holds the slug, so the unmute changes it.
      orchestratorHandle: (() => {
        const h = muteHandle();
        h.setMute('alpha-slug', true);
        return h;
      })(),
      sessionMode: 'orchestrator',
    });
    expect(unmute.ok).toBe(true);
    // The row survives with every flag clear. Absent and all-clear render
    // identically on every surface that reads this map, so the array carries
    // the same meaning the client's own map documents: presence == controlled.
    expect(getControlState(SID, workers[0])?.muted).toBe(false);
    expect(buildParticipantControlSnapshots(SID)).toEqual([]);
  });

  test('a paused-then-resumed participant is omitted too', () => {
    const { workers } = seedSession();
    expect(pause(workers[1]).ok).toBe(true);
    const resume = executeResumeParticipant({
      msg: {
        type: 'resume_participant',
        sessionId: SID,
        projectId: workers[1],
        reasonCode: 'topology_repair',
      },
      orchestratorHandle: { resumeAgent: () => true, getPendingDeliveries: () => 0 },
      sessionMode: 'orchestrator',
    });
    expect(resume.ok).toBe(true);
    expect(buildParticipantControlSnapshots(SID)).toEqual([]);
  });

  test('state survives an audit row whose reason_code is outside the vocabulary', () => {
    const { workers } = seedSession();
    expect(mute(workers[0], 'off_task').ok).toBe(true);
    // `findLatestControlReason` returns undefined rather than seeding a value
    // the typed handlers cannot validate. Losing a reason costs a tooltip;
    // dropping the entry would cost the operator the Unmute item, which is the
    // whole defect. Rewritten in place — the hash chain is checked on boot,
    // not on read, so this row still answers the query.
    getDb()
      .prepare(`UPDATE safety_audit SET reason_code = 'from_a_future_release' WHERE kind = ?`)
      .run('agent_control.muted');
    const snaps = buildParticipantControlSnapshots(SID);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].muted).toBe(true);
    expect(snaps[0].mutedReasonCode).toBeUndefined();
    expect(snaps[0].mutedReasonText).toBeUndefined();
  });

  test('only the requested session is answered for', () => {
    const { workers } = seedSession();
    expect(mute(workers[0]).ok).toBe(true);
    const otherOrch = upsertProject('orch2', path.join(tmpRoot, 'orch2'));
    createMultiAgentSession('sess-other', 'orchestrator');
    addParticipant('sess-other', otherOrch.id, 'orchestrator');
    addParticipant('sess-other', workers[1], 'worker');
    expect(buildParticipantControlSnapshots('sess-other')).toEqual([]);
    expect(buildParticipantControlSnapshots(SID)).toHaveLength(1);
  });

  test('three controlled participants come back in projectId order, one entry each', () => {
    const { workers } = seedSession();
    expect(mute(workers[0]).ok).toBe(true);
    expect(pause(workers[1]).ok).toBe(true);
    expect(kick(workers[2]).ok).toBe(true);
    const snaps = buildParticipantControlSnapshots(SID);
    expect(snaps.map((s) => s.projectId)).toEqual([...workers].sort((a, b) => a - b));
    expect(snaps.map((s) => s.muted)).toEqual([true, false, false]);
    expect(snaps.map((s) => s.pausedUntil !== null)).toEqual([false, true, false]);
    expect(snaps.map((s) => s.kickedAt !== null)).toEqual([false, false, true]);
  });
});
