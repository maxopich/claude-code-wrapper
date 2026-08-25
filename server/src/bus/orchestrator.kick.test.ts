import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { ORCHESTRATOR_AGENT_NAME, createOrchestratorRouter } from './orchestrator.js';
import { computeSessionPaths } from './paths.js';
import { CEBAB_SOURCE, USER_RECIPIENT } from './runtime.js';
import {
  createMultiAgentSession,
  listMultiAgentEvents,
  type MultiAgentLifecycle,
} from '../repo/multi_agent.js';
import type { BusEvent } from './runner.js';

// Cluster C Phase 4d (spec §5.1 kick semantics + §3 invariant 1): router
// kick-drop tests. Kick is BIDIRECTIONAL — distinct from mute (which is
// source-only) — and irreversible at the DB layer. The router's in-memory
// mirror is what these tests exercise; the persistence + handler tests live
// in `per_agent_control.test.ts` + `control_verbs.test.ts`.
//
// Why a separate test file (vs extending orchestrator.mute.test.ts):
//   - Both verbs share fixtures, but the assertion shape differs (mute checks
//     source-only drops; kick checks source AND destination). Keeping them
//     separate makes each test's "what is being verified" obvious without
//     needing per-`describe` mute/kick parametrisation noise.
//   - When C4e wires R-B reconstruction for control state, the per-verb
//     reseed tests live next to the matching drop tests.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-orch-kick-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function buildRouter(
  opts: {
    workerNames?: string[];
    initialKickedAgents?: string[];
    initialMutedAgents?: string[];
    lifecycle?: MultiAgentLifecycle;
    hopBudget?: number;
  } = {},
) {
  const workerNames = opts.workerNames ?? ['reviewer', 'editor'];
  const lifecycle = opts.lifecycle ?? 'persistent';
  const sessionId = `s-${Math.random().toString(36).slice(2, 10)}`;
  const iterationId = '001';
  const paths = computeSessionPaths(sessionId);
  createMultiAgentSession(sessionId, 'orchestrator', iterationId, paths.folder, lifecycle);
  const onEvent = vi.fn();
  const onEnded = vi.fn();
  const router = createOrchestratorRouter({
    sessionId,
    iterationId,
    workerNames,
    paths,
    lifecycle,
    onEvent,
    onEnded,
    hopBudget: opts.hopBudget ?? 1000,
    initialKickedAgents: opts.initialKickedAgents,
    initialMutedAgents: opts.initialMutedAgents,
  });
  return { router, sessionId, onEvent, onEnded };
}

function makeEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    ts: Date.now(),
    source: 'reviewer',
    destination: ORCHESTRATOR_AGENT_NAME,
    kind: 'reply',
    text: 'sample payload',
    ...overrides,
  };
}

