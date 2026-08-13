import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { createOrchestratorRouter, ORCHESTRATOR_AGENT_NAME } from './orchestrator.js';
import { computeSessionPaths } from './paths.js';
import { CEBAB_SOURCE, SINK_RECIPIENT, USER_RECIPIENT } from './runtime.js';
import { createMultiAgentSession, listMultiAgentEvents } from '../repo/multi_agent.js';
import type { BusEvent } from './runner.js';
import type { NotificationEnvelope, RouterDropReasonCode } from '@cebab/shared/protocol';
import { _resetCoalesceState } from '../notifications/dispatcher.js';

// Cluster A Phase 3 (D4 / BE-9): every F2/F3 router-drop site in the
// orchestrator MUST write a `safety_audit` row + emit a typed notification
// envelope. These tests cover the 4 canonical drop sites
// (handleEvent lines 429/437/442/447). Safety class invariants under test:
//
//   BE-1: dispatcher.emit writes the audit row BEFORE the WS envelope ships
//         (here: the test asserts both happen for every drop).
//   BE-2: safety is NEVER coalesced at the recording layer — 200 drops with
//         the same reason+session produce 200 audit rows (one test below).
//   BE-9 [security]: each of the 4 reason codes is enumerated, not stringly
//         typed; sendNotification + sendRouterDrop both fire; the audit row
//         carries the right `reason_code` for forensic filtering.

const SESSION_ID = 'orch-drop-session';
const WORKERS = ['coder', 'reviewer'];
const TS = 1_700_000_000_000;

let tmpRoot: string;
let originalDataDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-router-drop-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  createMultiAgentSession(SESSION_ID, 'orchestrator', 'iter-1');
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
  drops: Array<{ reasonCode: RouterDropReasonCode; source: string; destination: string }>;
};

function makeRouter(): {
  router: ReturnType<typeof createOrchestratorRouter>;
  captured: Captured;
} {
  const workspace = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const paths = computeSessionPaths(SESSION_ID, workspace);
  const captured: Captured = { notifications: [], drops: [] };
  const router = createOrchestratorRouter({
    sessionId: SESSION_ID,
    iterationId: 'iter-1',
    workerNames: WORKERS,
    paths,
    lifecycle: 'persistent',
    onEvent: vi.fn(),
    onEnded: vi.fn(),
    hopBudget: 1000,
    sendNotification: (env) => {
      captured.notifications.push(env);
    },
    sendRouterDrop: (drop) => {
      captured.drops.push({
        reasonCode: drop.reasonCode,
        source: drop.source,
        destination: drop.destination,
      });
    },
  });
  return { router, captured };
}

function ev(partial: Partial<BusEvent>): BusEvent {
  return {
    ts: TS,
    source: 'coder',
    destination: 'reviewer',
    kind: 'prompt',
    text: 'x',
    ...partial,
  };
}

function selectAuditRows(): Array<{ kind: string; reason_code: string; session_id: string }> {
  // Filter out the migration 015 chain-reset marker row so tests stay
  // focused on Phase 3 router-drop rows.
  return getDb()
    .prepare(
      `SELECT kind, reason_code, session_id FROM safety_audit
       WHERE kind != 'audit.chain_reset' ORDER BY ts ASC, id ASC`,
    )
    .all() as Array<{ kind: string; reason_code: string; session_id: string }>;
}

describe('[security][BE-9] orchestrator router-drop → safety_audit + envelope', () => {
  test('forged source=cebab writes audit row + emits danger notification', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: CEBAB_SOURCE, destination: 'coder' }));

    const rows = selectAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      kind: 'router.drop',
      reason_code: 'forged_source',
      session_id: SESSION_ID,
    });
    expect(captured.notifications).toHaveLength(1);
    expect(captured.notifications[0]).toMatchObject({
      type: 'notification',
      class: 'safety',
      severity: 'danger',
      reasonCode: 'forged_source',
      sessionId: SESSION_ID,
      sticky: true,
    });
    expect(captured.drops).toEqual([
      { reasonCode: 'forged_source', source: CEBAB_SOURCE, destination: 'coder' },
    ]);
  });

  test('worker → user is dropped as worker_to_user', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(
      ev({ source: 'coder', destination: USER_RECIPIENT, kind: 'final', text: 'spoofed' }),
    );

    expect(selectAuditRows()[0]).toMatchObject({ reason_code: 'worker_to_user' });
    expect(captured.notifications[0]).toMatchObject({ reasonCode: 'worker_to_user' });
    expect(captured.drops[0]?.reasonCode).toBe('worker_to_user');
  });

  test('worker → worker is dropped as worker_to_worker', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: 'reviewer' }));

    expect(selectAuditRows()[0]).toMatchObject({ reason_code: 'worker_to_worker' });
    expect(captured.notifications[0]).toMatchObject({ reasonCode: 'worker_to_worker' });
    expect(captured.drops[0]?.reasonCode).toBe('worker_to_worker');
  });

  test('non-participant source is dropped as unknown_source', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: 'ghost', destination: 'coder' }));

    expect(selectAuditRows()[0]).toMatchObject({ reason_code: 'unknown_source' });
    expect(captured.notifications[0]).toMatchObject({ reasonCode: 'unknown_source' });
    expect(captured.drops[0]?.reasonCode).toBe('unknown_source');
  });

  // Register B16. Note what makes this one different from the four above:
  // they all reject before the event is persisted. This one is reached
  // AFTER `sink.onEvent` has run and the hop has been counted, and after
  // `handleBusSend` already answered the sending agent "delivered" — so
  // before this it was a bare `console.warn` and the message was simply
  // gone, with no audit row and nothing for the operator to see.
  test('a real worker addressing a name nobody has drops as unknown_destination', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: ORCHESTRATOR_AGENT_NAME, destination: 'ghost' }));

    expect(selectAuditRows()[0]).toMatchObject({ reason_code: 'unknown_destination' });
    expect(captured.notifications[0]).toMatchObject({ reasonCode: 'unknown_destination' });
    expect(captured.drops[0]?.reasonCode).toBe('unknown_destination');
  });

  test('the drop envelope names who addressed whom, so the operator can find the typo', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: ORCHESTRATOR_AGENT_NAME, destination: 'revewer' }));

    expect(captured.drops[0]).toMatchObject({
      source: ORCHESTRATOR_AGENT_NAME,
      destination: 'revewer',
    });
  });

  // Register B24: this case used to be titled "orchestrator → orchestrator
  // (self-message) and orchestrator → worker do NOT drop" while its body only
  // ever sent orchestrator → worker. The half it named but never exercised is
  // the half that was wrong, and it now drops — see the B24 describe below.
  test('orchestrator → worker does NOT drop', () => {
    const { router, captured } = makeRouter();
    // orchestrator → worker is a legit deliver path; the F2/F3 filters let
    // it through. We assert no audit row + no notification, regardless of
    // whether downstream `deliver` is wired (it isn't in this minimal
    // router).
    router.handleEvent(
      ev({ source: ORCHESTRATOR_AGENT_NAME, destination: 'coder', kind: 'prompt' }),
    );
    expect(selectAuditRows()).toEqual([]);
    expect(captured.notifications).toHaveLength(0);
    expect(captured.drops).toHaveLength(0);
  });
});

