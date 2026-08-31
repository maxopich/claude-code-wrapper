// WS smoke client: connects to the running server, drives one turn, and
// ASSERTS what came back. `ci_smoke.ts` runs this against a MOCK=1 server as a
// required check on every PR — see `smoke_assertions.ts` for what is checked
// and why the strict tier is mock-only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { DEFAULT_PORT } from '@cebab/shared/net';
import { formatVerdict, judgeSmokeRun, type SmokeObservation } from './smoke_assertions.js';

// F4: read the per-launch token from the server's data dir. The same uid
//     that started the server can read the file (mode 0600). Non-uid
//     callers (CI on another user) can override via $CEBAB_AUTH_TOKEN.
const tokenPath = process.env.CEBAB_AUTH_TOKEN_FILE ?? path.join(os.homedir(), '.cebab/auth-token');
const token = process.env.CEBAB_AUTH_TOKEN ?? fs.readFileSync(tokenPath, 'utf8').trim();
const base = process.env.WS_URL ?? `ws://127.0.0.1:${DEFAULT_PORT}`;
const url = `${base}/?token=${encodeURIComponent(token)}`;
const ws = new WebSocket(url);

let projectId: number | undefined;
let done = false;

// Collected as messages arrive, judged once the result lands. `mock` mirrors
// the env `ci_smoke` hands both the server and this process, so CI always
// takes the strict tier while a manual real-claude run does not.
const observed: SmokeObservation = {
  sessionId: undefined,
  streamedText: '',
  resultSubtype: undefined,
  resultText: undefined,
  errors: undefined,
  mock: process.env.MOCK === '1',
};

function send(msg: unknown) {
  console.log('>>>', JSON.stringify(msg));
  ws.send(JSON.stringify(msg));
}

ws.on('open', () => {
  console.log('[smoke] connected to', url);
  send({ type: 'list_projects' });
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  // Print compact summary, but full payload for important events.
  if (msg.type === 'stream_delta') {
    if (msg.delta.kind === 'text') {
      process.stdout.write(msg.delta.text);
      observed.streamedText += msg.delta.text;
    }
    return;
  }
  console.log('<<<', msg.type, msg.subtype ? `[${msg.subtype}]` : '');
  if (msg.type === 'projects') {
    const cebab = msg.projects.find((p: { name: string }) => p.name === 'Cebab');
    if (!cebab) {
      console.error('Cebab project not found in workspace');
      process.exit(1);
    }
    projectId = cebab.id;
    send({ type: 'open_project', projectId });
  } else if (msg.type === 'session_started') {
    observed.sessionId = msg.sessionId;
  } else if (msg.type === 'project_opened') {
    send({ type: 'send_message', projectId, text: 'irrelevant in mock mode' });
  } else if (msg.type === 'result') {
    console.log('[smoke] cost=$' + msg.totalCostUsd.toFixed(6));
    observed.resultSubtype = msg.subtype;
    observed.resultText = msg.result;
    observed.errors = msg.errors;
    done = true;

    // The whole point of this file. Before this, both outcomes reached the
    // same `process.exit(0)` two lines below.
    const verdict = judgeSmokeRun(observed);
    console.log(formatVerdict(verdict));

    setTimeout(() => {
      ws.close();
      process.exit(verdict.ok ? 0 : 1);
    }, 200);
  }
});

ws.on('close', () => {
  if (!done) {
    console.error('[smoke] closed unexpectedly');
    process.exit(1);
  }
});
ws.on('error', (err) => {
  console.error('[smoke] error', err);
  process.exit(1);
});
