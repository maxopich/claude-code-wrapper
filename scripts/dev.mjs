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
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let tsxCli;
let viteBin;
try {
  tsxCli = require.resolve('tsx/cli'); // node_modules/tsx/dist/cli.mjs
  // vite's package `exports` block a direct `vite/bin/vite.js` resolve, so
  // go via its package.json + the `bin` field instead.
  const vitePkgPath = require.resolve('vite/package.json');
  const viteBinRel = JSON.parse(fs.readFileSync(vitePkgPath, 'utf8')).bin.vite;
  viteBin = path.join(path.dirname(vitePkgPath), viteBinRel);
} catch {
  console.error('[dev] dependencies missing — run `npm run bootstrap` first.');
  process.exit(1);
}

const targets = [
  {
    name: 'server',
    cwd: path.join(root, 'server'),
    args: [tsxCli, 'watch', '--env-file-if-exists=../.env', 'src/index.ts'],
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

for (const t of targets) {
  const child = spawn(process.execPath, t.args, {
    cwd: t.cwd,
    env: process.env,
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
  '[dev] starting…  server → http://127.0.0.1:4319   web → http://127.0.0.1:5173\n' +
    '[dev] open http://127.0.0.1:5173   (Ctrl+C stops both)',
);