// Register B08: `_sink` is the chain terminator and means nothing in
// hub-and-spoke mode, so nobody here may address it. The branch existed but
// was a bare `console.warn` — no audit row, no operator notification — the
// same shape B16 fixed for `unknown_destination`, left unmapped for want of a
// reason code.
describe('[security][B08] _sink has no meaning in orchestrator mode', () => {
  test('a worker addressing _sink drops as unauthorized_sink', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: SINK_RECIPIENT }));

    expect(selectAuditRows()[0]).toMatchObject({ reason_code: 'unauthorized_sink' });
    expect(captured.notifications[0]).toMatchObject({
      class: 'safety',
      reasonCode: 'unauthorized_sink',
    });
    expect(captured.drops[0]).toMatchObject({ source: 'coder', destination: SINK_RECIPIENT });
  });

  test('the orchestrator itself may not address _sink either', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: ORCHESTRATOR_AGENT_NAME, destination: SINK_RECIPIENT }));

    expect(captured.drops[0]?.reasonCode).toBe('unauthorized_sink');
  });

  test('CONTROL: the orchestrator addressing the USER is still how a run reports out', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: ORCHESTRATOR_AGENT_NAME, destination: USER_RECIPIENT }));

    expect(selectAuditRows()).toEqual([]);
    expect(captured.drops).toHaveLength(0);
  });
});

// Register B24. In this router the worker case is already covered by the
// `worker_to_worker` guard, so the live gap was orchestrator → orchestrator:
// it fell into the `destination === ORCHESTRATOR_AGENT_NAME` deliver branch
// and woke the orchestrator with its own text.
describe('[security][B24] an agent may not address itself', () => {
  test('orchestrator → orchestrator drops as self_addressed', () => {
    const { router, captured } = makeRouter();
    router.handleEvent(
      ev({ source: ORCHESTRATOR_AGENT_NAME, destination: ORCHESTRATOR_AGENT_NAME }),
    );

    expect(selectAuditRows()[0]?.reason_code).toBe('self_addressed');
    expect(captured.notifications[0]?.reasonCode).toBe('self_addressed');
    expect(captured.drops[0]?.reasonCode).toBe('self_addressed');
  });

  test('the drop lands BEFORE the persist, so it costs no hop', () => {
    const { router } = makeRouter();
    router.handleEvent(
      ev({ source: ORCHESTRATOR_AGENT_NAME, destination: ORCHESTRATOR_AGENT_NAME }),
    );

    expect(listMultiAgentEvents(SESSION_ID)).toHaveLength(0);
  });

  test('a worker addressing itself keeps reporting worker_to_worker, not self_addressed', () => {
    // Ordering is deliberate: the self-check sits AFTER the worker→worker
    // guard so no drop that was already classified changes its reason code.
    // A future author who moves it will redden here.
    const { router, captured } = makeRouter();
    router.handleEvent(ev({ source: 'coder', destination: 'coder' }));

    expect(captured.drops[0]?.reasonCode).toBe('worker_to_worker');
  });
});

describe('[security][BE-2] safety class is NEVER coalesced at the recording layer', () => {
  test('a burst of 50 identical-key drops produces 50 audit rows (UI may collapse for display)', () => {
    const { router, captured } = makeRouter();
    for (let i = 0; i < 50; i++) {
      router.handleEvent(ev({ source: CEBAB_SOURCE, destination: 'coder' }));
    }
    expect(selectAuditRows()).toHaveLength(50);
    // Envelopes are not coalesced at the recording layer either — each
    // emit ships its own envelope. The CLIENT may dedupe by dedupeKey
    // (UI-9 ×N badge), but the audit + wire layer never does.
    expect(captured.notifications).toHaveLength(50);
    // dedupeKey is the same across the burst (so the dock can fold them).
    const keys = new Set(captured.notifications.map((n) => n.dedupeKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(`router_drop:forged_source:${SESSION_ID}`);
  });
});
