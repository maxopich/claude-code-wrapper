import { useEffect, useRef, useState } from 'react';
import type { ClientMsg, ServerMsg } from '@cebab/shared';

/**
 * P0-C part 2 (retention VISIBILITY): the data hook behind the Settings
 * modal's read-only "Storage" section. Dispatches `get_storage_stats` once on
 * mount and consumes the `storage_stats` reply over the WS side-channel — NOT
 * the main store reducer (modal-local, same posture as `useSessionSearch`).
 *
 * Because the modal mounts fresh each time the operator opens Settings, the
 * request re-fires on every open, so the readout is always current.
 *
 * `send` / `subscribeServerMsg` are mirrored in refs so an unstable parent
 * closure (App re-renders with a fresh `(m) => wsRef.current?.send(m)` each
 * tick) doesn't re-fire the request or churn the subscription.
 */

export type StorageStatsView = Extract<ServerMsg, { type: 'storage_stats' }>;

export type UseStorageStatsOpts = {
  send: (msg: ClientMsg) => void;
  subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
};

export type StorageStatsState = {
  stats: StorageStatsView | null;
  loading: boolean;
};

export function useStorageStats(opts: UseStorageStatsOpts): StorageStatsState {
  const sendRef = useRef(opts.send);
  sendRef.current = opts.send;
  const subscribeRef = useRef(opts.subscribeServerMsg);
  subscribeRef.current = opts.subscribeServerMsg;

  const [stats, setStats] = useState<StorageStatsView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Subscribe before dispatching so a fast reply can't slip past us. The
    // closure reads the live refs, so it never goes stale.
    const unsub = subscribeRef.current((msg) => {
      if (msg.type !== 'storage_stats') return;
      setStats(msg);
      setLoading(false);
    });
    sendRef.current({ type: 'get_storage_stats' });
    return unsub;
  }, []);

  return { stats, loading };
}
