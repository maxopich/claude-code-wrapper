import { describe, expect, test, vi } from 'vitest';
import type { NotificationEnvelope, ServerMsg } from '@cebab/shared/protocol';
import { notifyFromServerMsg } from './notifyFromServerMsg';

function recorder() {
  const pushed: NotificationEnvelope[] = [];
  return {
    pushed,
    push: (n: NotificationEnvelope) => {
      pushed.push(n);
    },
  };
}

describe('notifyFromServerMsg', () => {
  test('pass-through for typed `notification` envelope', () => {
    const r = recorder();
    const env = {
      type: 'notification' as const,
      id: 'srv-1',
      ts: 12345,
      severity: 'warn' as const,
      class: 'operational' as const,
      dedupeKey: 'rate_limit',
      title: 'Rate limited',
      sticky: true,
    };
    notifyFromServerMsg(env, r);
    expect(r.pushed).toHaveLength(1);
    expect(r.pushed[0]).toMatchObject({
      id: 'srv-1',
      title: 'Rate limited',
      severity: 'warn',
      sticky: true,
    });
  });

  test('UI-14: bare wrapper_error (no sessionId) becomes a global error toast', () => {
    const r = recorder();
    const mintId = vi.fn(() => 'mock-id');
    notifyFromServerMsg(
      { type: 'wrapper_error', kind: 'claude_not_found', message: 'claude_not_found' } as ServerMsg,
      { push: r.push, mintId, now: () => 999 },
    );
    expect(r.pushed).toHaveLength(1);
    expect(r.pushed[0]).toMatchObject({
      id: 'mock-id',
      ts: 999,
      severity: 'error',
      class: 'operational',
      dedupeKey: 'wrap:global',
      sticky: true,
      message: 'claude_not_found',
    });
  });

  test('session-scoped wrapper_error does NOT toast (rendered as session banner upstream)', () => {
    const r = recorder();
    notifyFromServerMsg(
      {
        type: 'wrapper_error',
        kind: 'claude_not_found',
        message: 'boom',
        sessionId: 'sess-1',
      } as ServerMsg,
      r,
    );
    expect(r.pushed).toHaveLength(0);
  });

  test('unrelated ServerMsg types are silently ignored', () => {
    const r = recorder();
    notifyFromServerMsg(
      { type: 'system_event', subtype: 'init', sessionId: 's' } as unknown as ServerMsg,
      r,
    );
    notifyFromServerMsg(
      { type: 'assistant_msg', sessionId: 's', text: 'hi' } as unknown as ServerMsg,
      r,
    );
    expect(r.pushed).toHaveLength(0);
  });
});

