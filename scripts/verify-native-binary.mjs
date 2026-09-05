/**
 * Verify the one native binary this repo loads, because npm no longer does.
 *
 *   node scripts/verify-native-binary.mjs
 *
 * WHY THIS EXISTS (`Cebab-wfop`). Moving CI to Node 24 changed how
 * `better-sqlite3` gets its binding, and nobody decided to. On Node 20 there
 * was no matching prebuild, so `prebuild-install` failed over to
 * `node-gyp rebuild` and compiled from the npm TARBALL — whose sha512 is
 * pinned in `package-lock.json` and checked by npm. On Node 24 a v137 prebuild
 * exists, so the same step now downloads a binary from a GitHub release in
 * 0.6s instead of building for ~69s.
 *
 * `prebuild-install` does not verify what it downloads. Its only sha512 hashes
 * the URL to build a cache filename; the payload goes from gunzip straight
 * into tar extraction. So the single piece of native code Cebab loads into its
 * own process is the one dependency in the tree that arrives unchecked — in a
 * repo whose `.npmrc` exists specifically to harden the install path.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. It is trust-on-first-use, the same posture
 * Cebab already uses for MCP servers. The hashes below were recorded by
 * fetching each release asset on 2026-09-03; that proves nothing about whether
 * those assets were honest THEN. What it buys is that a later substitution —
 * the actual attack, replacing an asset that thousands of installs already
 * fetched — stops the build. Pinning a compromise is possible; pinning is
 * still strictly better than pinning nothing.
 *
 * The alternative considered and rejected: `--build-from-source` restores
 * npm's integrity check, and reintroduces the node-gyp dependency on Windows
 * that the `windows-2022` pin existed to work around. That trades a verified
 * install for a fragile one, and costs ~70s per Windows leg. The pin itself
 * was retired 2026-09-05 — see `ci.yml` — which makes THIS check the thing
 * standing between a silent compile fallback and a green build, since a
 * locally built binding will not match a recorded hash.
 *
 * Scope: ONE module. Every other dependency is still covered by the lockfile.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * sha256 of the extracted `better_sqlite3.node`, keyed by version then
 * `v<ABI>-<platform>-<arch>`.
 *
 * Recorded 2026-09-03 from the upstream release assets, and cross-checked
 * against the binary npm had actually installed on this machine — the
 * v147-darwin-arm64 entry below is byte-identical to
 * `node_modules/better-sqlite3/build/Release/better_sqlite3.node`, which is
 * what makes hashing the INSTALLED file a valid check rather than a different
 * measurement that happens to look similar.
 *
 * ABIs 137/141/147 are Node 24/25/26. `package.json` floors at Node 24 and CI
 * pins 24, so 137 is the one that gates merges; the other two are the versions
 * a developer plausibly runs.
 */
export const EXPECTED_HASHES = Object.freeze({
  'better-sqlite3': {
    '12.11.1': {
      'v137-darwin-arm64': 'c6fac315df023cf5efec45a3511e6515c6b0f7461a4a284b1b7a79c7ef8febe7',
      'v137-darwin-x64': '682f2d9850acd02e6209a2c1c5f7db19ec8c51ecc761b71a5501df56557c2f11',
      'v137-linux-x64': '45cb92a176fb758533db6d9a343acdfc73e4de27ac4c20a0cb2a6fb5be3e84f2',
      'v137-win32-x64': 'e75b8c024a85179d8e0e51203a8b8867916e9a51327ce3953db5f8483cc9a91e',
      'v141-darwin-arm64': '381dcb4cc3bc2bed1ae5457313bdd58501b8365c4c36c0c347fec2db7b77ebbc',
      'v141-darwin-x64': 'f2754a3408d2b1092115e58da48a3f138a78594a49d87b56edcd06bb43e2bbe0',
      'v141-linux-x64': '9928cfa1f234837839a4759a743158a959c7d2bff609c250dc3c6aa2a895917d',
      'v141-win32-x64': '707a4b480026ccd1fb8e308d43c7248e779d35eeefa09559ec9bb521bb97bb3b',
      'v147-darwin-arm64': '0000d73c6e2e94318ed2b9339139623d5a0908b195f1e761c16cfd98f9cc6229',
      'v147-darwin-x64': '098e2ca10709bdb5e54628639cd0a2ba9e034be89f9344ec91348ed93da54425',
      'v147-linux-x64': '44170d6656cd1a6b67c88816db5820f8f3719417b634f5218182e306c63784f7',
      'v147-win32-x64': '1aabe4eeb892f0899e7bc9682c1ab3f5168ac02d08a9d4aa5f5828ece227e0dc',
    },
  },
});

