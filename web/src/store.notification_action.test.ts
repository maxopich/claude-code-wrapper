import { describe, expect, test } from 'vitest';
import { resolveNotificationActionEffect } from './store';
import type { NotificationAction } from '@cebab/shared/protocol';

/**
 * Cebab-ygu.30: every NotificationAction kind must resolve to a live effect.
 *
 * Before this, five of the eight kinds (open_session / open_logs /
 * open_settings / resume / restart_agent) fell into a bare `return` in
 * `App.tsx`'s `onNotificationAction` — the button dismissed the toast and did
 * nothing, worst on the error/danger tiers whose toasts never auto-dismiss.
 * `App.tsx` has no test harness, so the routing decision was extracted here to
 * be pinned. Reverting any of the five previously-inert cases (to a no-op / an
 * `undefined` effect) reddens the matching assertion below.
 */
describe('resolveNotificationActionEffect', () => {
  const SID = 'sess-abcdef01';

  test('archive → archive_session WS send', () => {
    expect(resolveNotificationActionEffect({ kind: 'archive', sessionId: SID })).toEqual({
      effect: 'ws_send',
      msg: { type: 'archive_session', sessionId: SID },
    });
  });

  test('reopen → reopen effect carrying the sessionId', () => {
    expect(resolveNotificationActionEffect({ kind: 'reopen', sessionId: SID })).toEqual({
      effect: 'reopen',
      sessionId: SID,
    });
  });

  test('reauth → reauth effect', () => {
    expect(resolveNotificationActionEffect({ kind: 'reauth' })).toEqual({ effect: 'reauth' });
  });

  // --- the five kinds that used to be inert ---

  test('open_settings → open_settings effect (claude_not_found toast)', () => {
    expect(resolveNotificationActionEffect({ kind: 'open_settings' })).toEqual({
      effect: 'open_settings',
    });
  });

  test('open_logs without an anchor → open_logs effect, no rowAnchor', () => {
    expect(resolveNotificationActionEffect({ kind: 'open_logs', sessionId: SID })).toEqual({
      effect: 'open_logs',
      sessionId: SID,
    });
  });

  test('open_logs with a rowAnchor → open_logs effect carrying the anchor', () => {
    expect(
      resolveNotificationActionEffect({
        kind: 'open_logs',
        sessionId: SID,
        rowAnchor: 'mutation:42',
      }),
    ).toEqual({ effect: 'open_logs', sessionId: SID, rowAnchor: 'mutation:42' });
  });

  test('resume → select_session (NOT resume_multi_agent, which fails post-restart)', () => {
    const e = resolveNotificationActionEffect({ kind: 'resume', sessionId: SID });
    expect(e).toEqual({ effect: 'select_session', sessionId: SID });
    // Guard the specific hazard: a reconstructed run is awaiting_continue, so
    // firing resume_multi_agent from the toast would be rejected.
    expect(e).not.toMatchObject({ effect: 'ws_send' });
  });

  test('restart_agent → select_session (bring the crashed turn into view)', () => {
    expect(
      resolveNotificationActionEffect({
        kind: 'restart_agent',
        sessionId: SID,
        agentName: 'scribe',
      }),
    ).toEqual({ effect: 'select_session', sessionId: SID });
  });

  test('open_session → select_session', () => {
    expect(resolveNotificationActionEffect({ kind: 'open_session', sessionId: SID })).toEqual({
      effect: 'select_session',
      sessionId: SID,
    });
  });

  // --- nothing is inert: every kind produces a defined, actionable effect ---

  test('every NotificationAction kind resolves to a defined effect', () => {
    const actions: NotificationAction[] = [
      { kind: 'archive', sessionId: SID },
      { kind: 'reopen', sessionId: SID },
      { kind: 'reauth' },
      { kind: 'open_settings' },
      { kind: 'open_logs', sessionId: SID },
      { kind: 'resume', sessionId: SID },
      { kind: 'restart_agent', sessionId: SID },
      { kind: 'open_session', sessionId: SID },
    ];
    for (const action of actions) {
      const e = resolveNotificationActionEffect(action);
      expect(e).toBeDefined();
      expect(typeof e.effect).toBe('string');
    }
  });
});