// Cluster I Phase C5 UI: bulk_session_op_result → single summary toast.
describe('notifyFromServerMsg — Cluster I C5 bulk_session_op_result', () => {
  function bulkResult(overrides: Record<string, unknown>): ServerMsg {
    return {
      type: 'bulk_session_op_result',
      op: 'archive',
      succeededSessionIds: [],
      failed: [],
      removedArtifacts: false,
      ...overrides,
    } as ServerMsg;
  }

  test('all-succeeded archive → success toast with count', () => {
    const r = recorder();
    notifyFromServerMsg(bulkResult({ op: 'archive', succeededSessionIds: ['a', 'b', 'c'] }), {
      push: r.push,
      mintId: () => 'm',
      now: () => 1,
    });
    expect(r.pushed).toHaveLength(1);
    expect(r.pushed[0]).toMatchObject({
      severity: 'success',
      dedupeKey: 'bulk_session_op:archive:ok',
      title: 'Archived 3 sessions',
    });
  });

  test('singular noun when exactly one succeeded', () => {
    const r = recorder();
    notifyFromServerMsg(bulkResult({ op: 'archive', succeededSessionIds: ['only'] }), {
      push: r.push,
    });
    expect(r.pushed[0]?.title).toBe('Archived 1 session');
  });

  test('delete success copy mentions the 7-day recovery window', () => {
    const r = recorder();
    notifyFromServerMsg(bulkResult({ op: 'delete', succeededSessionIds: ['x', 'y'] }), {
      push: r.push,
    });
    expect(r.pushed[0]).toMatchObject({ severity: 'success', title: 'Soft-deleted 2 sessions' });
    expect(r.pushed[0]?.message).toContain('7 days');
  });

  test('delete with removedArtifacts appends "· logs removed" to the title', () => {
    const r = recorder();
    notifyFromServerMsg(
      bulkResult({ op: 'delete', succeededSessionIds: ['x'], removedArtifacts: true }),
      { push: r.push },
    );
    expect(r.pushed[0]?.title).toBe('Soft-deleted 1 session · logs removed');
  });

  test('removedArtifacts is ignored for archive (never touches disk)', () => {
    const r = recorder();
    notifyFromServerMsg(
      bulkResult({ op: 'archive', succeededSessionIds: ['x'], removedArtifacts: true }),
      { push: r.push },
    );
    expect(r.pushed[0]?.title).toBe('Archived 1 session');
  });

  test('partial success → success toast noting the failures', () => {
    const r = recorder();
    notifyFromServerMsg(
      bulkResult({
        op: 'archive',
        succeededSessionIds: ['ok'],
        failed: [{ sessionId: 'busy', reason: 'running', message: 'busy' }],
      }),
      { push: r.push },
    );
    expect(r.pushed[0]).toMatchObject({ severity: 'success', title: 'Archived 1 session' });
    expect(r.pushed[0]?.message).toContain("couldn't be processed");
  });

  test('all-failed (running) → warn toast with a Stop/End hint', () => {
    const r = recorder();
    notifyFromServerMsg(
      bulkResult({
        op: 'delete',
        succeededSessionIds: [],
        failed: [
          { sessionId: 'r1', reason: 'running', message: 'busy' },
          { sessionId: 'r2', reason: 'running', message: 'busy' },
        ],
      }),
      { push: r.push },
    );
    expect(r.pushed).toHaveLength(1);
    expect(r.pushed[0]).toMatchObject({
      severity: 'warn',
      dedupeKey: 'bulk_session_op:delete:none',
      title: "Couldn't delete 2 sessions",
    });
    expect(r.pushed[0]?.message).toContain('still running');
  });

  test('all-failed with a non-running reason surfaces the first message', () => {
    const r = recorder();
    notifyFromServerMsg(
      bulkResult({
        op: 'archive',
        succeededSessionIds: [],
        failed: [{ sessionId: 'gone', reason: 'unknown', message: 'No such session.' }],
      }),
      { push: r.push },
    );
    expect(r.pushed[0]).toMatchObject({ severity: 'warn' });
    expect(r.pushed[0]?.message).toBe('No such session.');
  });

  test('empty result (nothing succeeded or failed) → no toast', () => {
    const r = recorder();
    notifyFromServerMsg(bulkResult({ succeededSessionIds: [], failed: [] }), { push: r.push });
    expect(r.pushed).toHaveLength(0);
  });
});

