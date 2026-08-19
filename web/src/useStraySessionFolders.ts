import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMsg, ServerMsg, StraySessionFolder } from '@cebab/shared';

/**
 * Cebab-ws0.13: the data hook behind Settings → Storage → "Leftover session
 * folders".
 *
 * Same WS side-channel posture as `useStorageStats` (modal-local, not the main
 * store reducer) with ONE deliberate difference: it does NOT dispatch on mount.
 * The scan walks the operator's whole workspace recursively to total each
 * folder's size, which is unbounded work most operators have no reason to pay —
 * the overwhelming majority have no leftovers at all, since only sessions
 * started before Cebab-ws0.8 created them. So it is behind an explicit button.
 */

export type StrayScanReply = Extract<ServerMsg, { type: 'stray_session_folders' }>;
export type StrayDeleteReply = Extract<ServerMsg, { type: 'stray_session_folders_deleted' }>;

export type UseStraySessionFoldersOpts = {
  send: (msg: ClientMsg) => void;
  subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
};

export type StraySessionFoldersState = {
  scan: StrayScanReply | null;
  scanning: boolean;
  lastDelete: StrayDeleteReply | null;
  requestScan: () => void;
  requestDelete: (names: string[]) => void;
};

/** A folder the operator may delete: no session row points at it, and no run
 *  is in flight for it. The server re-checks both — this only shapes the UI. */
export function isDeletable(f: StraySessionFolder): boolean {
  return f.sessionStatus === null && !f.running;
}

export function useStraySessionFolders(opts: UseStraySessionFoldersOpts): StraySessionFoldersState {
  const sendRef = useRef(opts.send);
  sendRef.current = opts.send;
  const subscribeRef = useRef(opts.subscribeServerMsg);
  subscribeRef.current = opts.subscribeServerMsg;

  const [scan, setScan] = useState<StrayScanReply | null>(null);
  const [scanning, setScanning] = useState(false);
  const [lastDelete, setLastDelete] = useState<StrayDeleteReply | null>(null);

  useEffect(() => {
    return subscribeRef.current((msg) => {
      if (msg.type === 'stray_session_folders') {
        setScan(msg);
        setScanning(false);
        return;
      }
      if (msg.type === 'stray_session_folders_deleted') {
        setLastDelete(msg);
        // Re-scan rather than patching the list locally: the server is the only
        // thing that knows what actually left the disk, and a refusal means the
        // row must stay. Reconciling that by hand is how a UI starts claiming
        // deletions that did not happen.
        setScanning(true);
        sendRef.current({ type: 'get_stray_session_folders' });
      }
    });
  }, []);

  const requestScan = useCallback(() => {
    setScanning(true);
    sendRef.current({ type: 'get_stray_session_folders' });
  }, []);

  const requestDelete = useCallback((names: string[]) => {
    if (names.length === 0) return;
    sendRef.current({ type: 'delete_stray_session_folders', names });
  }, []);

  return { scan, scanning, lastDelete, requestScan, requestDelete };
}
