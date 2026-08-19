/**
 * One-line dev launcher — starts the API server (:4319) and the Vite web
 * dev server (:5173) together as ONE foreground process.
 *
 *   npm run dev
 *
 * Pure Node, no shell: mirrors server/src/ci_smoke.ts so it behaves
 * identically on macOS, Linux and Windows — children are
 * `node <cli> <args>` (no `&`, no `.cmd` shim), and SIGINT/SIGTERM/
 * SIGBREAK tear BOTH down cleanly (graceful, then SIGKILL on timeout).
 *
 * Honors MOCK=1 from the repo-root .env: the server child gets the same
 * `--env-file-if-exists=../.env` that `npm run dev:server` uses, and Vite
 * reads the same file via `envDir: '..'`.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_WEB_PORT, withDeclaredWebOrigins } from './dev-origins.mjs';
import { resolveDevBins } from './dev-bins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let tsxCli;
let viteBin;
try {
  // Resolved from the workspace that DECLARES each binary, not from this
  // file's directory — `dev-bins.mjs` carries the why (Cebab-rlo).
  ({ tsxCli, viteBin } = resolveDevBins(root));
} catch (err) {
  // Say what actually went wrong. This used to report every failure as
  // "dependencies missing — run `npm run bootstrap` first", which was a
  // guess, and for the whole of Cebab-rlo it was the wrong guess: bootstrap
  // succeeded, `tsx` was installed, and the operator was sent round the loop
  // again with nothing new to go on. Node's own message names the module and
  // the require stack, so it points at the anchor that missed.
  console.error(`[dev] could not locate the dev tools: ${err.message}`);
  console.error('[dev] if this is a fresh clone, run `npm run bootstrap` first.');
  process.exit(1);
}

const targets = [
  {
    name: 'server',
    cwd: path.join(root, 'server'),
    args: [tsxCli, 'watch', '--env-file-if-exists=../.env', 'src/index.ts'],
    // Register H09: this launcher starts the Vite server below, so it is the
    // one caller entitled to declare that origin to the API. `origin.ts` no
    // longer hardcodes :5173 — nothing else on the machine gets to claim it.
    // Only the server child; declaring it to Vite would mean nothing.
    env: withDeclaredWebOrigins(process.env),
  },
  { name: 'web', cwd: path.join(root, 'web'), args: [viteBin] },
];

const children = [];
let shuttingDown = false;

/** Line-buffer a child stream and tag each line with its source. */
function prefix(stream, name, sink) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) sink.write(`[${name}] ${line}\n`);
  });
  stream.on('end', () => {
    if (buf.length) sink.write(`[${name}] ${buf}\n`);
  });
}

/** Graceful kill, then SIGKILL if it doesn't land — from ci_smoke.ts. */
function killAndWait(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all(children.map((c) => killAndWait(c)));
  process.exit(code);
}

// Sweep stale tsx-watch orphans from prior sessions before spawning ours.
// `tsx watch` is a supervisor that doesn't exit when its child crashes —
// across worktrees and Claude-Code background spawns these accumulate and
// silently squat on port 4319. This is the same cleanup `npm run dev:server`
// runs as its `predev` hook; we do it inline because `dev.mjs` spawns `tsx`
// directly (no `npm run server.dev` between us and tsx), so the predev hook
// never gets a chance to fire on this path. Inherits stdio so the user sees
// what got killed in the same terminal stream.
spawnSync(process.execPath, [path.join(root, 'scripts', 'predev-server.mjs')], {
  stdio: 'inherit',
});

for (const t of targets) {
  const child = spawn(process.execPath, t.args, {
    cwd: t.cwd,
    env: t.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  prefix(child.stdout, t.name, process.stdout);
  prefix(child.stderr, t.name, process.stderr);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev] ${t.name} exited (${signal ?? code}) — stopping the other process`);
    void shutdown(typeof code === 'number' && code !== 0 ? code : signal ? 1 : 0);
  });
  children.push(child);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => {
    console.log(`\n[dev] ${sig} — shutting down both processes`);
    void shutdown(0);
  });
}

console.log(
  `[dev] starting…  server → http://127.0.0.1:4319   web → http://127.0.0.1:${DEV_WEB_PORT}\n` +
    `[dev] open http://127.0.0.1:${DEV_WEB_PORT}   (Ctrl+C stops both)`,
);
