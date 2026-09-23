import { afterEach, describe, expect, test } from 'vitest';

import {
  claimSessionStart,
  claimSessionReopen,
  isSessionStartInFlight,
  listLiveSessionIds,
  registerLiveSession,
  releaseSessionStart,
  unregisterLiveSession,
} from '../bus/session_registry.js';
import { describeLiveSessionConflict } from './server.js';

// Register B02 [security]. `start_multi_agent` guarded on `conn.multiAgent` —
// per CONNECTION. Two browser windows could each start a session and both stay
// live in this process; `attemptResumeMultiAgent` then swept the older row to
// `crashed` while its AgentRunner kept delivering turns. That left agents
// executing against a session the operator had been told was dead and could no
// longer stop from the UI.
//
// The single-active invariant only holds if it is process-wide. The companion
// half — the sweep tearing down a live orphan rather than lying about it — is
// pinned in `bus/resume.phase_4.test.ts`.

const SIDS = ['guard-a', 'guard-b'];

afterEach(() => {
  for (const id of SIDS) unregisterLiveSession(id);
});

function registerFakeLive(sessionId: string): void {
  registerLiveSession({
    sessionId,
    mode: 'orchestrator',
    handle: {
      sessionId,
      iterationId: 'iter-1',
      participantAgentNames: [],
      lifecycle: 'temp',
      sessionFolder: '',
      stop: async () => {},
      detach: () => {},
      retry: async () => {},
      continueThroughMutation: async () => {},
    },
    rebind: () => 1,
    sendServerMsg: () => {},
  });
}

describe('describeLiveSessionConflict — process-wide single-active guard [security]', () => {
  test('an empty registry permits a start', () => {
    expect(describeLiveSessionConflict()).toBeNull();
  });

  test('a session live on ANOTHER connection blocks the start', () => {
    registerFakeLive('guard-a');
    const msg = describeLiveSessionConflict();
    expect(msg).not.toBeNull();
    expect(msg).toContain('guard-a');
  });

  test('the refusal points at the other window, since that is where Stop lives', () => {
    // Without this hint the operator sees "already running" for a session
    // their current window is not showing, and has nothing to act on.
    registerFakeLive('guard-a');
    expect(describeLiveSessionConflict()).toContain('another browser window');
  });

  test('every live session is named', () => {
    registerFakeLive('guard-a');
    registerFakeLive('guard-b');
    const msg = describeLiveSessionConflict() ?? '';
    expect(msg).toContain('guard-a');
    expect(msg).toContain('guard-b');
  });

  test('starting is permitted again once the session tears down', () => {
    registerFakeLive('guard-a');
    expect(describeLiveSessionConflict()).not.toBeNull();
    // `unregisterLiveSession` is what both routers call on teardown.
    unregisterLiveSession('guard-a');
    expect(describeLiveSessionConflict()).toBeNull();
  });

  test('a stale `running` DB row does NOT block — only a live registry entry does', () => {
    // The distinction that keeps this guard from wedging Cebab: after a server
    // restart the registry is empty while `running` rows may persist in
    // SQLite. Those rows must stay startable-past, or a crashed process would
    // lock the operator out of ever starting another session.
    expect(describeLiveSessionConflict()).toBeNull();
  });
});

