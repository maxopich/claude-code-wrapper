import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  appendMultiAgentMutation,
  createMultiAgentSession,
  getMultiAgentSession,
  setAwaitingContinue,
  setMutationPauseState,
} from '../repo/multi_agent.js';
import { executeContinueMultiAgent } from './server.js';

/**
 * Register S08: the RECOVERY Continue must not eat the operator's only way back.
 *
 * `awaiting_continue` is what makes a restart-recovered (R-B) session
 * continuable at all: the handler refuses outright once it reads 0, and
 * `emitResumedSession` re-reads the column from the DB, so a reload restores
 * whatever the column says rather than the operator's intent. The flag is
 * cleared BEFORE delivery on purpose — a racing second click has to find 0 and
 * no-op — which means a delivery that throws used to leave the session
 * permanently unresumable: banner gone, guard armed, nothing left but a toast.
 *
 * These cases pin both halves. The clear still happens on success (otherwise a
 * "fix" that simply stopped clearing would pass the failure case), and the
 * failure path re-arms — proved by the operator's next click actually landing.
 */

const SID = 'sess-s08';

let tmpRoot: string;
let originalDataDir: string;
let sent: ServerMsg[];

/** No project-level MCP denials — the gate is exercised separately below. */
const noDenials = async () => new Map<number, string[]>();

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-s08-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  sent = [];
  createMultiAgentSession(SID, 'orchestrator', '001');
  setAwaitingContinue(SID, true);
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function isAwaiting(sessionId = SID): boolean {
  return getMultiAgentSession(sessionId)?.awaiting_continue === 1;
}

describe('executeContinueMultiAgent — the flag survives a failed delivery (S08)', () => {
  test('delivery throws → the flag is restored and the NEXT Continue lands', async () => {
    const failing = vi.fn(async () => {
      throw new Error('bus went away mid-nudge');
    });

    await executeContinueMultiAgent({
      sessionId: SID,
      activeSessionId: SID,
      sendUserPrompt: failing,
      gateProjects: noDenials,
      applyMcpDenials: vi.fn(),
      send: (m) => sent.push(m),
    });

    expect(failing).toHaveBeenCalledTimes(1);
    expect(sent[0]).toMatchObject({
      type: 'wrapper_error',
      message: 'bus went away mid-nudge',
    });
    expect(isAwaiting()).toBe(true);

    // The point of restoring it: the operator can click again. Without the
    // re-arm this second call returns at the `awaiting_continue !== 1` guard
    // and the session is stranded for good.
    const working = vi.fn(async () => {});
    await executeContinueMultiAgent({
      sessionId: SID,
      activeSessionId: SID,
      sendUserPrompt: working,
      gateProjects: noDenials,
      applyMcpDenials: vi.fn(),
      send: (m) => sent.push(m),
    });

    expect(working).toHaveBeenCalledTimes(1);
    expect(isAwaiting()).toBe(false);
  });

  test('delivery succeeds → the flag stays cleared', async () => {
    // The control. A "fix" that never cleared the flag would satisfy the case
    // above while breaking the double-click guard this ordering exists for.
    const working = vi.fn(async () => {});

    await executeContinueMultiAgent({
      sessionId: SID,
      activeSessionId: SID,
      sendUserPrompt: working,
      gateProjects: noDenials,
      applyMcpDenials: vi.fn(),
      send: (m) => sent.push(m),
    });

    expect(working).toHaveBeenCalledTimes(1);
    expect(isAwaiting()).toBe(false);
    expect(sent).toEqual([]);

    // …and a second click is now the intended no-op, not a second nudge.
    const second = vi.fn(async () => {});
    await executeContinueMultiAgent({
      sessionId: SID,
      activeSessionId: SID,
      sendUserPrompt: second,
      gateProjects: noDenials,
      applyMcpDenials: vi.fn(),
      send: (m) => sent.push(m),
    });
    expect(second).not.toHaveBeenCalled();
  });

  test('the nudge is delivered before the flag can be observed as cleared', async () => {
    // Ordering assertion, not a duplicate of the two above: the clear must be
    // in place while `sendUserPrompt` runs, since that await is exactly the
    // window a double-click races.
    let awaitingDuringDelivery: boolean | null = null;
    await executeContinueMultiAgent({
      sessionId: SID,
      activeSessionId: SID,
      sendUserPrompt: async () => {
        awaitingDuringDelivery = isAwaiting();
      },
      gateProjects: noDenials,
      applyMcpDenials: vi.fn(),
      send: (m) => sent.push(m),
    });

    expect(awaitingDuringDelivery).toBe(false);
  });
});

