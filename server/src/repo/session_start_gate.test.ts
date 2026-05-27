import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { EnvInjection, ServerMsg } from '@cebab/shared/protocol';
import { closeDb, getDb } from '../db.js';
import { config } from '../config.js';
import { _resetOperatorIdCache } from '../notifications/operator.js';
import {
  ACKNOWLEDGMENT_TRIGGER,
  awaitEnvInjectionAck,
  makeStartGateState,
  recordEnvInjectionAcknowledgment,
} from './session_start_gate.js';
import * as safetyAudit from '../notifications/safety_audit.js';

// Cluster B Phase 5 (§4.5): env-injection start-gate tests.
//
// Coverage:
//   - Empty injection list → silent no-op (no envelope, no pending entry)
//   - Non-empty list → emits session_start_gated, parks a promise keyed by
//     pendingStartId; resolving the entry unblocks the awaiting caller
//   - The envelope echoes the full EnvInjection[] for the modal (no extra
//     fetch needed); detectedInjections matches input
//   - recordEnvInjectionAcknowledgment writes a single safety_audit row
//     with kind='session.start_gated_override' + reasonCode='env_injection_acknowledged'
//   - reasonText flows into the audit payload when provided
//   - [security] BE-1: appendSafetyAudit throwing surfaces the error
//     (caller must wrapper_error and leave the gate parked)
//
// Note: the handler-level "stays parked on bad input" behavior is exercised
// in the server-side integration tests; the unit tests here cover the
// module surface (gate API + persistence helper) in isolation.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-start-gate-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  _resetOperatorIdCache();
  getDb(); // apply migrations 001..016
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  config.dataDir = originalDataDir;
  _resetOperatorIdCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---- helpers ----

function makeSink(): { sent: ServerMsg[]; send: (m: ServerMsg) => void } {
  const sent: ServerMsg[] = [];
  return { sent, send: (m: ServerMsg) => sent.push(m) };
}

function injection(envKey: string): EnvInjection {
  return {
    envKey,
    scope: 'project',
    scopePath: '/u/proj/.claude/settings.json',
    posture: 'subscription auth bypass',
    isSet: true,
  };
}

// ---- silent no-op ----

describe('awaitEnvInjectionAck — silent no-op cases', () => {
  test('empty injections list emits nothing and resolves immediately', async () => {
    const sink = makeSink();
    const gate = makeStartGateState();
    await awaitEnvInjectionAck({
      projectId: 1,
      gate,
      send: sink.send,
      injections: [],
    });
    expect(sink.sent).toEqual([]);
    expect(gate.pending.size).toBe(0);
  });
});

// ---- pending path: emit + park + resolve ----

describe('awaitEnvInjectionAck — pending + acknowledge', () => {
  test('non-empty injections emits a single session_start_gated and parks', async () => {
    const sink = makeSink();
    const gate = makeStartGateState();
    const injections = [injection('ANTHROPIC_API_KEY')];

    const gatePromise = awaitEnvInjectionAck({
      projectId: 42,
      gate,
      send: sink.send,
      injections,
    });

    // Envelope ships synchronously.
    expect(sink.sent).toHaveLength(1);
    const env = sink.sent[0] as Extract<ServerMsg, { type: 'session_start_gated' }>;
    expect(env.type).toBe('session_start_gated');
    expect(env.projectId).toBe(42);
    expect(env.reason).toBe('env_injection_detected');
    expect(env.detectedInjections).toEqual(injections);

    // Promise is parked — only resolves after entry.resolve.
    expect(gate.pending.size).toBe(1);
    const entry = gate.pending.get(env.pendingStartId);
    expect(entry).toBeDefined();
    expect(entry!.projectId).toBe(42);
    expect(entry!.injections).toEqual(injections);

    // Resolve and await — promise completes.
    entry!.resolve();
    await gatePromise;
  });

  test('multiple injections all flow into the envelope and the pending entry', async () => {
    const sink = makeSink();
    const gate = makeStartGateState();
    const injections = [
      injection('ANTHROPIC_API_KEY'),
      injection('ANTHROPIC_AUTH_TOKEN'),
      injection('CLAUDE_CODE_USE_BEDROCK'),
    ];
    const gatePromise = awaitEnvInjectionAck({
      projectId: 7,
      gate,
      send: sink.send,
      injections,
    });
    const env = sink.sent[0] as Extract<ServerMsg, { type: 'session_start_gated' }>;
    expect(env.detectedInjections).toHaveLength(3);
    expect(env.detectedInjections.map((i) => i.envKey)).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
    ]);
    gate.pending.get(env.pendingStartId)!.resolve();
    await gatePromise;
  });

  test('two concurrent gate calls produce distinct pendingStartIds', async () => {
    const sink = makeSink();
    const gate = makeStartGateState();
    const p1 = awaitEnvInjectionAck({
      projectId: 1,
      gate,
      send: sink.send,
      injections: [injection('ANTHROPIC_API_KEY')],
    });
    const p2 = awaitEnvInjectionAck({
      projectId: 2,
      gate,
      send: sink.send,
      injections: [injection('ANTHROPIC_API_KEY')],
    });
    expect(sink.sent).toHaveLength(2);
    expect(gate.pending.size).toBe(2);
    const env1 = sink.sent[0] as Extract<ServerMsg, { type: 'session_start_gated' }>;
    const env2 = sink.sent[1] as Extract<ServerMsg, { type: 'session_start_gated' }>;
    expect(env1.pendingStartId).not.toBe(env2.pendingStartId);
    gate.pending.get(env1.pendingStartId)!.resolve();
    gate.pending.get(env2.pendingStartId)!.resolve();
    await Promise.all([p1, p2]);
  });
});

