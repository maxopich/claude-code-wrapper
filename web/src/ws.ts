import type { ClientMsg, ServerMsg } from '@cebab/shared/protocol';

export type WsHandle = {
  send(msg: ClientMsg): void;
  close(): void;
};

/**
 * Diagnostic surfaced to `onClose` so the `ConnectionLostOverlay`
 * variant resolver (Cluster G E3 UI) can distinguish "server killed
 * us with a known reason" (close codes 4001/4002 / structured server
 * error 1011) from "the socket just dropped" (1006 / 1005 — no code).
 *
 * Browsers fire the close event with a clean `CloseEvent`; we relay
 * `code` + `reason` + `wasClean` verbatim. Anything outside the typed
 * close-code domain (e.g. 1000 normal closure during page unload) is
 * passed through as-is — the host decides whether to surface an
 * overlay or silently ignore. See `web/src/components/connectionLost/`
 * for the reason-to-copy mapping.
 */
export type WsCloseInfo = {
  /** Numeric close code per RFC 6455 (1000–4999 reserved for app-level
   *  codes; 4001/4002 are reserved for Channel B per spec §4.3). */
  code: number;
  /** Human-readable reason string. Often empty for code 1006 (abnormal
   *  close — no close frame received). */
  reason: string;
  /** `true` when the connection closed cleanly via the server sending
   *  a close frame. False for transport-level drops (1006) where the
   *  socket disappeared without a graceful close. The overlay treats
   *  the wasClean=false case as "server unreachable" because the close
   *  frame would have carried the structured code if the server were
   *  rejecting deliberately. */
  wasClean: boolean;
};

export function connectWs(opts: {
  url: string;
  onOpen: () => void;
  onClose: (info: WsCloseInfo) => void;
  onMessage: (msg: ServerMsg) => void;
}): WsHandle {
  const ws = new WebSocket(opts.url);
  ws.addEventListener('open', opts.onOpen);
  // CloseEvent guarantees `code` + `wasClean`; `reason` is always
  // present but often the empty string for abnormal closures (1006).
  ws.addEventListener('close', (ev) => {
    opts.onClose({ code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
  });
  ws.addEventListener('message', (ev) => {
    try {
      opts.onMessage(JSON.parse(ev.data) as ServerMsg);
    } catch (err) {
      console.error('[ws] bad server json', err);
    }
  });
  return {
    send(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      ws.close();
    },
  };
}
