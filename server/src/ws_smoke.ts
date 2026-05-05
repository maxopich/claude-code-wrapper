// WS smoke client: connects to the running server, sends a few ClientMsgs,
// prints every ServerMsg. Used to verify the protocol end-to-end.
import WebSocket from "ws";

const url = process.env.WS_URL ?? "ws://127.0.0.1:4319";
const ws = new WebSocket(url);

let projectId: number | undefined;
let done = false;

function send(msg: unknown) {
  console.log(">>>", JSON.stringify(msg));
  ws.send(JSON.stringify(msg));
}

ws.on("open", () => {
  console.log("[smoke] connected to", url);
  send({ type: "list_projects" });
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  // Print compact summary, but full payload for important events.
  if (msg.type === "stream_delta") {
    process.stdout.write(msg.delta.kind === "text" ? msg.delta.text : "");
    return;
  }
  console.log("<<<", msg.type, msg.subtype ? `[${msg.subtype}]` : "");
  if (msg.type === "projects") {
    const cebab = msg.projects.find((p: { name: string }) => p.name === "Cebab");
    if (!cebab) {
      console.error("Cebab project not found in workspace");
      process.exit(1);
    }
    projectId = cebab.id;
    send({ type: "open_project", projectId });
  } else if (msg.type === "project_opened") {
    send({ type: "send_message", projectId, text: "irrelevant in mock mode" });
  } else if (msg.type === "result") {
    console.log("[smoke] cost=$" + msg.totalCostUsd.toFixed(6));
    done = true;
    setTimeout(() => {
      ws.close();
      process.exit(0);
    }, 200);
  }
});

ws.on("close", () => {
  if (!done) {
    console.error("[smoke] closed unexpectedly");
    process.exit(1);
  }
});
ws.on("error", (err) => {
  console.error("[smoke] error", err);
  process.exit(1);
});
