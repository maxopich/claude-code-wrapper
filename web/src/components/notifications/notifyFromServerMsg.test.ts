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

  test('Cebab-osfq: sessionless wrapper_error{kind:aborted} is a transient info toast, not a sticky crash', () => {
    const r = recorder();
    const mintId = vi.fn(() => 'mock-id');
    notifyFromServerMsg(
      {
        type: 'wrapper_error',
        kind: 'aborted',
        message: 'Multi-agent start cancelled: you declined a prompt.',
      } as ServerMsg,
      { push: r.push, mintId, now: () => 999 },
    );
    expect(r.pushed).toHaveLength(1);
    expect(r.pushed[0]).toMatchObject({
      severity: 'info',
      title: 'Cancelled',
      sticky: false,
      message: 'Multi-agent start cancelled: you declined a prompt.',
      // Its own key: on the crash key the dock would fold a later real crash
      // into this transient notice (see the source comment).
      dedupeKey: 'wrap:global:aborted',
    });
    // A cancellation must never read as a server crash.
    expect(r.pushed[0]?.severity).not.toBe('error');
    expect(r.pushed[0]?.title).not.toBe('Server error');
    expect(r.pushed[0]?.sticky).not.toBe(true);
  });

  test('Cebab-osfq regression guard: every OTHER sessionless kind stays a sticky Server error', () => {
    // Deliberately green before and after the change: it guards the branch
    // from being widened (e.g. to process_crashed, which carries refusals such
    // as "another multi-agent session is already running" that must stay loud).
    for (const kind of ['process_crashed', 'claude_not_found', 'auth_expired'] as const) {
      const r = recorder();
      notifyFromServerMsg({ type: 'wrapper_error', kind, message: 'boom' } as ServerMsg, r);
      expect(r.pushed, kind).toHaveLength(1);
      expect(r.pushed[0], kind).toMatchObject({
        severity: 'error',
        title: 'Server error',
        sticky: true,
        dedupeKey: 'wrap:global',
      });
    }
  });

  test('Cebab-osfq: a SESSION-SCOPED aborted does not toast either', () => {
    // Every Stop of a turn sends one. The aborted branch must stay behind the
    // session guard, or each Stop would pop a "Cancelled" toast.
    const r = recorder();
    notifyFromServerMsg(
      { type: 'wrapper_error', kind: 'aborted', message: 'x', sessionId: 's1' } as ServerMsg,
      r,
    );
    expect(r.pushed).toHaveLength(0);
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

  // Cebab-7vl4: a session-scoped wrapper_error whose id is a known multi-agent
  // run (an iteration / pending resume) has no chat to render into, so the toast
  // is its only surface. Gated on `isKnownMultiAgentSession` — a single-agent
  // session id (predicate false) still takes no toast (rendered as a chat banner).
  describe('Cebab-7vl4: a known multi-agent session-scoped wrapper_error', () => {
    test('aborted resume → transient "Resume cancelled" info toast, not sticky/red', () => {
      const r = recorder();
      notifyFromServerMsg(
        {
          type: 'wrapper_error',
          kind: 'aborted',
          message: 'Resume cancelled: you declined a trust or environment prompt.',
          sessionId: 'bus-1',
        } as ServerMsg,
        {
          push: r.push,
          mintId: () => 'mock-id',
          now: () => 42,
          isKnownMultiAgentSession: (sid) => sid === 'bus-1',
        },
      );
      expect(r.pushed).toHaveLength(1);
      expect(r.pushed[0]).toMatchObject({
        id: 'mock-id',
        ts: 42,
        severity: 'info',
        sticky: false,
        title: 'Resume cancelled',
        message: 'Resume cancelled: you declined a trust or environment prompt.',
        dedupeKey: 'wrap:multi-agent:bus-1:aborted',
      });
      expect(r.pushed[0]?.severity).not.toBe('error');
      expect(r.pushed[0]?.sticky).not.toBe(true);
    });

    test('a real resume failure → sticky "Resume failed" error toast', () => {
      for (const kind of ['process_crashed', 'claude_not_found', 'auth_expired'] as const) {
        const r = recorder();
        notifyFromServerMsg(
          {
            type: 'wrapper_error',
            kind,
            message: 'the resume blew up',
            sessionId: 'bus-1',
          } as ServerMsg,
          { push: r.push, isKnownMultiAgentSession: (sid) => sid === 'bus-1' },
        );
        expect(r.pushed, kind).toHaveLength(1);
        expect(r.pushed[0], kind).toMatchObject({
          severity: 'error',
          sticky: true,
          title: 'Resume failed',
          message: 'the resume blew up',
          dedupeKey: 'wrap:multi-agent:bus-1',
        });
      }
    });

    test('a session id the predicate does NOT know still takes no toast', () => {
      // Anti-vacuity: the toast is gated on membership, not on "has a sessionId".
      // A single-agent session error renders as a chat banner, not a toast.
      const r = recorder();
      notifyFromServerMsg(
        {
          type: 'wrapper_error',
          kind: 'process_crashed',
          message: 'boom',
          sessionId: 'not-a-bus-run',
        } as ServerMsg,
        { push: r.push, isKnownMultiAgentSession: (sid) => sid === 'bus-1' },
      );
      expect(r.pushed).toHaveLength(0);
    });
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

  // Cebab-4zkc: a failed managed-agent delete whose modal was dismissed
  // mid-flight would otherwise be silent — the reducer drops the late result
  // and the tree is already partly gone.
  describe('managed_delete_result', () => {
    function failedDelete(projectId: number, error: string): ServerMsg {
      return { type: 'managed_delete_result', projectId, result: { ok: false, error } };
    }

    test('failed delete with the modal gone becomes an error toast', () => {
      const r = recorder();
      const isManagedDeleteModalShowing = vi.fn(() => false);
      notifyFromServerMsg(failedDelete(7, 'could not remove all of the files (EBUSY)'), {
        push: r.push,
        mintId: () => 'mock-id',
        now: () => 42,
        isManagedDeleteModalShowing,
      });
      expect(r.pushed).toHaveLength(1);
      expect(r.pushed[0]).toMatchObject({
        id: 'mock-id',
        ts: 42,
        severity: 'error',
        class: 'operational',
        dedupeKey: 'managed_delete:7',
        message: 'could not remove all of the files (EBUSY)',
        sticky: true,
      });
      expect(isManagedDeleteModalShowing).toHaveBeenCalledWith(7);
    });

    test('failed delete whose modal is still open is NOT toasted (modal shows it inline)', () => {
      const r = recorder();
      const isManagedDeleteModalShowing = vi.fn(() => true);
      notifyFromServerMsg(failedDelete(7, 'EACCES'), {
        push: r.push,
        isManagedDeleteModalShowing,
      });
      expect(r.pushed).toHaveLength(0);
      expect(isManagedDeleteModalShowing).toHaveBeenCalledWith(7);
    });

    test('failed delete for a project other than the open modal still toasts', () => {
      const r = recorder();
      // The modal was replaced with a delete for project 9; project 7's
      // result would be dropped by the reducer, so it needs the toast.
      const isManagedDeleteModalShowing = vi.fn((pid: number) => pid === 9);
      notifyFromServerMsg(failedDelete(7, 'EBUSY'), {
        push: r.push,
        isManagedDeleteModalShowing,
      });
      expect(r.pushed).toHaveLength(1);
      expect(r.pushed[0]).toMatchObject({ dedupeKey: 'managed_delete:7' });
    });

    test('a SUCCESSFUL delete never toasts, even with its modal gone — only the failure does', () => {
      // Anti-vacuity: a lone "success does not toast" assertion passes on the
      // unfixed code too (no case → no toast either way), so it is folded into
      // a case that reddens. We fire a success AND a failure, both with the
      // modal gone, and assert exactly ONE toast lands — the failure's. On a
      // revert neither pushes, so `toHaveLength(1)` fails; the fix makes the
      // success silent (self-evident: the agent leaves the sidebar) while the
      // failure surfaces.
      const r = recorder();
      const isManagedDeleteModalShowing = vi.fn(() => false);
      notifyFromServerMsg(
        {
          type: 'managed_delete_result',
          projectId: 3,
          result: { ok: true, name: 'scribe', sessionsRemoved: 3 },
        },
        { push: r.push, isManagedDeleteModalShowing },
      );
      notifyFromServerMsg(failedDelete(7, 'EBUSY'), { push: r.push, isManagedDeleteModalShowing });
      expect(r.pushed).toHaveLength(1);
      expect(r.pushed[0]).toMatchObject({ dedupeKey: 'managed_delete:7' });
    });
  });
});
