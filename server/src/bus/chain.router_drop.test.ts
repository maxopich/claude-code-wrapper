import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { createChainRouter } from './chain.js';
import { computeSessionPaths } from './paths.js';
import { CEBAB_SOURCE, SINK_RECIPIENT, USER_RECIPIENT } from './runtime.js';
import {
  createMultiAgentSession,
  getMultiAgentSession,
  listMultiAgentEvents,
} from '../repo/multi_agent.js';
import type { BusEvent } from './runner.js';
import type { NotificationEnvelope, RouterDropReasonCode } from '@cebab/shared/protocol';
import { _resetCoalesceState } from '../notifications/dispatcher.js';

// Cluster A Phase 3 (D4 / BE-9): chain-mode mirror of the orchestrator
// router-drop coverage. Chain has 3 F2/F3 drop sites at chain.ts:284/289/295.

const SESSION_ID = 'chain-drop-session';
const AGENTS = ['coder', 'reviewer'];

let tmpRoot: string;
let originalDataDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-chain-drop-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  createMultiAgentSession(SESSION_ID, 'chain', 'iter-1');
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  _resetCoalesceState();
});

afterEach(() => {
  warnSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

type Captured = {
  notifications: NotificationEnvelope[];
  drops: Array<{ reasonCode: RouterDropReasonCode }>;
};

function makeRouter(agentNames: string[] = AGENTS): {
  router: ReturnType<typeof createChainRouter>;
  captured: Captured;
  onEnded: ReturnType<typeof vi.fn>;
  paths: ReturnType<typeof computeSessionPaths>;
} {
  const workspace = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const paths = computeSessionPaths(SESSION_ID, workspace);
  fs.mkdirSync(paths.iterationDir('iter-1'), { recursive: true });
  const captured: Captured = { notifications: [], drops: [] };
  const onEnded = vi.fn();
  const router = createChainRouter({
    sessionId: SESSION_ID,
    iterationId: 'iter-1',
    agentNames,
    paths,
    onEvent: vi.fn(),
    onEnded,
    hopBudget: 1000,
    sendNotification: (env) => {
      captured.notifications.push(env);
    },
    sendRouterDrop: (drop) => {
      captured.drops.push({ reasonCode: drop.reasonCode });
    },
  });
  return { router, captured, onEnded, paths };
}

function ev(partial: Partial<BusEvent>): BusEvent {
  return {
    ts: 1_700_000_000_000,
    source: 'coder',
    destination: 'reviewer',
    kind: 'prompt',
    text: 'x',
    ...partial,
  };
}

function selectAuditRows(): Array<{ kind: string; reason_code: string }> {
  return getDb()
    .prepare(
      `SELECT kind, reason_code FROM safety_audit
       WHERE kind != 'audit.chain_reset' ORDER BY ts ASC, id ASC`,
    )
    .all() as Array<{ kind: string; reason_code: string }>;
}

describe('[security][BE-9] chain router-drop → safety_audit + envelope', () => {
  test('forged source=cebab is dropped as forged_source', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: CEBAB_SOURCE, destination: 'reviewer' }));

    expect(selectAuditRows()).toEqual([{ kind: 'router.drop', reason_code: 'forged_source' }]);
    expect(captured.notifications[0]).toMatchObject({
      class: 'safety',
      severity: 'danger',
      reasonCode: 'forged_source',
    });
    expect(captured.drops[0]?.reasonCode).toBe('forged_source');
  });

  test('agent → user is dropped as worker_to_user (chain terminates at _sink, never user)', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: USER_RECIPIENT }));

    expect(selectAuditRows()[0]?.reason_code).toBe('worker_to_user');
    expect(captured.notifications[0]?.reasonCode).toBe('worker_to_user');
  });

  test('non-participant source is dropped as unknown_source', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: 'ghost', destination: 'coder' }));

    expect(selectAuditRows()[0]?.reason_code).toBe('unknown_source');
    expect(captured.notifications[0]?.reasonCode).toBe('unknown_source');
  });

  // Register B16. Unlike the three above, this drop is reached AFTER the
  // event has been persisted and the hop counted — and after `handleBusSend`
  // told the sending agent "delivered". It used to be a bare `console.warn`,
  // so the message vanished with no audit row and no operator notification
  // while the session's hop count had silently moved.
  test('a chain participant addressing a name nobody has drops as unknown_destination', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: 'ghost' }));

    expect(selectAuditRows()[0]?.reason_code).toBe('unknown_destination');
    expect(captured.notifications[0]?.reasonCode).toBe('unknown_destination');
    expect(captured.drops[0]?.reasonCode).toBe('unknown_destination');
  });

  test('a legitimate hop between two chain participants still does NOT drop', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: 'reviewer' }));

    expect(selectAuditRows()).toEqual([]);
    expect(captured.notifications).toHaveLength(0);
    expect(captured.drops).toHaveLength(0);
  });
});

