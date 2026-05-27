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