// ---- ACKNOWLEDGMENT_TRIGGER ----

describe('ACKNOWLEDGMENT_TRIGGER constant', () => {
  test('is the literal string "inject" (case-sensitive contract)', () => {
    // The handler does `msg.typedAcknowledgment !== ACKNOWLEDGMENT_TRIGGER`
    // — anything else (including 'Inject', 'INJECT', etc) gets wrapper_error.
    expect(ACKNOWLEDGMENT_TRIGGER).toBe('inject');
  });
});

// ---- recordEnvInjectionAcknowledgment ----

describe('recordEnvInjectionAcknowledgment — audit dual-write', () => {
  test('writes a safety_audit row with kind + reasonCode + payload', () => {
    recordEnvInjectionAcknowledgment({
      projectId: 42,
      injections: [injection('ANTHROPIC_API_KEY')],
    });
    const rows = getDb()
      .prepare(`SELECT kind, reason_code, payload_json FROM safety_audit WHERE kind = ?`)
      .all('session.start_gated_override') as Array<{
      kind: string;
      reason_code: string;
      payload_json: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason_code).toBe('env_injection_acknowledged');
    const payload = JSON.parse(rows[0]!.payload_json);
    expect(payload.projectId).toBe(42);
    expect(payload.injections).toHaveLength(1);
    expect(payload.injections[0].envKey).toBe('ANTHROPIC_API_KEY');
    // BE-B12 [security]: payload carries the EnvInjection view (keys +
    // posture + isSet), NEVER values. This isn't strictly a unit-test
    // concern, but the shape is the invariant.
    expect(payload.injections[0]).not.toHaveProperty('value');
    expect(payload.reasonText).toBeUndefined();
  });

  test('reasonText is captured into the payload when provided', () => {
    recordEnvInjectionAcknowledgment({
      projectId: 1,
      injections: [injection('ANTHROPIC_API_KEY')],
      reasonText: 'CI deploy, expected',
    });
    const rows = getDb()
      .prepare(`SELECT payload_json FROM safety_audit WHERE kind = ?`)
      .all('session.start_gated_override') as Array<{ payload_json: string }>;
    const payload = JSON.parse(rows[0]!.payload_json);
    expect(payload.reasonText).toBe('CI deploy, expected');
  });
});

// ---- BE-1: audit throwing ----

describe('recordEnvInjectionAcknowledgment — [security] BE-1', () => {
  test(
    'audit append throwing propagates (caller wrapper_errors + leaves gate parked)',
    { tag: 'security' } as never,
    () => {
      vi.spyOn(safetyAudit, 'appendSafetyAudit').mockImplementation(() => {
        throw new Error('chain broken');
      });
      expect(() =>
        recordEnvInjectionAcknowledgment({
          projectId: 1,
          injections: [injection('ANTHROPIC_API_KEY')],
        }),
      ).toThrow('chain broken');
      // The contract: this function THROWS on audit failure so the WS
      // handler can wrapper_error AND skip the entry.resolve() call,
      // keeping the spawn parked. No spawn proceeds past a broken chain.
    },
  );
});