// Register B08. `_sink` was the one destination class `handleEvent` routed
// without asking who sent it — and reaching it publishes the sender's text as
// the iteration's `final.md` and tears the session down as `completed`. A
// middle participant could therefore answer on the chain's behalf and skip
// every hop after it.
describe('[security][B08] only the last participant may end the chain', () => {
  const THREE = ['first', 'middle', 'last'];

  test('a middle participant addressing _sink is dropped as unauthorized_sink', () => {
    const { router, captured, onEnded, paths } = makeRouter(THREE);
    router.handleEvent(ev({ source: 'middle', destination: SINK_RECIPIENT, text: 'my answer' }));

    expect(selectAuditRows()[0]).toEqual({
      kind: 'router.drop',
      reason_code: 'unauthorized_sink',
    });
    expect(captured.notifications[0]).toMatchObject({
      class: 'safety',
      severity: 'danger',
      reasonCode: 'unauthorized_sink',
    });
    expect(captured.drops[0]?.reasonCode).toBe('unauthorized_sink');

    // The three consequences the drop has to prevent, asserted separately:
    // the run was not answered, was not ended, and the DB agrees.
    expect(fs.existsSync(path.join(paths.iterationDir('iter-1'), 'final.md'))).toBe(false);
    expect(onEnded).not.toHaveBeenCalled();
    expect(getMultiAgentSession(SESSION_ID)!.status).toBe('running');
  });

  test('CONTROL: the last participant still ends the chain', () => {
    const { router, captured, onEnded, paths } = makeRouter(THREE);
    router.handleEvent(ev({ source: 'last', destination: SINK_RECIPIENT, text: 'the answer' }));

    expect(selectAuditRows()).toEqual([]);
    expect(captured.drops).toHaveLength(0);
    expect(fs.readFileSync(path.join(paths.iterationDir('iter-1'), 'final.md'), 'utf8')).toBe(
      'the answer',
    );
    expect(onEnded).toHaveBeenCalledWith(SESSION_ID, 'completed', 'iter-1');
  });

  test('CONTROL: the FIRST participant may not either — the rule is position, not seniority', () => {
    const { router, captured, onEnded } = makeRouter(THREE);
    router.handleEvent(ev({ source: 'first', destination: SINK_RECIPIENT }));

    expect(captured.drops[0]?.reasonCode).toBe('unauthorized_sink');
    expect(onEnded).not.toHaveBeenCalled();
  });
});

// Register B24. Nothing rejected `source === destination`, so `deliver` woke
// the sender again with its own text — a loop bounded only by the hop budget.
describe('[security][B24] an agent may not address itself', () => {
  test('a self-addressed event is dropped as self_addressed', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: 'coder' }));

    expect(selectAuditRows()[0]?.reason_code).toBe('self_addressed');
    expect(captured.notifications[0]?.reasonCode).toBe('self_addressed');
    expect(captured.drops[0]?.reasonCode).toBe('self_addressed');
  });

  test('the drop lands BEFORE the persist, so it costs no hop', () => {
    // The harm B24 names is budget burn. A drop that still counted the hop
    // would leave the loop just as expensive, only quieter — so this, not
    // the reason code, is what makes the fix address the finding.
    const { router } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: 'coder' }));

    expect(listMultiAgentEvents(SESSION_ID)).toHaveLength(0);
  });

  test('CONTROL: the same agent addressing its real next hop is not dropped', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: 'reviewer' }));

    expect(captured.drops).toHaveLength(0);
    expect(listMultiAgentEvents(SESSION_ID)).toHaveLength(1);
  });
});