// Cluster D Phase 4c (UI-D6): banner ↔ toast dedup. When a rate-limit
// banner is mounted for a session, the dispatcher's parallel `notification`
// envelope (the toast) should be suppressed so the operator doesn't see
// the same event in two places.
describe('notifyFromServerMsg — Cluster D Phase 4c rate-limit dedup (UI-D6)', () => {
  function rateLimitEnvelope(sessionId: string, subCode: 'hit' | 'cleared') {
    return {
      type: 'notification' as const,
      id: `srv-${subCode}`,
      ts: 12345,
      severity: 'warn' as const,
      class: 'operational' as const,
      dedupeKey: `rate_limit:${subCode}:${sessionId}`,
      title: subCode === 'hit' ? 'Rate limit' : 'Rate limit cleared',
      message: subCode === 'hit' ? 'limited' : 'lifted',
      sessionId,
      reasonCode: subCode,
      sticky: false,
    };
  }

  test('predicate returns true for the session → toast is suppressed', () => {
    const r = recorder();
    const isBannerVisibleFor = vi.fn(() => true);
    notifyFromServerMsg(rateLimitEnvelope('sess-1', 'hit'), {
      push: r.push,
      isBannerVisibleFor,
    });
    expect(r.pushed).toHaveLength(0);
    expect(isBannerVisibleFor).toHaveBeenCalledWith('sess-1', 'rate_limit');
  });

  test('predicate returns false → toast goes through', () => {
    const r = recorder();
    const isBannerVisibleFor = vi.fn(() => false);
    notifyFromServerMsg(rateLimitEnvelope('sess-1', 'hit'), {
      push: r.push,
      isBannerVisibleFor,
    });
    expect(r.pushed).toHaveLength(1);
    expect(r.pushed[0]).toMatchObject({ dedupeKey: 'rate_limit:hit:sess-1' });
  });

  test('predicate is omitted → toast goes through (back-compat default)', () => {
    // Older callers (or tests) may not pass `isBannerVisibleFor`. In that
    // case the dedup path is silently bypassed.
    const r = recorder();
    notifyFromServerMsg(rateLimitEnvelope('sess-1', 'hit'), { push: r.push });
    expect(r.pushed).toHaveLength(1);
  });

  test('non-rate_limit envelopes never invoke the predicate', () => {
    const r = recorder();
    const isBannerVisibleFor = vi.fn(() => true);
    // A safety-class router-drop notification with a sessionId — must
    // NOT be deduped (it's a different banner family / no banner yet).
    notifyFromServerMsg(
      {
        type: 'notification' as const,
        id: 'srv-2',
        ts: 1,
        severity: 'warn' as const,
        class: 'safety' as const,
        dedupeKey: 'router_drop:forged_source:abc',
        title: 'Router drop',
        sessionId: 'sess-1',
        reasonCode: 'forged_source',
        sticky: true,
      },
      { push: r.push, isBannerVisibleFor },
    );
    expect(r.pushed).toHaveLength(1);
    expect(isBannerVisibleFor).not.toHaveBeenCalled();
  });

  test('rate_limit dedupeKey for a DIFFERENT sessionId still goes through (predicate is sessionId-specific)', () => {
    const r = recorder();
    // Banner mounted for sess-A, but toast is for sess-B.
    const isBannerVisibleFor = vi.fn((sid: string) => sid === 'sess-A');
    notifyFromServerMsg(rateLimitEnvelope('sess-B', 'hit'), {
      push: r.push,
      isBannerVisibleFor,
    });
    expect(r.pushed).toHaveLength(1);
    expect(isBannerVisibleFor).toHaveBeenCalledWith('sess-B', 'rate_limit');
  });

  test('rate_limit envelope with no sessionId (sessionless) is always passed through', () => {
    const r = recorder();
    const isBannerVisibleFor = vi.fn(() => true);
    notifyFromServerMsg(
      {
        type: 'notification' as const,
        id: 'srv-3',
        ts: 1,
        severity: 'warn' as const,
        class: 'operational' as const,
        dedupeKey: 'rate_limit:hit:global',
        title: 'Rate limit',
        sticky: false,
      },
      { push: r.push, isBannerVisibleFor },
    );
    expect(r.pushed).toHaveLength(1);
    expect(isBannerVisibleFor).not.toHaveBeenCalled();
  });

  test('dedup covers both rate_limit:hit and rate_limit:cleared (whole prefix family)', () => {
    const r = recorder();
    const isBannerVisibleFor = vi.fn(() => true);
    notifyFromServerMsg(rateLimitEnvelope('sess-1', 'hit'), {
      push: r.push,
      isBannerVisibleFor,
    });
    notifyFromServerMsg(rateLimitEnvelope('sess-1', 'cleared'), {
      push: r.push,
      isBannerVisibleFor,
    });
    expect(r.pushed).toHaveLength(0);
  });
});
