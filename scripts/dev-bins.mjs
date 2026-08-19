/**
 * Locate the two binaries `scripts/dev.mjs` spawns: the `tsx` CLI for the API
 * child and vite's bin for the web child.
 *
 * WHY THIS IS ITS OWN MODULE. It resolves them from the workspace that
 * DECLARES each one, not from wherever the launcher happens to sit — and that
 * distinction is the whole bug this file exists to prevent (Cebab-rlo).
 * `dev.mjs` used to do `createRequire(import.meta.url).resolve('tsx/cli')`,
 * anchored at `<root>/scripts/`. Node then walks `<root>/scripts/node_modules`
 * → `<root>/node_modules` → the parent directories, and never descends into
 * `<root>/server/node_modules` — which is exactly where `tsx` lives, because
 * it is a devDependency of the `server` workspace and npm nests rather than
 * hoists it. `vite` happens to be hoisted to the root today, so only the `tsx`
 * leg failed, and it failed for everyone on every platform.
 *
 * Nothing in the source changed on the day it broke: `72bb2b1` (#297) was a
 * dependabot lockfile bump that moved `node_modules/tsx` to
 * `server/node_modules/tsx`. So hoisting is not a thing a launcher may assume
 * — a dependency's DECLARATION is stable, its position in the tree is not.
 * Anchoring at the declaring workspace is correct under either layout.
 *
 * Kept out of `dev.mjs` so `scripts/devBins.test.mjs` can exercise the real
 * resolution rather than a re-implementation of it that would drift from the
 * launcher (the same reason `dev-origins.mjs` is separate from its test).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A `require` anchored at one workspace's own `package.json`, so resolution
 * starts inside that workspace's `node_modules` and only then walks up.
 * Exported so the test can drive the real anchor — a positive control that
 * builds its own copy would stop proving anything the moment this one moved.
 */
export function requireFromWorkspace(root, workspace) {
  return createRequire(path.join(root, workspace, 'package.json'));
}

/** `{ tsxCli, viteBin }` — absolute paths, both spawned as `node <path>`. */
export function resolveDevBins(root) {
  const tsxCli = requireFromWorkspace(root, 'server').resolve('tsx/cli');

  // vite's package `exports` block a direct `vite/bin/vite.js` resolve, so go
  // via its package.json + the `bin` field instead.
  const vitePkgPath = requireFromWorkspace(root, 'web').resolve('vite/package.json');
  const viteBinRel = JSON.parse(fs.readFileSync(vitePkgPath, 'utf8')).bin?.vite;
  // `bin` is a string for single-binary packages and an object for the rest.
  // vite ships the object form; if that ever flips, `path.join` would throw a
  // bare `TypeError [ERR_INVALID_ARG_TYPE]` naming neither vite nor this file,
  // which is precisely the kind of unreadable failure the old catch turned
  // into "dependencies missing".
  if (typeof viteBinRel !== 'string') {
    throw new Error(
      `no string \`bin.vite\` in ${vitePkgPath} (got ${JSON.stringify(viteBinRel)}) — ` +
        `vite changed the shape of its \`bin\` field`,
    );
  }

  return { tsxCli, viteBin: path.join(path.dirname(vitePkgPath), viteBinRel) };
}
