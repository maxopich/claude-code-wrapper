import { describe, expect, test } from 'vitest';
import type { NotificationEnvelope } from '@cebab/shared/protocol';
import {
  MAX_VISIBLE,
  initialNotificationsState,
  notificationsReducer,
} from './notificationsReducer';

function envelope(
  overrides: Partial<NotificationEnvelope> & Pick<NotificationEnvelope, 'id' | 'dedupeKey'>,
): NotificationEnvelope {
  return {
    ts: 0,
    severity: 'info',
    class: 'operational',
    title: 't',
    sticky: false,
    ...overrides,
  };
}

describe('notificationsReducer — push', () => {
  test('first push adds to visible with count=1', () => {
    const next = notificationsReducer(initialNotificationsState, {
      type: 'push',
      n: envelope({ id: 'a', dedupeKey: 'k1' }),
      now: 100,
    });
    expect(next.visible).toHaveLength(1);
    expect(next.queued).toHaveLength(0);
    expect(next.visible[0]).toMatchObject({ id: 'a', count: 1, receivedAt: 100 });
  });

  test('UI-9: duplicate dedupeKey increments count instead of adding a row', () => {
    let s = notificationsReducer(initialNotificationsState, {
      type: 'push',
      n: envelope({ id: 'a', dedupeKey: 'k1' }),
      now: 100,
    });
    s = notificationsReducer(s, {
      type: 'push',
      n: envelope({ id: 'b-ignored', dedupeKey: 'k1' }),
      now: 250,
    });
    expect(s.visible).toHaveLength(1);
    // ID stays stable across coalesces; receivedAt updates.
    expect(s.visible[0]).toMatchObject({ id: 'a', count: 2, receivedAt: 250 });
  });

  test('different dedupe keys do not coalesce', () => {
    let s = notificationsReducer(initialNotificationsState, {
      type: 'push',
      n: envelope({ id: 'a', dedupeKey: 'k1' }),
      now: 1,
    });
    s = notificationsReducer(s, {
      type: 'push',
      n: envelope({ id: 'b', dedupeKey: 'k2' }),
      now: 2,
    });
    expect(s.visible).toHaveLength(2);
  });

  test('UI-3: 5th push evicts oldest evictable info, keeps total at MAX_VISIBLE', () => {
    let s = initialNotificationsState;
    for (let i = 0; i < MAX_VISIBLE; i++) {
      s = notificationsReducer(s, {
        type: 'push',
        n: envelope({ id: `id${i}`, dedupeKey: `k${i}`, severity: 'info' }),
        now: 100 + i,
      });
    }
    expect(s.visible).toHaveLength(MAX_VISIBLE);
    s = notificationsReducer(s, {
      type: 'push',
      n: envelope({ id: 'new', dedupeKey: 'kx', severity: 'info' }),
      now: 500,
    });
    expect(s.visible).toHaveLength(MAX_VISIBLE);
    expect(s.queued).toHaveLength(0);
    // Oldest (id0) was evicted; newest must be present.
    expect(s.visible.find((v) => v.id === 'id0')).toBeUndefined();
    expect(s.visible.find((v) => v.id === 'new')).toBeDefined();
  });

  test('UI-3: error/danger/sticky are never evicted — 5th push queues instead', () => {
    let s = initialNotificationsState;
    s = notificationsReducer(s, {
      type: 'push',
      n: envelope({ id: 'e1', dedupeKey: 'a', severity: 'error' }),
      now: 1,
    });
    s = notificationsReducer(s, {
      type: 'push',
      n: envelope({ id: 'd1', dedupeKey: 'b', severity: 'danger' }),
      now: 2,
    });
    s = notificationsReducer(s, {
      type: 'push',
      n: envelope({ id: 's1', dedupeKey: 'c', severity: 'info', sticky: true }),
      now: 3,
    });
    s = notificationsReducer(s, {
      type: 'push',
      n: envelope({ id: 'e2', dedupeKey: 'd', severity: 'error' }),
      now: 4,
    });
    expect(s.visible).toHaveLength(MAX_VISIBLE);
    s = notificationsReducer(s, {
      type: 'push',
      n: envelope({ id: 'new', dedupeKey: 'e', severity: 'info' }),
      now: 5,
    });
    expect(s.visible).toHaveLength(MAX_VISIBLE);
    expect(s.queued).toEqual([expect.objectContaining({ id: 'new' })]);
  });

  test('dedupe pass also looks in the queued list, not just visible', () => {
    let s = initialNotificationsState;
    // Fill visible with non-evictable
    for (let i = 0; i < MAX_VISIBLE; i++) {
      s = notificationsReducer(s, {
        type: 'push',
        n: envelope({ id: `e${i}`, dedupeKey: `nev${i}`, severity: 'error' }),
        now: i,
      });
    }
    // First push of "q1" goes to queue
    s = notificationsReducer(s, {
      type: 'push',
      n: envelope({ id: 'q1', dedupeKey: 'qkey', severity: 'info' }),
      now: 100,
    });
    expect(s.queued).toHaveLength(1);
    // Second push with the same dedupeKey while still queued — should coalesce in queue
    s = notificationsReducer(s, {
      type: 'push',
      n: envelope({ id: 'q2', dedupeKey: 'qkey', severity: 'info' }),
      now: 200,
    });
    expect(s.queued).toHaveLength(1);
    expect(s.queued[0]).toMatchObject({ id: 'q1', count: 2, receivedAt: 200 });
  });
});

