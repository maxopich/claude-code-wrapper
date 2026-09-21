/**
 * The compiled server has to boot (Cebab-a3im). `npm start` runs
 * `node server/dist/index.js`, not the TypeScript through `tsx`, and two things
 * had to be true before it could — both measured here against real artifacts,
 * because both were invisible to a source scan of the modules that broke.
 *
 * BLOCKER 1 — `@cebab/shared`'s barrel. `shared/src/index.ts` is a run of
 * `export * from './protocol.js'` lines. With `shared` at `noEmit` and its
 * exports pointing only at `./src`, plain Node type-strips `index.ts` and then
 * cannot find `./protocol.js` (it does not remap `.js`→`.ts` the way tsx does),
 * so every compiled module that imports the barrel threw ERR_MODULE_NOT_FOUND
 * on boot. The fix: `shared` emits `dist/*.js`, and its `production` export
 * condition resolves there. tsx and vitest keep reading `./src` via `default`.
 *
 * BLOCKER 2 — the `.sql` migrations. `tsc` copies no assets, so a `tsc`-built
 * `server/dist/` had 0 of the 41 migrations `db.ts` applies. The server `build`
 * now runs `scripts/copy-migrations.mjs` after `tsc`.
 *
 * WHY BEHAVIOURAL. Blocker 1 is a runtime resolution fact — the source of
 * `index.ts` is identical before and after; only the package's `exports` and
 * whether `dist` exists change. So the test BUILDS `shared` and asks a real
 * `node` to resolve it. Blocker 2 is a build-step fact; the test runs the real
 * copier.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';

import { copyMigrations } from './copy-migrations.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `tsc`'s bin, resolved the same way `start.mjs` does (typescript blocks a
 *  direct `typescript/bin/tsc` resolve via its `exports`). */
function resolveTscBin() {
  const req = createRequire(path.join(repoRoot, 'server', 'package.json'));
  const pkgPath = req.resolve('typescript/package.json');
  const binRel = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).bin?.tsc;
  return path.join(path.dirname(pkgPath), binRel);
}

// ===========================================================================
// Blocker 1: the compiled barrel resolves under the production condition.
// ===========================================================================

describe('@cebab/shared resolves for the compiled server', () => {
  // Build shared into its real (gitignored) dist. Other test files never read
  // it — they resolve shared via the `default`/`development` conditions, which
  // point at `./src` — so writing it here affects nothing else in the run.
  test('shared builds to dist/*.js', () => {
    const r = spawnSync(process.execPath, [resolveTscBin(), '-p', 'tsconfig.build.json'], {
      cwd: path.join(repoRoot, 'shared'),
      encoding: 'utf8',
    });
    expect(r.status, `shared build failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(repoRoot, 'shared', 'dist', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'shared', 'dist', 'protocol.js'))).toBe(true);
  }, 30_000);

  // A dynamic import so a resolution failure is a rejected promise we can score,
  // not a process that dies before its first line runs.
  const probe =
    "import('@cebab/shared')" +
    ".then((m) => { process.stdout.write('OK:' + Object.keys(m).length); })" +
    ".catch((e) => { process.stdout.write('ERR:' + (e && e.code) + ':' + String((e && e.message) || '').split('\\n')[0]); process.exitCode = 9; });";

  function importShared(extraNodeArgs) {
    return spawnSync(process.execPath, [...extraNodeArgs, '--input-type=module', '-e', probe], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  }

  test('plain node loads the barrel under --conditions=production', () => {
    const r = importShared(['--conditions=production']);
    expect(r.status, `stdout=${r.stdout}\nstderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/^OK:\d+/);
    // Not an empty barrel: the re-exported modules actually loaded.
    expect(Number(r.stdout.slice(3))).toBeGreaterThan(0);
  }, 30_000);

  test('anti-vacuity: without the condition it is the pre-fix breakage', () => {
    // `default` → `./src`, and plain Node cannot resolve `./protocol.js` from a
    // type-stripped `index.ts`. This is the exact ERR the issue reported, and it
    // is what proves the `production` condition above is doing the work rather
    // than the barrel being loadable either way. If a future change makes the
    // bare `node dist` path work too, rewrite this — do not delete it.
    const r = importShared([]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('ERR_MODULE_NOT_FOUND');
    expect(r.stdout).toContain('protocol.js');
  }, 30_000);
});

// ===========================================================================
// Blocker 2: the .sql migrations land next to the build output.
// ===========================================================================

describe('the server build copies its .sql migrations', () => {
  const srcMigrations = path.join(repoRoot, 'server', 'src', 'migrations');
  const tmpDirs = [];
  afterAll(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function sqlNames(dir) {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  }

  test('there are migrations to copy — liveness', () => {
    // A copier tested against an empty source would pass while proving nothing.
    expect(sqlNames(srcMigrations).length).toBeGreaterThan(30);
  });

  test('copyMigrations copies every .sql, byte-for-byte', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mig-'));
    tmpDirs.push(dest);
    const copied = copyMigrations(srcMigrations, dest);
    const want = sqlNames(srcMigrations);
    expect(copied).toEqual(want);
    expect(sqlNames(dest)).toEqual(want);
    // Content, not just presence — a copier that truncated would still pass a
    // name check.
    for (const f of want) {
      expect(fs.readFileSync(path.join(dest, f), 'utf8')).toBe(
        fs.readFileSync(path.join(srcMigrations, f), 'utf8'),
      );
    }
  });

  test('copyMigrations creates a missing destination', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mig-'));
    tmpDirs.push(base);
    const dest = path.join(base, 'nested', 'migrations');
    expect(fs.existsSync(dest)).toBe(false);
    copyMigrations(srcMigrations, dest);
    expect(sqlNames(dest).length).toBe(sqlNames(srcMigrations).length);
  });

  test("the server's build script actually runs the copier", () => {
    // The behavioural cases above prove the copier WORKS; this pins that the
    // build INVOKES it. Coverage that sat in a helper nothing called would
    // protect nothing.
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'server', 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toContain('copy-migrations.mjs');
    expect(pkg.scripts.build).toMatch(/tsc\b.*&&.*copy-migrations/);
  });
});
