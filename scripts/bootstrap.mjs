/**
 * One-line cross-platform install.
 *
 *   npm run bootstrap
 *
 * Runnable on a fresh clone (`npm run <script>` needs no node_modules; this
 * script uses only node:child_process). No shell — identical on macOS,
 * Linux and Windows. Three steps, mirroring CI:
 *
 *   1. npm install --ignore-scripts
 *        (.npmrc already sets ignore-scripts=true; the flag is explicit so
 *         a malicious transitive postinstall can never run — see .npmrc.)
 *   2. npm rebuild better-sqlite3 --foreground-scripts --ignore-scripts=false
 *        (the ONE legit native binding; prebuild-install fetches a prebuilt
 *         binary on mac/Linux/Windows x64 — no compiler toolchain needed.)
 *   3. husky (git hooks) — best-effort: a tarball/non-git checkout has no
 *        .git and hooks aren't needed to run the app, so a failure warns
 *        instead of aborting.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(npm, args, { cwd: root, env: process.env, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(`[bootstrap] could not spawn ${npm}: ${String(err)}`);
      resolve(1);
    });
  });
}

const steps = [
  { label: 'install dependencies', args: ['install', '--ignore-scripts'] },
  {
    label: 'build the native better-sqlite3 binding',
    args: ['rebuild', 'better-sqlite3', '--foreground-scripts', '--ignore-scripts=false'],
  },
];

for (const step of steps) {
  console.log(`\n[bootstrap] ${step.label}…`);
  const code = await run(step.args);
  if (code !== 0) {
    console.error(`[bootstrap] "${step.label}" failed (exit ${code}). Aborting.`);
    process.exit(code);
  }
}

console.log('\n[bootstrap] install git hooks (husky)…');
const huskyCode = await run(['exec', '--no', '--', 'husky']);
if (huskyCode !== 0) {
  console.warn('[bootstrap] husky skipped (non-git or unavailable) — fine, hooks are dev-only.');
}

console.log('\n[bootstrap] done.  Start the app with:  npm run dev');
