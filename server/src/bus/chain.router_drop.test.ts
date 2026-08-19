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
  getPendingRetry,
  listMultiAgentEvents,
  setPendingRetry,
} from '../repo/multi_agent.js';
import type { BusEvent } from './runner.js';
import type {
  NotificationEnvelope,
  PendingRetryDescriptor,
  RouterDropReasonCode,
} from '@cebab/shared/protocol';
import { _resetCoalesceState } from '../notifications/dispatcher.js';

// Cluster A Phase 3 (D4 / BE-9): chain-mode mirror of the orchestrator
// router-drop coverage. Chain has six drop sites in `handleEvent`, all named
// by their `RouterDropReasonCode` below — locate them by reason code, not by
// line number.

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
  retries: Array<PendingRetryDescriptor | null>;
};

function makeRouter(agentNames: string[] = AGENTS): {
  router: ReturnType<typeof createChainRouter>;
  captured: Captured;
  onEnded: ReturnType<typeof vi.fn>;
  deliver: ReturnType<typeof vi.fn>;
  paths: ReturnType<typeof computeSessionPaths>;
} {
  const workspace = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const paths = computeSessionPaths(SESSION_ID);
  fs.mkdirSync(paths.iterationDir('iter-1'), { recursive: true });
  const captured: Captured = { notifications: [], drops: [], retries: [] };
  const onEnded = vi.fn();
  const deliver = vi.fn();
  const router = createChainRouter({
    sessionId: SESSION_ID,
    iterationId: 'iter-1',
    agentNames,
    paths,
    onEvent: vi.fn(),
    onEnded,
    deliver,
    hopBudget: 1000,
    sendNotification: (env) => {
      captured.notifications.push(env);
    },
    sendRouterDrop: (drop) => {
      captured.drops.push({ reasonCode: drop.reasonCode });
    },
    onPendingRetry: (_sid, descriptor) => {
      captured.retries.push(descriptor);
    },
  });
  return { router, captured, onEnded, deliver, paths };
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

// Cebab-wsq. Every drop above returns without reaching `deliver`, which is
// the chain's ONLY wake — so after one the run has no pending turn, and the
// operator's sole move was Stop (chain mode refuses mid-flight user prompts;
// see the `multi_agent_user_prompt` handler in `ws/server.ts`). The drop now
// parks the session in its pending-retry slot instead, which already carries
// Retry + Abandon in the UI and survives a detach and a server restart.
//
// The park is deliberately deferred to `onTurnSucceeded`: `bus_send` runs
// inside the sender's turn, so a slot written at drop time would be wiped by
// that same turn resolving. Each case below therefore ends the sender's turn
// explicitly — that is production's ordering, not a test convenience.
describe('[Cebab-wsq] a dropped chain event parks the run instead of wedging it', () => {
  const THREE = ['first', 'middle', 'last'];

  /** The slot as persisted, plus what the operator's banner was handed. */
  function parked(captured: Captured) {
    return { row: getPendingRetry(SESSION_ID), emitted: captured.retries };
  }

  test('forged_source parks the run', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: CEBAB_SOURCE, destination: 'reviewer' }));
    router.onTurnSucceeded('coder');

    const { row, emitted } = parked(captured);
    expect(row?.agentName).toBe('coder');
    expect(row?.reason).toContain('forged_source');
    expect(emitted).toHaveLength(1);
  });

  test('worker_to_user parks the run', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: USER_RECIPIENT }));
    router.onTurnSucceeded('coder');

    const { row, emitted } = parked(captured);
    expect(row?.agentName).toBe('coder');
    expect(row?.reason).toContain('worker_to_user');
    expect(emitted).toHaveLength(1);
  });

  test('unknown_source parks the run', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: 'ghost', destination: 'reviewer' }));
    // The forged name is NOT the agent to re-prompt — `ghost` has no turn and
    // no next hop. `coder`, whose turn actually ended, is.
    router.onTurnSucceeded('coder');

    const { row, emitted } = parked(captured);
    expect(row?.agentName).toBe('coder');
    expect(row?.reason).toContain('unknown_source');
    expect(emitted).toHaveLength(1);
  });

  test('self_addressed parks the run', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: 'coder' }));
    router.onTurnSucceeded('coder');

    const { row, emitted } = parked(captured);
    expect(row?.agentName).toBe('coder');
    expect(row?.reason).toContain('self_addressed');
    expect(emitted).toHaveLength(1);
  });

  test('unauthorized_sink parks the run', () => {
    const { router, captured } = makeRouter(THREE);
    router.handleEvent(ev({ source: 'middle', destination: SINK_RECIPIENT }));
    router.onTurnSucceeded('middle');

    const { row, emitted } = parked(captured);
    expect(row?.agentName).toBe('middle');
    expect(row?.reason).toContain('unauthorized_sink');
    expect(emitted).toHaveLength(1);
  });

  test('unknown_destination parks the run', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: 'nobody' }));
    router.onTurnSucceeded('coder');

    const { row, emitted } = parked(captured);
    expect(row?.agentName).toBe('coder');
    expect(row?.reason).toContain('unknown_destination');
    expect(emitted).toHaveLength(1);
  });

  test('CONTROL: a turn that ended with no drop parks nothing', () => {
    // Without this every assertion above proves only that *something* writes
    // a slot on every successful turn.
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: 'reviewer' }));
    router.onTurnSucceeded('coder');

    expect(getPendingRetry(SESSION_ID)).toBeNull();
    expect(captured.retries).toEqual([]);
  });

  test('the park SURVIVES the success-clears branch it runs beside', () => {
    // The decisive case. `onTurnSucceeded` exists to null the slot an agent
    // owns once it recovers, and a drop happens mid-turn — so parking before
    // that clear (or inside it) hands the sender's own success the slot to
    // erase, and the whole fix is inert with every other test above green.
    // Seeding a slot for the SAME agent is what makes the clear branch run.
    const { router } = makeRouter();
    setPendingRetry(SESSION_ID, {
      agentName: 'coder',
      prompt: 'stale bytes',
      reason: 'an earlier failure',
      ts: 1,
      errorEventId: 7,
    });
    router.handleEvent(ev({ source: 'coder', destination: 'nobody' }));
    router.onTurnSucceeded('coder');

    const row = getPendingRetry(SESSION_ID);
    expect(row?.reason).toContain('unknown_destination');
    expect(row?.prompt).not.toBe('stale bytes');
  });

  test('a drop followed by a legal send in the same turn parks nothing', () => {
    // The agent corrected itself before its turn ended, so somebody IS awake.
    const { router, captured, deliver } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: 'nobody' }));
    router.handleEvent(ev({ source: 'coder', destination: 'reviewer' }));
    router.onTurnSucceeded('coder');

    expect(deliver).toHaveBeenCalledWith('reviewer', 'x', 'coder');
    expect(getPendingRetry(SESSION_ID)).toBeNull();
    expect(captured.retries).toEqual([]);
  });

  test('a legal send followed by a drop in the same turn STILL parks', () => {
    // The mirror of the case above, and the reason the check is a counter
    // rather than "has this turn woken anyone". `reviewer` was woken by the
    // first send, but the second send is the one that vanished, and the run
    // is short exactly that message.
    const { router, deliver } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: 'reviewer' }));
    router.handleEvent(ev({ source: 'coder', destination: 'nobody' }));
    router.onTurnSucceeded('coder');

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(getPendingRetry(SESSION_ID)?.reason).toContain('unknown_destination');
  });

  test('a turn that FAILED after a drop keeps the failure reason, not the drop', () => {
    // `onWorkerFailed` writes its own slot and the turn never reaches
    // `onTurnSucceeded`; a note left behind would re-park over that reason on
    // some later agent's success.
    const { router } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: 'nobody' }));
    router.onWorkerFailed('coder', 'the bytes it was given', new Error('boom'));

    expect(getPendingRetry(SESSION_ID)?.reason).toContain('boom');

    router.onTurnSucceeded('reviewer');
    expect(getPendingRetry(SESSION_ID)?.reason).toContain('boom');
  });

  test('the retry prompt is a correction naming the sender + its real next hop', () => {
    // Not a replay of the sender's last prompt: re-running the identical turn
    // invites the identical mistake, and this router already knows the one
    // destination the briefing gave that agent.
    const { router } = makeRouter(THREE);
    router.handleEvent(ev({ source: 'middle', destination: SINK_RECIPIENT }));
    router.onTurnSucceeded('middle');

    const prompt = getPendingRetry(SESSION_ID)!.prompt;
    expect(prompt).toContain('`middle`');
    expect(prompt).toContain('`last`');
    expect(prompt).toContain('reached nobody');
  });

  test('the last participant is told to address _sink', () => {
    const { router } = makeRouter(THREE);
    router.handleEvent(ev({ source: 'last', destination: 'nobody' }));
    router.onTurnSucceeded('last');

    expect(getPendingRetry(SESSION_ID)!.prompt).toContain(`\`${SINK_RECIPIENT}\``);
  });

  test('parking explains itself in the trail without spending a hop', () => {
    // The synthetic row is persisted directly rather than through
    // `forwardCebabEvent`, the same treatment the budget-exhaust and
    // worker-failed events get: the operator sees why the run stopped, and
    // the hop ratio does not move for an event no agent sent.
    const { router } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: 'nobody' }));
    const before = listMultiAgentEvents(SESSION_ID).length;
    router.onTurnSucceeded('coder');

    const events = listMultiAgentEvents(SESSION_ID);
    expect(events).toHaveLength(before + 1);
    const explanation = events.at(-1)!;
    expect(explanation).toMatchObject({
      source: CEBAB_SOURCE,
      destination: USER_RECIPIENT,
      kind: 'error',
    });
    expect(explanation.text).toContain('cannot advance');
    expect(getPendingRetry(SESSION_ID)!.errorEventId).toBe(explanation.id);
  });

  test('the explanatory row costs no hop against the budget', () => {
    // The half above only proves a row was written. This proves WHICH writer
    // wrote it: `forwardCebabEvent` would have been the obvious choice and it
    // bumps the hop counter, so a park would quietly shorten every run it
    // touched. The counter is private, so the budget is the observable —
    // sized so the park is the difference between a third hop running and the
    // run being torn down as `stopped`.
    const workspace = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const paths = computeSessionPaths(SESSION_ID);
    fs.mkdirSync(paths.iterationDir('iter-1'), { recursive: true });
    const onEnded = vi.fn();
    const deliver = vi.fn();
    const router = createChainRouter({
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      agentNames: AGENTS,
      paths,
      onEvent: vi.fn(),
      onEnded,
      deliver,
      hopBudget: 3,
    });

    router.handleEvent(ev({ source: 'coder', destination: 'reviewer' })); // hop 1
    // `self_addressed` drops above the persist, so the drop itself is free —
    // any hop charged below this line came from the park.
    router.handleEvent(ev({ source: 'reviewer', destination: 'reviewer' }));
    router.onTurnSucceeded('reviewer');
    router.handleEvent(ev({ source: 'coder', destination: 'reviewer' })); // hop 2

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(onEnded).not.toHaveBeenCalled();
    expect(getMultiAgentSession(SESSION_ID)!.status).toBe('running');
  });

  test('parking does NOT emit a second notification for the same drop', () => {
    // `dispatchRouterDrop` has already told the operator; the park adds the
    // way back, not another alert.
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: 'nobody' }));
    const afterDrop = captured.notifications.length;
    router.onTurnSucceeded('coder');

    expect(captured.notifications).toHaveLength(afterDrop);
  });

  test('a park does not wake anyone by itself', () => {
    // The operator decides. Re-delivering here would be option (b) from the
    // bead — silently correcting an agent that ignored its briefing, which
    // hides the violation the drop exists to surface.
    const { router, deliver } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: 'nobody' }));
    router.onTurnSucceeded('coder');

    expect(deliver).not.toHaveBeenCalled();
    expect(getMultiAgentSession(SESSION_ID)!.status).toBe('running');
  });
});
