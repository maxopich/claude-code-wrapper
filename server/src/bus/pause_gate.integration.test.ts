import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  appendMultiAgentMutation,
  clearPendingMutations,
  createMultiAgentSession,
  findUnconsumedApproval,
  listPendingMutations,
  setPauseOnDangerous,
  type MutationRecord,
} from '../repo/multi_agent.js';
import { isPausedForMutation, isTurnStalled, MutationNotRecordedError } from './errors.js';
import {
  applyPauseGate,
  releasePauseForMutation,
  shouldHaltUnrecordedMutation,
} from './pause_gate.js';

// The pause gate against a real DB. `pause_gate.test.ts` pins the pure decision
// table; this file pins the three register bugs that only show up once the
// state is persisted — all of which were invisible to a unit test because the
// state they got wrong lived on the SESSION row.
//
//   B06  worker B's dangerous command ran unapproved while worker A was paused
//   B07  one Continue disarmed the gate for the rest of the session
//   B05  covered at the WS layer; the repo-side half is that a released pause
//        leaves a grant rather than clearing the state
//
// [security]: these are the operator's only mechanical brake on a bus worker.

const SID = 'sess-gate';

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-pause-gate-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  createMultiAgentSession(SID, 'orchestrator', '001');
  setPauseOnDangerous(SID, true);
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Append a mutation exactly as the bus tap does, then gate it. Returns the
 *  row plus whether the gate halted the turn. */
function gate(
  agent: string,
  summary: string,
  category: 'mutate' | 'dangerous' = 'dangerous',
  onPending?: (sessionId: string, pending: MutationRecord[]) => void,
  onHold?: (agentName: string) => void,
): { row: MutationRecord; paused: boolean } {
  const row = appendMultiAgentMutation(SID, agent, 'Bash', category, summary, {
    filePath: null,
    cwd: `/ws/${agent}`,
    toolUseId: null,
  });
  try {
    applyPauseGate(row, onPending, onHold);
    return { row, paused: false };
  } catch (err) {
    if (!isPausedForMutation(err)) throw err;
    return { row, paused: true };
  }
}

