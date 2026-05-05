import type { ClientMsg, ServerMsg } from "@cebab/shared/protocol";

export type WsHandle = {
  send(msg: ClientMsg): void;
  close(): void;
};

export function connectWs(opts: {
  url: string;
  onOpen: () => void;
  onClose: () => void;
  onMessage: (msg: ServerMsg) => void;
}): WsHandle {
  const ws = new WebSocket(opts.url);
  ws.addEventListener("open", opts.onOpen);
  ws.addEventListener("close", opts.onClose);
  ws.addEventListener("message", (ev) => {
    try {
      opts.onMessage(JSON.parse(ev.data) as ServerMsg);
    } catch (err) {
      console.error("[ws] bad server json", err);
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
