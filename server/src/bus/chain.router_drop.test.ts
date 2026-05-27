import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { createChainRouter } from './chain.js';
import { computeSessionPaths } from './paths.js';
import { CEBAB_SOURCE, USER_RECIPIENT } from './runtime.js';
import { createMultiAgentSession } from '../repo/multi_agent.js';
import type { BusEvent } from './runner.js';
import type {
  NotificationEnvelope,
  RouterDropReasonCode,
} from '@cebab/shared/protocol';
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

function makeRouter(): {
  router: ReturnType<typeof createChainRouter>;
  captured: Captured;
} {
  const workspace = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const paths = computeSessionPaths(SESSION_ID, workspace);
  const captured: Captured = { notifications: [], drops: [] };
  const router = createChainRouter({
    sessionId: SESSION_ID,
    iterationId: 'iter-1',
    agentNames: AGENTS,
    paths,
    onEvent: vi.fn(),
    onEnded: vi.fn(),
    hopBudget: 1000,
    sendNotification: (env) => {
      captured.notifications.push(env);
    },
    sendRouterDrop: (drop) => {
      captured.drops.push({ reasonCode: drop.reasonCode });
    },
  });
  return { router, captured };
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
});