// Register B18 [security]. B02 above made the guard process-wide, but a
// session is only in the registry AFTER `gateProjectsForSpawn` resolves — and
// that gate parks until the operator answers a trust prompt. So the window
// between "checked" and "registered" is as long as a human takes to click, and
// two browser windows could both pass B02's check and both start.
describe('claimSessionStart — the gap between checking and registering [security]', () => {
  const A = 'claim-a';
  const B = 'claim-b';

  afterEach(() => {
    releaseSessionStart(A);
    releaseSessionStart(B);
  });

  test('a claimed start blocks another start', () => {
    expect(claimSessionStart(A)).toBe(true);
    expect(describeLiveSessionConflict()).not.toBeNull();
  });

  test('CONTROL: releasing the claim permits a start again', () => {
    claimSessionStart(A);
    releaseSessionStart(A);
    expect(describeLiveSessionConflict()).toBeNull();
  });

  test('the refusal reads differently from the live-session one', () => {
    // "Wait for it to finish starting" is different advice from "stop it
    // first", and there is no session id to name yet — so a shared message
    // would either lie or print an empty parenthesis.
    claimSessionStart(A);
    const starting = describeLiveSessionConflict() ?? '';
    releaseSessionStart(A);
    registerFakeLive('guard-a');
    const running = describeLiveSessionConflict() ?? '';

    expect(starting).toContain('being started');
    expect(starting).not.toContain('stop it first');
    expect(running).toContain('stop it first');
    expect(running).not.toContain('being started');
  });

  test('the claim is exclusive — a second connection cannot take it', () => {
    expect(claimSessionStart(A)).toBe(true);
    expect(claimSessionStart(B)).toBe(false);
  });

  test('re-claiming with the same token succeeds (idempotent, not a self-deadlock)', () => {
    expect(claimSessionStart(A)).toBe(true);
    expect(claimSessionStart(A)).toBe(true);
  });

  test('release is owner-scoped — a stale connection cannot free a newer claim', () => {
    // The window this closes: connection A claims, drops, and its late
    // cleanup runs after connection B has taken the slot. An unscoped release
    // would hand B's slot away while B is still starting.
    claimSessionStart(A);
    releaseSessionStart(B);
    expect(isSessionStartInFlight()).toBe(true);
    expect(claimSessionStart(B)).toBe(false);
  });

  test('release is idempotent', () => {
    claimSessionStart(A);
    releaseSessionStart(A);
    releaseSessionStart(A);
    expect(isSessionStartInFlight()).toBe(false);
  });

  test('a live session blocks a claim, so the two guards cannot disagree', () => {
    registerFakeLive('guard-a');
    expect(claimSessionStart(A)).toBe(false);
  });
});

// `Cebab-xm95` [security]. Reopen displaces a live incumbent, so a live
// session is its NORMAL precondition — the start path's `live.size` check would
// refuse the very case reopen exists for. `claimSessionReopen` therefore skips
// that check but shares the same `startClaims` set, so a reopen parked on its
// trust gate still blocks a concurrent start (which is what step 5's later
// `listLiveSessionIds()` read used to leave a hole for).
describe('claimSessionReopen — the reopen-scoped start claim [security]', () => {
  const R = 'reopen-r';
  const S = 'start-s';

  afterEach(() => {
    releaseSessionStart(R);
    releaseSessionStart(S);
  });

  test('empty registry, no claims → the reopen claim is granted', () => {
    expect(listLiveSessionIds()).toEqual([]);
    expect(claimSessionReopen(R)).toBe(true);
  });

  test('a live incumbent does NOT block the reopen claim, but DOES block a start', () => {
    // The pair that proves the two functions differ (anti-vacuity): a
    // `claimSessionReopen` that just delegated to `claimSessionStart` would
    // return false here and redden.
    registerFakeLive('guard-a');
    expect(claimSessionReopen(R)).toBe(true);
    expect(claimSessionStart(S)).toBe(false);
  });

  test('while a reopen claim is held on an EMPTY registry, a start is refused and a start is in flight', () => {
    // `listLiveSessionIds()` is `[]`, so the refusal below can ONLY come from
    // the claim the reopen holds — not from a live incumbent.
    expect(claimSessionReopen(R)).toBe(true);
    expect(listLiveSessionIds()).toEqual([]);
    expect(claimSessionStart(S)).toBe(false);
    expect(isSessionStartInFlight()).toBe(true);
  });

  test('while a start claim is held, a reopen claim is refused', () => {
    expect(claimSessionStart(S)).toBe(true);
    expect(claimSessionReopen(R)).toBe(false);
  });

  test('releasing the reopen claim frees the slot; a foreign-token release is a no-op', () => {
    expect(claimSessionReopen(R)).toBe(true);
    // A release with a token that does not hold the claim must not free it.
    releaseSessionStart(S);
    expect(isSessionStartInFlight()).toBe(true);
    releaseSessionStart(R);
    expect(isSessionStartInFlight()).toBe(false);
    expect(claimSessionStart(S)).toBe(true);
  });
});
