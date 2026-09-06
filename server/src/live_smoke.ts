// Live integration smoke test. Connects to a running server, exercises:
//   1. send_message that should trigger Bash → permission_request → auto-allow → tool_result
//   2. follow-up send_message with the same sessionId → resume context
//
// Cebab-2dvd: BOTH halves decide the exit code, and the expected answer is
// chosen so neither can be satisfied without the tool actually running. The
// prompt asks for the sha256 of a value this script generates; a model cannot
// produce that from the prompt text, so an answer carrying it is proof the
// Bash call was raised, allowed, executed, and its output returned.
//
// It used to ask for `echo <nonce>` with the nonce written into the prompt —
// answerable verbatim without any tool at all. Observed 2026-09-06: a run
// finished `approvals: 0` and reported PASS, because `approvals` was counted,
// printed, and never asserted. That is the same defect Register S11 fixed one
// field over, in this file.
//
// Assumes a POSIX shell with `printf`, `shasum` and `cut` — same class of
// assumption as the `echo` it replaces.
// Run the server first: MOCK=0 npm run dev:server (in another terminal)
// Then:                  npm --workspace server exec tsx src/live_smoke.ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { DEFAULT_PORT } from '@cebab/shared/net';
import { sawNonce } from './smoke_assertions.js';

// F4: per-launch auth token. See ws_smoke.ts for the same setup.
const tokenPath = process.env.CEBAB_AUTH_TOKEN_FILE ?? path.join(os.homedir(), '.cebab/auth-token');
const token = process.env.CEBAB_AUTH_TOKEN ?? fs.readFileSync(tokenPath, 'utf8').trim();
const base = process.env.WS_URL ?? `ws://127.0.0.1:${DEFAULT_PORT}`;
const url = `${base}/?token=${encodeURIComponent(token)}`;
const PROJECT_NAME = process.env.PROJECT ?? 'Cebab';

const ws = new WebSocket(url);

let projectId: number | undefined;
let sessionId: string | undefined;
let phase: 'first' | 'awaiting-release' | 'second' | 'done' = 'first';
let approvals = 0;
let lastResultText = '';
let firstResultText = '';

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

/**
 * What the command must print. Derived here so the script knows the answer
 * WITHOUT telling the model: sha256 is not something a model can evaluate from
 * the prompt, so this string appears in the reply only if the Bash call really
 * ran. That is what upgrades the permission half from console decoration into
 * an assertion (Cebab-2dvd).
 *
 * `printf '%s'` rather than `echo` on purpose — no trailing newline, so the
 * bytes hashed in the shell are exactly the bytes hashed here.
 */
const EXPECTED = crypto.createHash('sha256').update(NONCE).digest('hex').slice(0, 12);
const COMMAND = `printf '%s' ${NONCE} | shasum -a 256 | cut -c1-12`;

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
        // is what made the old comparison meaningless. What the command PRINTS
        // is still unknowable from the prompt (Cebab-2dvd), which is what makes
        // the reply evidence that the tool ran.
        text:
          `Use the Bash tool to run exactly this command: \`${COMMAND}\`\n` +
          `Reply with only the command's output and nothing else.`,
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
    if (phase === 'first' && msg.result) firstResultText = msg.result;
    console.log(`[live] phase=${phase} cost=$${msg.totalCostUsd.toFixed(6)}`);
    console.log('[live] result text:', JSON.stringify(msg.result));
    if (phase === 'first') {
      // Cebab-uyuh: WAIT FOR THE RELEASE, do not sleep on a guess.
      //
      // `result` is not the end of the turn as the server sees it. The
      // `finally` in `runOneTurn` tears the SDK subprocess down BEFORE it
      // clears `conn.inFlight`, and `describeTurnInFlight` reads that map — so
      // a follow-up sent here is refused with `that session already has a turn
      // running`. This used to be a `setTimeout(…, 500)`, which is a guess that
      // sat just UNDER the real window: measured 2026-09-05 the guard cleared
      // after 549 / 565 / 545 ms, with `session_running(false)` at 536-539 ms.
      // So the sleep failed every run, and read like a flaky resume check.
      //
      // `session_running { running: false }` is emitted from that same finally,
      // which makes it the signal rather than a proxy for one. The UI now gates
      // its composer on the same fact (`turnInFlight` in `web/src/store.ts`).
      phase = 'awaiting-release';
    } else {
      phase = 'done';
      console.log('');
      console.log('=== summary ===');
      console.log(`approvals: ${approvals}`);
      console.log(`first result:  ${JSON.stringify(firstResultText)}`);
      console.log(`final result:  ${JSON.stringify(lastResultText)}`);
      console.log(`expected:      ${JSON.stringify(EXPECTED)}`);

      // Cebab-2dvd: three claims, each its own line in the verdict, each able
      // to fail the run. `approvals` used to be printed here and read by
      // nothing — a run with `approvals: 0` reported PASS.
      //
      // `toolRan` is not redundant with `approved`: an allowed call that never
      // executed, or whose output never came back, is the failure that matters,
      // and only the output can show it. EXPECTED is a sha of a value this
      // script generated, so the model cannot have produced it any other way.
      const approved = approvals >= 1;
      const toolRan = sawNonce(firstResultText, EXPECTED);
      const resumed = sawNonce(lastResultText, EXPECTED);

      const checks: Array<[boolean, string]> = [
        [approved, `a Bash permission_request was raised and allowed (approvals=${approvals})`],
        [toolRan, "the first turn's answer carries the command's real output"],
        [resumed, 'the follow-up recalled that output across --resume'],
      ];
      for (const [ok, label] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);

      const passed = checks.every(([ok]) => ok);
      if (passed) {
        console.log(`\n[live] PASS — permission round-trip and resume both verified`);
      } else {
        console.error(`\n[live] FAIL — see the lines above`);
        if (!approved) {
          console.error(
            '  No permission card was raised. Either the model answered without calling ' +
              'Bash (the prompt is meant to make that impossible — check it still asks for ' +
              'the sha), or the project was trusted so the call was auto-approved.',
          );
        }
        if (!toolRan) {
          console.error(`  expected to contain: ${JSON.stringify(EXPECTED)}`);
          console.error(`  actual:              ${JSON.stringify(firstResultText)}`);
        }
        if (!resumed) {
          console.error(`  expected to contain: ${JSON.stringify(EXPECTED)}`);
          console.error(`  actual:              ${JSON.stringify(lastResultText)}`);
        }
      }
      // Register S11: this used to be an unconditional exit(0), so the branch
      // above was console decoration. Nobody reads the console of a script
      // whose exit code is always green.
      setTimeout(() => {
        ws.close();
        process.exit(passed ? 0 : 1);
      }, 200);
    }
  } else if (
    msg.type === 'session_running' &&
    msg.running === false &&
    phase === 'awaiting-release'
  ) {
    phase = 'second';
    console.log('[live] turn released by the server — sending the resume follow-up');
    send({
      type: 'send_message',
      projectId,
      sessionId,
      text: 'What exact string did that command print? Answer with just that string, nothing else.',
    });
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
