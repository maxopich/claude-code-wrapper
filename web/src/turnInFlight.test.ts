/**
 * Cebab-uyuh: the composer's submit gate must track the SERVER's guard, not the
 * optimistic status the UI paints at `result`.
 *
 * Measured live 2026-09-05 against a real server: a follow-up sent the instant
 * `result` arrived was refused for 549ms / 565ms / 545ms across three runs.
 * `runOneTurn`'s `finally` tears the SDK subprocess down before it clears
 * `conn.inFlight`, and `describeTurnInFlight` reads that map.
 *
 * The two halves below are both load-bearing. The unit cases pin the predicate;
 * the source case pins that `App.tsx` actually uses it — App.tsx has no test
 * file of its own, so without that a correct `turnInFlight` could sit unused
 * beside a restored `session?.status === 'running'` and every test would pass.
 */
import { describe, expect, test } from 'vitest';
import { sessionPhase, turnInFlight, type SessionView } from './store';

function sess(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    projectId: 1,
    status: 'running',
    messages: [],
    streamingText: '',
    runStartedAt: Date.now(),
    heldMessages: [],
    ...over,
  };
}

describe('turnInFlight', () => {
  test('a running turn holds the composer', () => {
    expect(turnInFlight('running', false)).toBe(true);
    expect(turnInFlight('running', true)).toBe(true);
  });

  test('THE TEARDOWN WINDOW: result landed, server has not released', () => {
    // This is the whole bug. `result` set status 'done'; `session_running(false)`
    // has not arrived, so `conn.inFlight` still holds the session and a
    // send_message would be refused.
    expect(turnInFlight('done', true)).toBe(true);
  });

  test('once the server releases, the composer opens', () => {
    expect(turnInFlight('done', false)).toBe(false);
    expect(turnInFlight('error', false)).toBe(false);
    expect(turnInFlight('idle', false)).toBe(false);
  });

  test('an absent session never holds it', () => {
    expect(turnInFlight(undefined, false)).toBe(false);
  });

  test('liveness alone holds it — a turn this tab did not start', () => {
    // `project_opened` seeds `liveSessions` from `runningSessionIds`, so a
    // session running in another window is live here with a non-running status.
    expect(turnInFlight('idle', true)).toBe(true);
  });
});

describe('turnInFlight and sessionPhase deliberately disagree', () => {
  test('during teardown the indicator says done while the composer stays held', () => {
    // Collapsing these two into one predicate is the tempting simplification,
    // and it breaks whichever one it is collapsed onto: reuse `sessionPhase`
    // for the composer and the gate is back to the bug; reuse `turnInFlight`
    // for the indicator and a thinking animation runs for half a second AFTER
    // the answer is complete.
    const s = sess({ status: 'done' });
    expect(sessionPhase(s, true)).toBe('done');
    expect(turnInFlight(s.status, true)).toBe(true);
  });
});

describe('App.tsx derives the composer gate from turnInFlight', () => {
  const SOURCES = Object.fromEntries(
    Object.entries(
      import.meta.glob(['./App.tsx'], {
        query: '?raw',
        import: 'default',
        eager: true,
      }) as Record<string, string>,
    ),
  );

  test('the source was actually loaded — this gate is not scanning nothing', () => {
    // Two empty lists agree: without this the cases below pass on a glob that
    // matched no file.
    expect(Object.keys(SOURCES)).toHaveLength(1);
    expect(Object.values(SOURCES)[0].length).toBeGreaterThan(10_000);
  });

  test('it calls turnInFlight', () => {
    expect(Object.values(SOURCES)[0]).toMatch(/\bturnInFlight\s*\(/);
  });

  test('and does NOT compute the composer flag from status alone', () => {
    // The exact line this bug shipped as. A `running` bound straight to the
    // status comparison is the regression; nothing else in App.tsx may
    // reintroduce it under that name.
    expect(Object.values(SOURCES)[0]).not.toMatch(
      /\brunning\s*=\s*session\?\.status\s*===\s*'running'/,
    );
  });
});
