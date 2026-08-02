import { afterEach, describe, expect, test } from 'vitest';

import { registerLiveSession, unregisterLiveSession } from '../bus/session_registry.js';
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