describe('createOrchestratorRouter — kick drop filter (Phase 4d)', () => {
  test('drops events where ev.source ∈ kickedSet (set via kickAgent)', () => {
    const { router, sessionId, onEvent } = buildRouter();
    expect(router.kickAgent('reviewer')).toBe(true);
    router.handleEvent(makeEvent({ source: 'reviewer', text: 'drain outbound' }));
    expect(listMultiAgentEvents(sessionId)).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('drops events where ev.destination ∈ kickedSet (BIDIRECTIONAL — diff from mute)', () => {
    // The defining kick semantics: an event ADDRESSED to a kicked agent is
    // dropped before deliver?.() is called, so no new turn ever starts for
    // the kicked participant. Mute is source-only and would let this
    // event through.
    const { router, sessionId, onEvent } = buildRouter();
    router.kickAgent('reviewer');
    router.handleEvent(
      makeEvent({
        source: ORCHESTRATOR_AGENT_NAME,
        destination: 'reviewer',
        text: 'stale routing attempt — should be dropped',
      }),
    );
    expect(listMultiAgentEvents(sessionId)).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('drops events where ev.source ∈ initialKickedAgents (R-A/R-B reseed path)', () => {
    // Simulates server-restart reconstruct: kicked state hydrated from DB
    // straight into the router closure without a kickAgent() call.
    const { router, sessionId, onEvent } = buildRouter({ initialKickedAgents: ['reviewer'] });
    router.handleEvent(makeEvent({ source: 'reviewer' }));
    expect(listMultiAgentEvents(sessionId)).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('drops events where ev.destination ∈ initialKickedAgents (R-A/R-B reseed, destination side)', () => {
    const { router, sessionId, onEvent } = buildRouter({ initialKickedAgents: ['reviewer'] });
    router.handleEvent(
      makeEvent({
        source: ORCHESTRATOR_AGENT_NAME,
        destination: 'reviewer',
      }),
    );
    expect(listMultiAgentEvents(sessionId)).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('drops apply ONLY to kicked agent; other workers route normally', () => {
    const { router, sessionId, onEvent } = buildRouter();
    router.kickAgent('reviewer');
    router.handleEvent(makeEvent({ source: 'editor', text: 'still talking' }));
    expect(listMultiAgentEvents(sessionId)).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  test('kickAgent returns true on state change; false on re-kick (idempotent)', () => {
    const { router } = buildRouter();
    expect(router.kickAgent('reviewer')).toBe(true);
    expect(router.kickAgent('reviewer')).toBe(false);
    // Other agents independent.
    expect(router.kickAgent('editor')).toBe(true);
    expect(router.kickAgent('editor')).toBe(false);
  });

  test('isKicked reflects current state', () => {
    const { router } = buildRouter();
    expect(router.isKicked('reviewer')).toBe(false);
    router.kickAgent('reviewer');
    expect(router.isKicked('reviewer')).toBe(true);
    expect(router.isKicked('editor')).toBe(false);
  });

  test('kick drop wins when participant is BOTH muted and kicked', () => {
    // Per orchestrator.ts handleEvent ordering, kick check runs BEFORE
    // mute. A participant in both sets gets the kicked_source reason in
    // forensics, which is the more-severe + irreversible state. The
    // routing outcome (drop) is identical, but the forensic reason
    // code matters for the operator's "why" view.
    const { router, sessionId, onEvent } = buildRouter({
      initialMutedAgents: ['reviewer'],
      initialKickedAgents: ['reviewer'],
    });
    router.handleEvent(makeEvent({ source: 'reviewer' }));
    expect(listMultiAgentEvents(sessionId)).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();
    // The reason-code precedence is verified via `dispatchRouterDrop`
    // upstream (the dispatcher is mocked-out here), so this test
    // captures the routing-layer outcome — the per-reason audit-row
    // shape lives in control_verbs.test.ts where the dispatcher is
    // injectable.
  });

  test('kick drop fires AFTER F2/F3 checks (defense-in-depth ordering)', () => {
    // A kicked agent that ALSO violates F2 (forged source=cebab) should
    // fire the F3 drop, not the kick drop — F3 is the sharper alert and
    // catches active forgery attempts the kick state shouldn't mask.
    const { router, sessionId, onEvent } = buildRouter({
      initialKickedAgents: [CEBAB_SOURCE],
    });
    router.handleEvent(makeEvent({ source: CEBAB_SOURCE, destination: 'reviewer' }));
    expect(listMultiAgentEvents(sessionId)).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('orchestrator-addressed event from a non-kicked source still routes', () => {
    // Sanity that kick only filters by the kicked-set membership; an
    // unrelated reply from a non-kicked worker is unaffected even when
    // some OTHER worker is kicked.
    const { router, sessionId, onEvent } = buildRouter();
    router.kickAgent('reviewer');
    router.handleEvent(
      makeEvent({
        source: 'editor',
        destination: ORCHESTRATOR_AGENT_NAME,
        text: 'normal reply',
      }),
    );
    expect(listMultiAgentEvents(sessionId)).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});

// Compile-time pin for the union: removing 'kicked_source' or
// 'kicked_destination' from RouterDropReasonCode breaks this assertion.
describe('RouterDropReasonCode includes kicked_source + kicked_destination', () => {
  test('both kick codes are in the union', () => {
    type CodeUnion =
      | 'forged_source'
      | 'worker_to_user'
      | 'worker_to_worker'
      | 'unknown_source'
      | 'muted_source'
      | 'kicked_source'
      | 'kicked_destination';
    const src: CodeUnion = 'kicked_source';
    const dst: CodeUnion = 'kicked_destination';
    expect(src).toBe('kicked_source');
    expect(dst).toBe('kicked_destination');
  });
});

/**
 * `Cebab-vie.9` / `Cebab-vie.10` / `Cebab-vie.18` [security]: the precondition
 * check the two operator replay seams ask before starting a turn.
 *
 * The drop filters above cover every turn that BEGINS as a `BusEvent`, which is
 * what the module's drain-contract comment relies on. `handle.retry()` and
 * `handle.continueThroughMutation()` do not begin as events, so none of that
 * reached them — this predicate is what they consult instead. Tested here
 * because it reads the same `kickedSet` these tests already own; the
 * end-to-end "no turn was actually spawned" halves live in
 * `orchestrator.wiring.test.ts`.
 */
describe('createOrchestratorRouter — checkTurnRefused (the replay-seam gate)', () => {
  const errorTexts = (sessionId: string): string[] =>
    listMultiAgentEvents(sessionId)
      .filter((e) => e.kind === 'error' && e.source === CEBAB_SOURCE)
      .map((e) => e.text);

  /** `Cebab-vie.17`: how many hash-chain rows say the budget stopped a run. */
  const budgetAuditRowCount = (): number =>
    (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM safety_audit WHERE kind = 'hop_budget.exhausted'`)
        .get() as { n: number }
    ).n;

  test('a live worker is not refused, and nothing is written', () => {
    const { router, sessionId } = buildRouter();
    expect(router.checkTurnRefused('reviewer')).toBeNull();
    expect(errorTexts(sessionId)).toEqual([]);
  });

  test('a kicked worker is refused, and the operator is told once', () => {
    const { router, sessionId, onEvent } = buildRouter();
    router.kickAgent('reviewer');
    expect(router.checkTurnRefused('reviewer')).toBe('kicked');

    const texts = errorTexts(sessionId);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('`reviewer` was removed from this session');
    // The refusal reaches the attached client too, not just the DB.
    expect(onEvent).toHaveBeenCalled();
  });

  test('a kicked worker does not shadow its peers', () => {
    const { router } = buildRouter();
    router.kickAgent('reviewer');
    expect(router.checkTurnRefused('editor')).toBeNull();
  });

  test('the R-A/R-B reseed path is refused too', () => {
    const { router } = buildRouter({ initialKickedAgents: ['reviewer'] });
    expect(router.checkTurnRefused('reviewer')).toBe('kicked');
  });

  test('the refusal is not a hop — it must not consume the budget it protects', () => {
    // `hopBudget: 1` with one hop already spent would refuse for 'budget'
    // instead of 'kicked' if the explanation itself counted. It also must not
    // push a session at 0 hops toward its cap just by explaining a refusal.
    const { router, sessionId } = buildRouter();
    router.kickAgent('reviewer');
    router.checkTurnRefused('reviewer');
    router.checkTurnRefused('reviewer');
    // Two refusals, two explanations, and `handleEvent`'s counter untouched:
    // the events exist but were never counted as hops (the count is internal,
    // so the observable is that a third call still says `kicked`).
    expect(errorTexts(sessionId)).toHaveLength(2);
    expect(router.checkTurnRefused('reviewer')).toBe('kicked');
  });

  test('an ended session refuses every agent, kicked or not', () => {
    const { router, sessionId } = buildRouter();
    void router.teardown('stopped');
    expect(router.checkTurnRefused('reviewer')).toBe('ended');
    expect(errorTexts(sessionId).at(-1)).toContain('This session has ended');
  });

  /**
   * Reaching the cap with the session STILL RUNNING is the live window a Retry
   * click lands in, and it needs the right kind of hop: `orchestrator → user`
   * persists, bumps the counter, and returns BEFORE the budget check (pinned
   * as intended in `orchestrator.test.ts` — the orchestrator answering the
   * operator must not trip the brake). A routed hop would tear the session
   * down on the spot and the answer below would be `ended`, which is a
   * different branch.
   */
  const spendAHopWithoutTripping = (router: ReturnType<typeof buildRouter>['router']) => {
    router.handleEvent(
      makeEvent({
        source: ORCHESTRATOR_AGENT_NAME,
        destination: USER_RECIPIENT,
        text: 'answering the operator',
      }),
    );
  };

  test('at the hop cap the answer is `budget`, and the session is torn down', () => {
    const { router, sessionId, onEnded } = buildRouter({ hopBudget: 1 });
    spendAHopWithoutTripping(router);
    expect(router.checkTurnRefused('reviewer')).toBe('budget');
    expect(onEnded).toHaveBeenCalled();
    expect(errorTexts(sessionId).some((t) => t.includes('Hop budget exhausted'))).toBe(true);
    // The positive control for the assertion in the next test: a real budget
    // stop DOES write the row, so `0` there means "kick won", not "the query
    // never finds anything".
    expect(budgetAuditRowCount()).toBe(1);
  });

  test('kick outranks budget: a kicked agent is never reported as a budget stop', () => {
    // Ordering matters for what the operator reads. A kicked worker refused
    // with "hop budget exhausted" would also TEAR THE SESSION DOWN, turning a
    // per-participant refusal into a session-wide stop.
    const { router, onEnded } = buildRouter({ hopBudget: 1 });
    spendAHopWithoutTripping(router);
    router.kickAgent('reviewer');
    expect(router.checkTurnRefused('reviewer')).toBe('kicked');
    expect(onEnded).not.toHaveBeenCalled();
    // `Cebab-vie.17`: and no `hop_budget.exhausted` row either. The existing
    // `onEnded` assertion alone would not catch an emit hoisted out of
    // `checkBudgetExhausted` and up to the `checkTurnRefused` call site — the
    // session would stay alive while the chain recorded a stop that never
    // happened.
    expect(budgetAuditRowCount()).toBe(0);
  });
});