describe('pause gate over a real DB [security]', () => {
  test('a dangerous call halts the turn and records the pause', () => {
    const { row, paused } = gate('coder', 'rm -rf /tmp/x');
    expect(paused).toBe(true);
    expect(listPendingMutations(SID).map((m) => m.id)).toEqual([row.id]);
  });

  test('an ordinary `mutate` runs free', () => {
    expect(gate('coder', 'create /tmp/note', 'mutate').paused).toBe(false);
    expect(listPendingMutations(SID)).toEqual([]);
  });

  test('nothing pauses when the operator never armed the gate', () => {
    setPauseOnDangerous(SID, false);
    expect(gate('coder', 'rm -rf /tmp/x').paused).toBe(false);
    expect(listPendingMutations(SID)).toEqual([]);
  });

  // B06. Workers are genuinely parallel (runner.ts: "Different agents stay
  // fully parallel"), and the old session-scoped slot meant the SECOND one
  // through the gate found a non-null slot and ran unapproved.
  test('B06: a second worker is gated while the first is paused', () => {
    expect(gate('coder', 'rm -rf /tmp/x').paused).toBe(true);
    expect(gate('reviewer', 'sudo rm /etc/hosts').paused).toBe(true);
    const held = listPendingMutations(SID);
    expect(held.map((m) => m.agentName)).toEqual(['coder', 'reviewer']);
  });

  test('B06: releasing one worker leaves the other held', () => {
    const first = gate('coder', 'rm -rf /tmp/x').row;
    gate('reviewer', 'sudo rm /etc/hosts');
    releasePauseForMutation(SID, first.id);
    expect(listPendingMutations(SID).map((m) => m.agentName)).toEqual(['reviewer']);
  });

  // B07. The old gate consulted a session-wide `mutations_acknowledged` that
  // the first Continue set forever.
  test('B07: the gate re-arms — a different dangerous command pauses again', () => {
    const first = gate('coder', 'rm -rf /tmp/x').row;
    releasePauseForMutation(SID, first.id);
    // The replayed turn re-issues the approved command; the grant covers it.
    expect(gate('coder', 'rm -rf /tmp/x').paused).toBe(false);
    // Anything else it does is a fresh decision.
    expect(gate('coder', 'sudo rm /etc/hosts').paused).toBe(true);
  });

  test('B07: an approval does not cover a different worker', () => {
    const first = gate('coder', 'rm -rf /tmp/x').row;
    releasePauseForMutation(SID, first.id);
    // Same command, different agent — grants are per-agent.
    expect(gate('reviewer', 'rm -rf /tmp/x').paused).toBe(true);
  });

  // The livelock guard. Resuming is a REPLAY, so the approved command comes
  // back; the grant lets it through exactly once and is then spent.
  test('the Continue grant is one-shot', () => {
    const first = gate('coder', 'rm -rf /tmp/x').row;
    releasePauseForMutation(SID, first.id);
    expect(findUnconsumedApproval(SID, 'coder', 'Bash', 'rm -rf /tmp/x')).not.toBeNull();

    expect(gate('coder', 'rm -rf /tmp/x').paused).toBe(false);
    expect(findUnconsumedApproval(SID, 'coder', 'Bash', 'rm -rf /tmp/x')).toBeNull();
    // Third time is a new decision — the operator approved one command, not a
    // standing licence to run it.
    expect(gate('coder', 'rm -rf /tmp/x').paused).toBe(true);
  });

  test('Continue is idempotent and rejects a stale id', () => {
    const first = gate('coder', 'rm -rf /tmp/x').row;
    expect(releasePauseForMutation(SID, first.id)?.id).toBe(first.id);
    // Second click on the same row: already released, nothing to do.
    expect(releasePauseForMutation(SID, first.id)).toBeNull();
    // An id that was never pending.
    expect(releasePauseForMutation(SID, 9999)).toBeNull();
  });

  test('the pending set is broadcast on both pause and release', () => {
    const seen: number[][] = [];
    const sink = (_sid: string, pending: MutationRecord[]) => seen.push(pending.map((m) => m.id));
    const a = gate('coder', 'rm -rf /tmp/x', 'dangerous', sink).row;
    gate('reviewer', 'sudo rm /etc/hosts', 'dangerous', sink);
    releasePauseForMutation(SID, a.id, sink);
    // Whole-set every time, never a delta — that is what makes a re-attach
    // re-emit idempotent in the reducer.
    expect(seen).toHaveLength(3);
    expect(seen[2]).toHaveLength(1);
    expect(seen[1]).toHaveLength(2);
  });

  test('teardown drops live pauses AND unspent grants', () => {
    const a = gate('coder', 'rm -rf /tmp/x').row;
    releasePauseForMutation(SID, a.id); // leaves an unspent grant
    gate('reviewer', 'sudo rm /etc/hosts'); // leaves a live pause

    clearPendingMutations(SID);

    expect(listPendingMutations(SID)).toEqual([]);
    // A grant outliving its session would silently pre-approve the same
    // command in a reconstructed run.
    expect(findUnconsumedApproval(SID, 'coder', 'Bash', 'rm -rf /tmp/x')).toBeNull();
  });

  // `Cebab-vie.13` [security]. The gate halts a turn by throwing; the agent's
  // turn QUEUE is the router's, so the gate reaches it through `holdAgent`.
  // The negative half matters as much as the positive: a hold taken on the
  // `run` or `consume-approval` branches would park an agent that the gate
  // just decided to let through, with no banner and so no way to release it.
  describe('the halt reaches the agent queue, and only on a real pause', () => {
    test('holdAgent fires once, naming the paused agent', () => {
      const holds: string[] = [];
      expect(
        gate('coder', 'rm -rf /tmp/x', 'dangerous', undefined, (n) => holds.push(n)).paused,
      ).toBe(true);
      expect(holds).toEqual(['coder']);
    });

    test('an ordinary `mutate` takes no hold', () => {
      const holds: string[] = [];
      gate('coder', 'create /tmp/note', 'mutate', undefined, (n) => holds.push(n));
      expect(holds).toEqual([]);
    });

    test('a disarmed gate takes no hold', () => {
      setPauseOnDangerous(SID, false);
      const holds: string[] = [];
      gate('coder', 'rm -rf /tmp/x', 'dangerous', undefined, (n) => holds.push(n));
      expect(holds).toEqual([]);
    });

    test('spending a Continue grant takes no hold — that call is being let through', () => {
      const first = gate('coder', 'rm -rf /tmp/x').row;
      releasePauseForMutation(SID, first.id);
      const holds: string[] = [];
      expect(
        gate('coder', 'rm -rf /tmp/x', 'dangerous', undefined, (n) => holds.push(n)).paused,
      ).toBe(false);
      expect(holds).toEqual([]);
    });

    // `Cebab-vie.16`: this case is REACHABLE now. It was written against
    // `decidePauseForMutation`'s stated contract and was green the whole time
    // while describing a call the runner never made — the pause's throw exited
    // the block loop, so no sibling ever reached the gate. The runner now
    // replays the dying message's remaining blocks through the same tap, which
    // is the caller this always meant.
    test('a sibling call from the already-dead turn takes no second hold', () => {
      gate('coder', 'rm -rf /tmp/x');
      const holds: string[] = [];
      gate('coder', 'rm -rf /tmp/y', 'dangerous', undefined, (n) => holds.push(n));
      expect(holds).toEqual([]);
    });

    test('a throwing holdAgent still halts the turn', () => {
      // The hold is in-memory and the throw is the operator's protection; a
      // runner that refuses the hold must not turn a pause into a green light.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect(
          gate('coder', 'rm -rf /tmp/x', 'dangerous', undefined, () => {
            throw new Error('runner gone');
          }).paused,
        ).toBe(true);
        expect(listPendingMutations(SID)).toHaveLength(1);
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  test('a halted agent does not stack a second pending row', () => {
    gate('coder', 'rm -rf /tmp/x');
    // Defensive: the agent's turn is dead, so the tap should not see another
    // call — but if it does, it must not duplicate the banner.
    expect(gate('coder', 'rm -rf /tmp/y').paused).toBe(false);
    expect(listPendingMutations(SID)).toHaveLength(1);
  });

  // D20 / migration 034. The unique index means a repeated `tool_use` id no
  // longer inserts — and the append sites `return` on a throw, upstream of
  // this gate. So "the constraint is enforced" and "the gate still runs" are
  // the same question, and only the second one is about the operator.
  describe('a repeated tool_use id still reaches the gate', () => {
    /** `gate`, but with a real tool_use id so the index applies. */
    function gateWithId(
      agent: string,
      summary: string,
      toolUseId: string,
    ): { row: MutationRecord; paused: boolean } {
      const row = appendMultiAgentMutation(SID, agent, 'Bash', 'dangerous', summary, {
        filePath: null,
        cwd: `/ws/${agent}`,
        toolUseId,
      });
      try {
        applyPauseGate(row);
        return { row, paused: false };
      } catch (err) {
        if (!isPausedForMutation(err)) throw err;
        return { row, paused: true };
      }
    }

    test('the replayed call halts the turn, on the row that already exists', () => {
      // The scenario: the operator releases the pause, Continue replays the
      // captured prompt, and the fresh turn re-issues the same command with
      // the same id. Pre-034 that appended a second row. Post-034 it must
      // resolve to the first one and pause again — migration 031 says the
      // grant is one command, one agent, once.
      const first = gateWithId('coder', 'rm -rf /tmp/x', 'toolu_replay');
      expect(first.paused).toBe(true);

      releasePauseForMutation(SID, first.row.id); // operator clicks Continue
      const replay = gateWithId('coder', 'rm -rf /tmp/x', 'toolu_replay');

      // The grant covers this exact command once, so the replay runs...
      expect(replay.paused).toBe(false);
      expect(replay.row.id).toBe(first.row.id);

      // ...and the NEXT repeat of the same id pauses again on the same row,
      // rather than sliding through on a spent grant or a duplicate.
      const third = gateWithId('coder', 'rm -rf /tmp/x', 'toolu_replay');
      expect(third.paused).toBe(true);
      expect(third.row.id).toBe(first.row.id);
      expect(listPendingMutations(SID).map((m) => m.id)).toEqual([first.row.id]);
    });

    test('control: an unarmed gate still lets the repeat through', () => {
      // Anti-vacuity for the case above — an append that started throwing
      // would fail both, so this pins that the pausing is the gate's doing.
      setPauseOnDangerous(SID, false);
      expect(gateWithId('coder', 'rm -rf /tmp/x', 'toolu_free').paused).toBe(false);
      expect(gateWithId('coder', 'rm -rf /tmp/x', 'toolu_free').paused).toBe(false);
      expect(listPendingMutations(SID)).toEqual([]);
    });
  });
});

// Cebab-aqd. `applyPauseGate` cannot run when the mutation could not be
// persisted — it reads the same table and marks the pause by row id. The
// routers' taps therefore take this decision in their catch instead, and it
// has to be the SAME decision, which is why it lives beside the gate.
describe('shouldHaltUnrecordedMutation — the gate when there is no row [security]', () => {
  test('a dangerous call under an armed gate HALTS', () => {
    expect(shouldHaltUnrecordedMutation(SID, 'dangerous')).toBe(true);
  });

  test('control: a dangerous call under a DISARMED gate runs', () => {
    // Anti-vacuity, and a real behaviour requirement: an operator who turned
    // the gate off chose that, and a failed write is no reason to kill their
    // turn. Without this case the fix could be "always halt" and still pass.
    setPauseOnDangerous(SID, false);
    expect(shouldHaltUnrecordedMutation(SID, 'dangerous')).toBe(false);
  });

  test('control: a `mutate` call runs even under an armed gate', () => {
    // Same rule `decidePauseForMutation` applies — the gate is for dangerous
    // commands only. A fix that halted every unrecorded mutation would stop
    // ordinary edits on a hiccup.
    expect(shouldHaltUnrecordedMutation(SID, 'mutate')).toBe(false);
  });

  test('an unreadable gate state HALTS — unknown resolves to caution', () => {
    // The database is sick enough that the mutation write failed; the session
    // read can fail too. Dropping the table it reads makes that real rather
    // than mocked.
    getDb().exec('DROP TABLE multi_agent_sessions');
    expect(shouldHaltUnrecordedMutation(SID, 'dangerous')).toBe(true);
  });

  test('control: an unreadable gate state still lets a `mutate` call run', () => {
    // The category check must come FIRST. If the fix read the session before
    // testing the category, a sick database would halt every mutation.
    getDb().exec('DROP TABLE multi_agent_sessions');
    expect(shouldHaltUnrecordedMutation(SID, 'mutate')).toBe(false);
  });
});

describe('MutationNotRecordedError routes to worker-failed, not to a silent pause [security]', () => {
  const err = new MutationNotRecordedError('Bash', 'rm -rf /tmp/x');

  test('isPausedForMutation is FALSE for it — the whole fix depends on this', () => {
    // Both routers' `deliver().catch` open with `if (isPausedForMutation(err))
    // return;`. If this error were recognised there, the turn would die
    // silently with no pending row and no banner, and the operator would see
    // an agent that simply stopped. It has to fall through to onWorkerFailed,
    // which parks a pending-retry slot and gives them Retry / Abandon.
    expect(isPausedForMutation(err)).toBe(false);
  });

  test('and it is not mistaken for a stalled turn either', () => {
    expect(isTurnStalled(err)).toBe(false);
  });

  test('its message says nothing ran, since it becomes the operator banner', () => {
    expect(err.message).toContain('Nothing was run');
    expect(err.message).toContain('rm -rf /tmp/x');
  });
});