/** `v137-linux-x64` — the identity a prebuild is published under. */
export function platformKey(
  abi = process.versions.modules,
  platform = process.platform,
  arch = process.arch,
) {
  return `v${abi}-${platform}-${arch}`;
}

/**
 * The whole decision, as a pure function so both outcomes are testable without
 * a build.
 *
 * `unknown` is the interesting verdict. Failing it everywhere would brick any
 * developer on a platform nobody recorded; passing it everywhere would make
 * the check evaporate the moment a version bump changes the key — silently, on
 * the one job that is supposed to notice. So it is fatal in CI and a warning
 * outside it, and the message says which combination to add.
 *
 * @returns {{ok: boolean, verdict: string, message: string}}
 */
export function evaluate({
  version,
  key,
  actual,
  table = EXPECTED_HASHES['better-sqlite3'],
  inCI = false,
}) {
  if (!actual) {
    return {
      ok: false,
      verdict: 'missing',
      message:
        'no better_sqlite3.node found — run `npm rebuild better-sqlite3 ' +
        '--foreground-scripts --ignore-scripts=false` first. An absent binary ' +
        'is a failure, not a skip: this check must never pass on nothing.',
    };
  }
  const forVersion = table[version];
  if (!forVersion) {
    return {
      ok: !inCI,
      verdict: 'unknown-version',
      message:
        `better-sqlite3 ${version} has no recorded hashes. If this is a ` +
        `deliberate bump, record every platform for it — see this file's ` +
        `header for how the table was generated.`,
    };
  }
  const expected = forVersion[key];
  if (!expected) {
    return {
      ok: !inCI,
      verdict: 'unknown-platform',
      message:
        `no recorded hash for ${key} at better-sqlite3 ${version}. Add it, or ` +
        `this platform is unverified.`,
    };
  }
  if (expected !== actual) {
    return {
      ok: false,
      verdict: 'mismatch',
      message:
        `better_sqlite3.node for ${key} does not match the recorded hash.\n` +
        `  expected ${expected}\n  actual   ${actual}\n` +
        `This is the case the check exists for. Do not update the table to ` +
        `make it pass without establishing why the binary changed.`,
    };
  }
  return { ok: true, verdict: 'match', message: `better_sqlite3.node matches for ${key}` };
}

/** Resolve the installed binding and its version. Returns nulls rather than throwing. */
export function readInstalled(repoRoot = REPO_ROOT) {
  const require = createRequire(path.join(repoRoot, 'server', 'package.json'));
  let pkgPath;
  try {
    pkgPath = require.resolve('better-sqlite3/package.json');
  } catch {
    return { version: null, file: null, actual: null };
  }
  const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  const file = path.join(path.dirname(pkgPath), 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(file)) return { version, file, actual: null };
  return {
    version,
    file,
    actual: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  };
}

function main() {
  const inCI = process.env.CI === 'true' || process.env.CI === '1';
  const { version, file, actual } = readInstalled();
  if (!version) {
    console.error('[native-verify] better-sqlite3 is not installed — run `npm run bootstrap`.');
    process.exit(1);
  }
  const key = platformKey();
  const result = evaluate({ version, key, actual, inCI });

  const label = result.ok ? 'ok  ' : 'FAIL';
  console[result.ok ? 'log' : 'error'](`[native-verify] ${label} ${result.message}`);
  if (result.verdict !== 'match') console.error(`[native-verify] file: ${file}`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