describe('notificationsReducer — dismiss', () => {
  test('removes from visible and promotes the head of the queue', () => {
    let s = initialNotificationsState;
    // 4 non-evictable visible
    for (let i = 0; i < MAX_VISIBLE; i++) {
      s = notificationsReducer(s, {
        type: 'push',
        n: envelope({ id: `e${i}`, dedupeKey: `nev${i}`, severity: 'error' }),
        now: i,
      });
    }
    // 2 queued
    s = notificationsReducer(s, {
      type: 'push',
      n: envelope({ id: 'q1', dedupeKey: 'q1' }),
      now: 100,
    });
    s = notificationsReducer(s, {
      type: 'push',
      n: envelope({ id: 'q2', dedupeKey: 'q2' }),
      now: 200,
    });
    expect(s.queued).toHaveLength(2);

    s = notificationsReducer(s, { type: 'dismiss', id: 'e0' });
    expect(s.visible).toHaveLength(MAX_VISIBLE);
    // q1 (FIFO head) promoted; q2 still queued
    expect(s.visible.find((v) => v.id === 'q1')).toBeDefined();
    expect(s.queued.map((q) => q.id)).toEqual(['q2']);
  });

  test('dismissing an id that lives in queue only — removes from queue', () => {
    let s = initialNotificationsState;
    for (let i = 0; i < MAX_VISIBLE; i++) {
      s = notificationsReducer(s, {
        type: 'push',
        n: envelope({ id: `e${i}`, dedupeKey: `nev${i}`, severity: 'error' }),
        now: i,
      });
    }
    s = notificationsReducer(s, {
      type: 'push',
      n: envelope({ id: 'q1', dedupeKey: 'q1' }),
      now: 100,
    });
    s = notificationsReducer(s, { type: 'dismiss', id: 'q1' });
    expect(s.queued).toHaveLength(0);
    expect(s.visible).toHaveLength(MAX_VISIBLE);
  });

  test('unknown id is a no-op (returns same reference)', () => {
    const s = notificationsReducer(initialNotificationsState, {
      type: 'push',
      n: envelope({ id: 'a', dedupeKey: 'k' }),
      now: 1,
    });
    const next = notificationsReducer(s, { type: 'dismiss', id: 'does-not-exist' });
    expect(next).toBe(s);
  });
});

describe('notificationsReducer — reset', () => {
  test('clears both lists back to initial', () => {
    let s = initialNotificationsState;
    for (let i = 0; i < 6; i++) {
      s = notificationsReducer(s, {
        type: 'push',
        n: envelope({ id: `e${i}`, dedupeKey: `nev${i}`, severity: 'error' }),
        now: i,
      });
    }
    s = notificationsReducer(s, { type: 'reset' });
    expect(s).toEqual(initialNotificationsState);
  });
});
