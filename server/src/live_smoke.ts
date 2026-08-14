// Live integration smoke test. Connects to a running server, exercises:
//   1. send_message that should trigger Bash → permission_request → auto-allow → tool_result
//   2. follow-up send_message with the same sessionId → resume context
// Run the server first: MOCK=0 npm run dev:server (in another terminal)
// Then:                  npm --workspace server exec tsx src/live_smoke.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { sawNonce } from './smoke_assertions.js';

// F4: per-launch auth token. See ws_smoke.ts for the same setup.
const tokenPath = process.env.CEBAB_AUTH_TOKEN_FILE ?? path.join(os.homedir(), '.cebab/auth-token');
const token = process.env.CEBAB_AUTH_TOKEN ?? fs.readFileSync(tokenPath, 'utf8').trim();
const base = process.env.WS_URL ?? 'ws://127.0.0.1:4319';
const url = `${base}/?token=${encodeURIComponent(token)}`;
const PROJECT_NAME = process.env.PROJECT ?? 'Cebab';

const ws = new WebSocket(url);

let projectId: number | undefined;
let sessionId: string | undefined;
let phase: 'first' | 'second' | 'done' = 'first';
let approvals = 0;
let lastResultText = '';

/**
 * Register S11: the nonce the resume check is actually about.
 *
 * WHAT WAS WRONG. The first turn asked the agent to `echo cebab-live-test-$$`
 * and the summary then compared the answer against `String(process.pid)` —
 * this script's pid, while `$$` expands inside the agent's OWN bash. The two
 * were never going to match. The fallback `/\d+/.test(...)` then matched any
 * digit anywhere, and the follow-up prompt literally asks for a number, so
 * essentially every answer "passed". And both branches fell through to the
 * same `process.exit(0)`, so the resume check could not fail AT ALL — it
 * printed PARTIAL and exited green.
 *
 * A value this script generates is the only thing it can legitimately assert
 * on. Six digits with a fixed prefix: long enough not to appear by accident in
 * a sentence, short enough for a model to echo back without mangling.
 */
const NONCE = `cebab-live-${Math.floor(100000 + Math.random() * 900000)}`;

function send(msg: unknown) {
  console.log('>>>', JSON.stringify(msg).slice(0, 120));
  ws.send(JSON.stringify(msg));
}

function logSummary(msg: { type: string; subtype?: string; toolName?: string }) {
  const tag = msg.subtype ? `${msg.type}/${msg.subtype}` : msg.type;
  const extra = msg.toolName ? ` (${msg.toolName})` : '';
  console.log('<<<', tag + extra);
}

ws.on('open', () => {
  console.log('[live] connected to', url);
  send({ type: 'list_projects' });
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'stream_delta') {
    if (msg.delta.kind === 'text') process.stdout.write(msg.delta.text);
    return;
  }
  logSummary(msg);

  if (msg.type === 'projects') {
    const p = msg.projects.find((x: { name: string }) => x.name === PROJECT_NAME);
    if (!p) {
      console.error(`project ${PROJECT_NAME} not found`);
      process.exit(1);
    }
    projectId = p.id;
    if (p.trusted) {
      console.error('[live] project is trusted; turning off so permission flow runs');
      send({ type: 'set_trusted', projectId, trusted: false });
    }
    send({ type: 'open_project', projectId });
  } else if (msg.type === 'project_opened') {
    if (phase === 'first') {
      send({
        type: 'send_message',
        projectId,
        // The nonce is a literal in the prompt, NOT `$$` — the shell's `$$`
        // expands in the agent's bash to a pid this script never learns, which
        // is what made the old comparison meaningless.
        text: `Use the Bash tool to run \`echo ${NONCE}\`. Reply with exactly one short sentence.`,
      });
    }
  } else if (msg.type === 'session_started') {
    sessionId = msg.sessionId;
    console.log('[live] session', sessionId);
  } else if (msg.type === 'permission_request') {
    approvals++;
    console.log('[live] auto-allowing', msg.toolName);
    send({
      type: 'permission_decision',
      sessionId: msg.sessionId,
      requestId: msg.requestId,
      decision: 'allow',
    });
  } else if (msg.type === 'result') {
    if (msg.result) lastResultText = msg.result;
    console.log(`[live] phase=${phase} cost=$${msg.totalCostUsd.toFixed(6)}`);
    console.log('[live] result text:', JSON.stringify(msg.result));
    if (phase === 'first') {
      phase = 'second';
      // Pass the sessionId to test --resume
      setTimeout(() => {
        send({
          type: 'send_message',
          projectId,
          sessionId,
          text: 'What exact string did the bash command print? Answer with just that string, nothing else.',
        });
      }, 500);
    } else {
      phase = 'done';
      console.log('');
      console.log('=== summary ===');
      console.log(`approvals: ${approvals}`);
      console.log(`final result: ${JSON.stringify(lastResultText)}`);
      const resumed = sawNonce(lastResultText, NONCE);
      if (resumed) {
        console.log(`[live] PASS — follow-up echoed the nonce ${NONCE} from the first turn`);
      } else {
        console.error(`[live] FAIL — follow-up did not carry the first turn's nonce`);
        console.error(`  expected to contain: ${JSON.stringify(NONCE)}`);
        console.error(`  actual:              ${JSON.stringify(lastResultText)}`);
      }
      // Register S11: this used to be an unconditional exit(0), so the branch
      // above was console decoration. Nobody reads the console of a script
      // whose exit code is always green.
      setTimeout(() => {
        ws.close();
        process.exit(resumed ? 0 : 1);
      }, 200);
    }
  } else if (msg.type === 'wrapper_error') {
    console.error('[live] wrapper_error', msg.kind, msg.message);
    process.exit(1);
  }
});

ws.on('close', () => {
  if (phase !== 'done') {
    console.error('[live] socket closed unexpectedly in phase', phase);
    process.exit(1);
  }
});
ws.on('error', (err) => {
  console.error('[live] error', err);
  process.exit(1);
});
