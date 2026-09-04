/**
 * `npm run dev` must be able to find the binaries it spawns (Cebab-rlo).
 *
 * WHAT WENT WRONG. `scripts/dev.mjs` resolved `tsx/cli` with a `require`
 * anchored at its own file, so Node looked in `<root>/scripts/node_modules`,
 * `<root>/node_modules` and the parent directories — never in
 * `<root>/server/node_modules`, where `tsx` actually lives. Every failure in
 * that block was then reported as "dependencies missing — run `npm run
 * bootstrap` first", so the one accurate signal was replaced by advice that
 * could not help: bootstrap succeeded every time and the launcher still
 * refused to start.
 *
 * WHY THIS TEST IS BEHAVIOURAL AND NOT A SOURCE SCAN. Nothing in the source
 * changed on the day it broke. `72bb2b1` (#297) was a dependabot lockfile
 * bump that moved `node_modules/tsx` to `server/node_modules/tsx`, and a scan
 * of `dev.mjs` reads the same bytes before and after. Only a test that
 * performs the real resolution against the INSTALLED TREE can see a
 * tree-shaped break, so that is what this does — through the launcher's own
 * `resolveDevBins`, never a local re-implementation of it, which would drift
 * from the launcher and then agree with itself.
 *
 * Deliberately NOT asserted: that `tsx` fails to resolve from the repo root.
 * That was the shape of the bug and was true when this was written, but npm is
 * free to hoist it back — the control would then go red for something that is
 * not a defect. It since did: as of 2026-09-04 `tsx` IS at the repo root and
 * resolves from there, so the assertion this file declined to make would now
 * be failing on a tree with no defect in it. The gate is unaffected, because
 * what it pins is the ANCHOR — `resolveDevBins` resolving from the workspace
 * that DECLARES the dependency — and a hoist that relocates the package is
 * exactly the churn a root-anchored resolve cannot survive.
 * What is asserted instead is that the helper reports a miss at all
 * (`project_gates_pass_vacuously`): a resolver that swallowed failures would
 * satisfy every case below while finding nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { stripComments } from './lib/strip_comments.mjs';
import { requireFromWorkspace, resolveDevBins } from './dev-bins.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Resolved once, lazily, so a throw lands on the case that names it rather
 *  than failing collection for the whole file with no case to point at. */
let cached;
function bins() {
  cached ??= resolveDevBins(repoRoot);
  return cached;
}

describe('the dev launcher can find the binaries it spawns', () => {
  test('the tsx CLI the [server] child runs resolves to a real file', () => {
    const { tsxCli } = bins();
    expect(fs.statSync(tsxCli).isFile()).toBe(true);
  });

  // Floor, and a shape guard. `bin` is a string for single-binary packages
  // and an object for the rest; vite ships the object form. If that flips,
  // `bin.vite` is undefined and the old code threw a bare ERR_INVALID_ARG_TYPE
  // from `path.join` naming neither vite nor the launcher — the second way
  // into the same unreadable failure. A resolved path that is not a file
  // fails here rather than at spawn time.
  test('the vite bin the [web] child runs resolves to a real file', () => {
    const { viteBin } = bins();
    expect(fs.statSync(viteBin).isFile()).toBe(true);
  });

  // Positive control. Without it, a `resolveDevBins` that quietly returned
  // paths it never checked — or a `requireFromWorkspace` that stopped
  // throwing — would keep both cases above green while finding nothing.
  test('a workspace anchor reports a miss instead of swallowing it', () => {
    const req = requireFromWorkspace(repoRoot, 'server');
    expect(() => req.resolve('cebab-no-such-package-rlo')).toThrow(/Cannot find module/);
  });
});

describe('the launcher actually uses the shared resolver', () => {
  const devScript = stripComments(
    fs.readFileSync(path.join(repoRoot, 'scripts', 'dev.mjs'), 'utf8').replace(/\r\n/g, '\n'),
  );

  // The cases above pass against `dev-bins.mjs` whether or not anything
  // imports it. Coverage that moved out of the file it protects and left the
  // original in place protects nothing, so pin the call site too.
  test('dev.mjs imports resolveDevBins', () => {
    expect(devScript).toMatch(/from '\.\/dev-bins\.mjs'/);
    expect(devScript).toMatch(/resolveDevBins\(root\)/);
  });

  test('dev.mjs resolves nothing on its own', () => {
    expect(devScript).not.toMatch(/require\.resolve\(/);
    expect(devScript).not.toMatch(/createRequire\(/);
  });
});
