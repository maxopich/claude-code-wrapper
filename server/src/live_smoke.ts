// Live integration smoke test. Connects to a running server, exercises:
//   1. send_message that should trigger Bash → permission_request → auto-allow → tool_result
//   2. follow-up send_message with the same sessionId → resume context
// Run the server first: MOCK=0 npm run dev:server (in another terminal)
// Then:                  npm --workspace server exec tsx src/live_smoke.ts
import WebSocket from "ws";

const url = process.env.WS_URL ?? "ws://127.0.0.1:4319";
const PROJECT_NAME = process.env.PROJECT ?? "Cebab";

const ws = new WebSocket(url);

let projectId: number | undefined;
let sessionId: string | undefined;
let phase: "first" | "second" | "done" = "first";
let approvals = 0;
let lastResultText = "";

function send(msg: unknown) {
  console.log(">>>", JSON.stringify(msg).slice(0, 120));
  ws.send(JSON.stringify(msg));
}

function logSummary(msg: { type: string; subtype?: string; toolName?: string }) {
  const tag = msg.subtype ? `${msg.type}/${msg.subtype}` : msg.type;
  const extra = msg.toolName ? ` (${msg.toolName})` : "";
  console.log("<<<", tag + extra);
}

ws.on("open", () => {
  console.log("[live] connected to", url);
  send({ type: "list_projects" });
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "stream_delta") {
    if (msg.delta.kind === "text") process.stdout.write(msg.delta.text);
    return;
  }
  logSummary(msg);

  if (msg.type === "projects") {
    const p = msg.projects.find((x: { name: string }) => x.name === PROJECT_NAME);
    if (!p) {
      console.error(`project ${PROJECT_NAME} not found`);
      process.exit(1);
    }
    projectId = p.id;
    if (p.trusted) {
      console.error("[live] project is trusted; turning off so permission flow runs");
      send({ type: "set_trusted", projectId, trusted: false });
    }
    send({ type: "open_project", projectId });
  } else if (msg.type === "project_opened") {
    if (phase === "first") {
      send({
        type: "send_message",
        projectId,
        text:
          "Use the Bash tool to run `echo cebab-live-test-$$`. Reply with exactly one short sentence.",
      });
    }
  } else if (msg.type === "session_started") {
    sessionId = msg.sessionId;
    console.log("[live] session", sessionId);
  } else if (msg.type === "permission_request") {
    approvals++;
    console.log("[live] auto-allowing", msg.toolName);
    send({ type: "permission_decision", requestId: msg.requestId, decision: "allow" });
  } else if (msg.type === "result") {
    if (msg.result) lastResultText = msg.result;
    console.log(`[live] phase=${phase} cost=$${msg.totalCostUsd.toFixed(6)}`);
    console.log("[live] result text:", JSON.stringify(msg.result));
    if (phase === "first") {
      phase = "second";
      // Pass the sessionId to test --resume
      setTimeout(() => {
        send({
          type: "send_message",
          projectId,
          sessionId,
          text:
            "What number did the bash command print? Answer with just the number, nothing else.",
        });
      }, 500);
    } else {
      phase = "done";
      console.log("");
      console.log("=== summary ===");
      console.log(`approvals: ${approvals}`);
      console.log(`final result: ${JSON.stringify(lastResultText)}`);
      const pid = process.pid;
      const expected = String(pid);
      if (lastResultText.includes(expected) || /\d+/.test(lastResultText)) {
        console.log("[live] PASS — follow-up message saw context from first turn");
      } else {
        console.log("[live] PARTIAL — follow-up answered but did not include expected number");
      }
      setTimeout(() => {
        ws.close();
        process.exit(0);
      }, 200);
    }
  } else if (msg.type === "wrapper_error") {
    console.error("[live] wrapper_error", msg.kind, msg.message);
    process.exit(1);
  }
});

ws.on("close", () => {
  if (phase !== "done") {
    console.error("[live] socket closed unexpectedly in phase", phase);
    process.exit(1);
  }
});
ws.on("error", (err) => {
  console.error("[live] error", err);
  process.exit(1);
});
