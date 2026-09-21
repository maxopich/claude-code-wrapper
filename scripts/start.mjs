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
 * This runs the COMPILED server — `node server/dist/index.js` — not the
 * TypeScript through `tsx`. Two things had to be true before it could, and both
 * now are (`Cebab-a3im`): `@cebab/shared` emits `dist/*.js` that plain Node
 * resolves under the `production` export condition (its barrel re-exports
 * `./protocol.js`, which does not exist while `shared` is `noEmit`), and the
 * server `build` copies its 41 `.sql` migrations next to the build output. The
 * `--conditions=production` flag below is what selects `shared`'s `dist` over
 * its `src`; tsx and vitest keep reading `src` via the `default` condition.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireFromWorkspace, resolveViteBin } from './dev-bins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDistIndex = path.join(root, 'web', 'dist', 'index.html');
const serverDistIndex = path.join(root, 'server', 'dist', 'index.js');
const sharedDistIndex = path.join(root, 'shared', 'dist', 'index.js');

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

/**
 * `tsc`'s bin path, resolved from the workspace that DECLARES it (`server`),
 * not from this file's directory — the same anchoring rule and reason as
 * `resolveViteBin` in `dev-bins.mjs` (Cebab-rlo). TypeScript's `exports` block
 * a direct `typescript/bin/tsc` resolve, so go via its `package.json` + `bin`.
 */
function resolveTscBin() {
  const pkgPath = requireFromWorkspace(root, 'server').resolve('typescript/package.json');
  const binRel = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).bin?.tsc;
  if (typeof binRel !== 'string') {
    throw new Error(`no string \`bin.tsc\` in ${pkgPath} — typescript changed its \`bin\` field`);
  }
  return path.join(path.dirname(pkgPath), binRel);
}

// Build the server bundle only when there is nothing to run — the same
// "build once" rule the web bundle uses below. `npm run build` is the explicit
// way to refresh it. Both `dist` trees are checked because the compiled server
// resolves `@cebab/shared` from `shared/dist` at runtime.
if (!fs.existsSync(serverDistIndex) || !fs.existsSync(sharedDistIndex)) {
  console.log('[start] no compiled server — building it once (this takes a moment)…');
  let tscBin;
  try {
    tscBin = resolveTscBin();
  } catch (err) {
    console.error(`[start] cannot build the server: ${err.message}`);
    console.error('[start] run `npm run build` on a machine with devDependencies, or');
    console.error('[start] install them here with `npm install` and try again.');
    process.exit(1);
  }
  // shared first (the server resolves it at runtime), then the server, then the
  // migration copy the server `build` script also runs after `tsc`.
  const steps = [
    [path.join(root, 'shared'), [tscBin, '-p', 'tsconfig.build.json']],
    [path.join(root, 'server'), [tscBin, '-p', 'tsconfig.build.json']],
    [root, [path.join(root, 'scripts', 'copy-migrations.mjs')]],
  ];
  for (const [cwd, args] of steps) {
    const code = await run(cwd, args);
    if (code !== 0) {
      console.error('[start] the server build failed; not starting.');
      process.exit(code);
    }
  }
}

// Build the web bundle only when there is nothing to serve. A rebuild on every
// start would add ~10s to a command whose entire purpose is to get the app in
// front of someone. `vite` is a `web` devDependency needed only here, so it is
// resolved lazily — an `--omit=dev` install that already has a built `web/dist`
// needs nothing else and must not fail on vite's absence.
if (!fs.existsSync(webDistIndex)) {
  console.log('[start] no web/dist — building the UI once (this takes a moment)…');
  let viteBin;
  try {
    viteBin = resolveViteBin(root);
  } catch (err) {
    console.error(`[start] no web/dist to serve, and vite is not installed: ${err.message}`);
    console.error('[start] run `npm run build` on a machine with devDependencies, or');
    console.error('[start] install them here with `npm install` and try again.');
    process.exit(1);
  }
  const code = await run(path.join(root, 'web'), [viteBin, 'build']);
  if (code !== 0) {
    console.error('[start] the web build failed; not starting the server.');
    process.exit(code);
  }
}

// `--conditions=production` selects `@cebab/shared`'s compiled `dist` (see the
// header); `--env-file-if-exists` matches what `dev:server` loads.
const server = spawn(
  process.execPath,
  ['--conditions=production', '--env-file-if-exists=../.env', 'dist/index.js'],
  {
    cwd: path.join(root, 'server'),
    stdio: 'inherit',
  },
);

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
