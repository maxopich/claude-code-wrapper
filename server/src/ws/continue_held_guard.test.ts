import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  appendMultiAgentMutation,
  createMultiAgentSession,
  setMutationPauseState,
} from '../repo/multi_agent.js';
import { describeHeldWorkers } from './server.js';

// Register B05 [security]. A pause-on-dangerous pause used to also set
// `awaiting_continue`, which is R-B's recovery state — so after a re-attach the
// operator saw TWO Continue buttons and the recovery one was a trap: it cleared
// `awaiting_continue` without touching the pause, leaving the gate disarmed for
// the rest of the session and the worker stranded mid-turn.
//
// Two fixes. The pause no longer sets `awaiting_continue` (so fresh pauses
// can't produce the double banner at all), and `continue_multi_agent` refuses
// while any worker is held — which is what still covers the legitimate overlap,
// a pause that was live when Cebab restarted.

const SID = 'sess-b05';

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-b05-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  createMultiAgentSession(SID, 'orchestrator', '001');
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function hold(agent: string, summary: string): void {
  const row = appendMultiAgentMutation(SID, agent, 'Bash', 'dangerous', summary, {
    filePath: null,
    cwd: `/ws/${agent}`,
    toolUseId: null,
  });
  setMutationPauseState(row.id, 'pending');
}

describe('describeHeldWorkers — recovery Continue guard [security]', () => {
  test('a session with nothing held can be continued', () => {
    expect(describeHeldWorkers(SID)).toBeNull();
  });

  test('a logged mutation that never hit the gate does not block Continue', () => {
    appendMultiAgentMutation(SID, 'coder', 'Write', 'mutate', 'create /tmp/x', {
      filePath: '/tmp/x',
      cwd: '/ws/coder',
      toolUseId: null,
    });
    expect(describeHeldWorkers(SID)).toBeNull();
  });

  test('a held worker blocks Continue and is named in the refusal', () => {
    hold('coder', 'rm -rf /tmp/x');
    const msg = describeHeldWorkers(SID);
    expect(msg).toContain('coder');
    // The refusal has to point at the button that DOES work, or the operator
    // is stuck staring at a session that won't continue.
    expect(msg).toContain("Continue button on that worker's banner");
  });

  test('every held worker is named, once each', () => {
    hold('coder', 'rm -rf /tmp/x');
    hold('reviewer', 'sudo rm /etc/hosts');
    hold('coder', 'rm -rf /tmp/y'); // same agent again — must not repeat
    const msg = describeHeldWorkers(SID) ?? '';
    expect(msg).toContain('coder, reviewer');
  });

  test('releasing the last held worker unblocks Continue', () => {
    const row = appendMultiAgentMutation(SID, 'coder', 'Bash', 'dangerous', 'rm -rf /tmp/x', {
      filePath: null,
      cwd: '/ws/coder',
      toolUseId: null,
    });
    setMutationPauseState(row.id, 'pending');
    expect(describeHeldWorkers(SID)).not.toBeNull();
    // `approved` is the post-Continue state — an unspent grant, not a hold.
    setMutationPauseState(row.id, 'approved');
    expect(describeHeldWorkers(SID)).toBeNull();
  });

  test("another session's held worker does not block this one", () => {
    createMultiAgentSession('other', 'orchestrator', '002');
    const row = appendMultiAgentMutation('other', 'coder', 'Bash', 'dangerous', 'rm -rf /x', {
      filePath: null,
      cwd: '/ws/coder',
      toolUseId: null,
    });
    setMutationPauseState(row.id, 'pending');
    expect(describeHeldWorkers(SID)).toBeNull();
  });
});
