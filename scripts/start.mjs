/**
 * Run Cebab as an application, on ONE port, with no dev server.
 *
 *   npm start
 *
 * The difference from `npm run dev` is the whole point of this file: `dev`
 * starts two processes (the API and Vite) on two ports and watches for edits;
 * this builds the web bundle once, then starts the API server, which serves
 * that bundle from its own origin (`server/src/static_web.ts`). One process,
 * one URL, nothing watching the filesystem.
 *
 * Pure Node, no shell — same constraint and same idiom as `dev.mjs`, so it
 * behaves identically on macOS, Linux and Windows.
 *
 * `tsx` is what runs the server here, not `node server/dist/index.js`. The
 * compiled path does not boot today: `@cebab/shared`'s barrel re-exports
 * `./protocol.js` while `shared` is `noEmit`, so plain Node cannot resolve it,
 * and `tsc` does not copy the 41 `.sql` migrations into `dist`. Both are worth
 * fixing — they are what a published npm package would need — but neither is on
 * the path to "download it and use it", so this runs the TypeScript directly.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDevBins } from './dev-bins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDistIndex = path.join(root, 'web', 'dist', 'index.html');

let tsxCli;
let viteBin;
try {
  ({ tsxCli, viteBin } = resolveDevBins(root));
} catch (err) {
  console.error(`[start] could not locate the toolchain: ${err.message}`);
  console.error('[start] if this is a fresh clone, run `npm run bootstrap` first.');
  process.exit(1);
}

/** Spawn `node <cli> <args>` in `cwd` and resolve with its exit code. */
function run(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, stdio: 'inherit' });
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    child.on('error', (err) => {
      console.error(`[start] ${err.message}`);
      resolve(1);
    });
  });
}

// Build only when there is nothing to serve. A rebuild on every start would
// add ~10s to a command whose entire purpose is to get the app in front of
// someone; `npm run build` is the explicit way to refresh it.
if (!fs.existsSync(webDistIndex)) {
  console.log('[start] no web/dist — building the UI once (this takes a moment)…');
  const code = await run(path.join(root, 'web'), [viteBin, 'build']);
  if (code !== 0) {
    console.error('[start] the web build failed; not starting the server.');
    process.exit(code);
  }
}

const server = spawn(process.execPath, [tsxCli, '--env-file-if-exists=../.env', 'src/index.ts'], {
  cwd: path.join(root, 'server'),
  stdio: 'inherit',
});

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Forward rather than kill: the server's own handlers drain in-flight
    // `claude` subprocesses, and skipping that leaves them spending quota
    // after Cebab is gone (`runner/lifecycle.ts`).
    server.kill(sig === 'SIGBREAK' ? 'SIGINT' : sig);
  });
}

server.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
server.on('error', (err) => {
  console.error(`[start] could not start the server: ${err.message}`);
  process.exit(1);
});