describe('executeContinueMultiAgent — refusals leave the recovery state intact (S08)', () => {
  test('[security] a refused spawn gate never clears the flag', async () => {
    // The comment above the gate promises it runs BEFORE the clear, so a
    // refused or unanswered MCP-trust decision leaves the session recovered
    // rather than half-continued. Pinned here because nothing else asserts it.
    const deliver = vi.fn(async () => {});

    await executeContinueMultiAgent({
      sessionId: SID,
      activeSessionId: SID,
      sendUserPrompt: deliver,
      gateProjects: async () => {
        throw new Error('operator denied the MCP server');
      },
      applyMcpDenials: vi.fn(),
      send: (m) => sent.push(m),
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(isAwaiting()).toBe(true);
    expect(sent[0]).toMatchObject({
      type: 'wrapper_error',
      message: 'operator denied the MCP server',
    });
  });

  test('[security] a held worker blocks Continue without clearing the flag', async () => {
    // Register B05's refusal: a pause-on-dangerous hold that survived the
    // restart coexists with R-B's own awaiting_continue. Refusing must not
    // spend the recovery state on a Continue that did not happen.
    const row = appendMultiAgentMutation(SID, 'coder', 'Bash', 'dangerous', 'rm -rf /x', {
      filePath: null,
      cwd: '/ws/coder',
      toolUseId: null,
    });
    setMutationPauseState(row.id, 'pending');
    const deliver = vi.fn(async () => {});

    await executeContinueMultiAgent({
      sessionId: SID,
      activeSessionId: SID,
      sendUserPrompt: deliver,
      gateProjects: noDenials,
      applyMcpDenials: vi.fn(),
      send: (m) => sent.push(m),
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(isAwaiting()).toBe(true);
    expect(sent[0]).toMatchObject({ type: 'wrapper_error' });
  });

  // `Cebab-2t9.1`: a chain run is now reconstructed read-only after a restart,
  // so a chain handle (no `sendUserPrompt`) IS reachable here. Continuing the
  // pipeline is a follow-up, so it must still refuse loudly and leave
  // `awaiting_continue` untouched — only the message changed.
  test('a chain handle is refused loudly, and the flag is untouched', async () => {
    await executeContinueMultiAgent({
      sessionId: SID,
      activeSessionId: SID,
      sendUserPrompt: null,
      gateProjects: noDenials,
      applyMcpDenials: vi.fn(),
      send: (m) => sent.push(m),
    });

    expect(sent[0]).toMatchObject({ type: 'wrapper_error', kind: 'process_crashed' });
    expect((sent[0] as { message: string }).message).toMatch(
      /chain session was recovered read-only/i,
    );
    expect(isAwaiting()).toBe(true);
  });

  test('a Continue for a session this connection is not attached to is dropped', async () => {
    const deliver = vi.fn(async () => {});

    await executeContinueMultiAgent({
      sessionId: SID,
      activeSessionId: 'some-other-session',
      sendUserPrompt: deliver,
      gateProjects: noDenials,
      applyMcpDenials: vi.fn(),
      send: (m) => sent.push(m),
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(isAwaiting()).toBe(true);
  });
});
