/**
 * [security] An origin is trusted only if Cebab BINDS the port or someone
 * DECLARES it (register H09).
 *
 * WHAT WENT WRONG. `server/src/origin.ts` hardcoded `http://127.0.0.1:5173`
 * and `http://localhost:5173` into the allow-list, unconditionally. 5173 is
 * *Vite's default port for every Vite project*, so it is not Cebab's to
 * trust — and an allow-listed origin is not a convenience, it is the control
 * plane: `GET /auth-token` hands the per-launch WS token to an allow-listed
 * Origin and echoes CORS back so browser JS can read it.
 *
 * The register filed this as "dev origins are allow-listed even in production
 * launches", and proposed an environment check. The fix is ownership instead:
 * the launcher that STARTS the web server is the one entitled to declare its
 * origin.
 *
 * That reasoning USED to rest on "nothing serves `web/dist` and `npm run dev`
 * is the only documented way to run the app". Both halves stopped being true
 * in #507 — `server/src/static_web.ts` mounts `express.static(dist)` and
 * `npm start` serves the UI from the API's own origin. The conclusion is
 * unchanged and now rests on something better: in single-port mode there is no
 * separate web origin to declare at all, because the page and the API share
 * one. `buildAllowedOrigins()` already allow-lists the port Cebab binds, so
 * the declared-origin path is still exactly the dev case it was written for —
 * and still must not hardcode Vite's default.
 *
 * WHY A SOURCE GATE AND NOT ONLY A UNIT TEST. Three separate files have to
 * agree, and none of them fails a behavioural test when they drift:
 *
 *   1. `web/vite.config.ts` must pin the port it promises (`strictPort`).
 *      Without it Vite's documented behaviour on a collision is to shift to
 *      the next free port — the declaration becomes a lie, Cebab's UI 403s
 *      itself on :5174, and :5173 stays trusted while belonging to whatever
 *      got there first. This is the coupling that makes the whole design
 *      sound, and it is one word in a config file.
 *   2. `scripts/dev.mjs` must hand the declaration to the API child and NOT
 *      to Vite (declaring it to Vite would mean nothing, and would make this
 *      gate unable to tell the two apart).
 *   3. `server/src/origin.ts` must keep exactly one port, `config.port`. A
 *      re-added literal is precisely the regression, and it looks harmless.
 *
 * Every scan below asserts a FLOOR on what it matched, and the origin.ts
 * matcher gets a POSITIVE CONTROL, so a regex that stops seeing the bad case
 * fails instead of reporting success (`project_gates_pass_vacuously`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// Strips `//` and block comments so this file's own explanations — and
// origin.ts's, which names :5173 several times in prose — cannot trip a scan
// or launder a violation past one. The local copy this replaced resolved `/*`
// before `//`, so a glob in a line comment opened a block that never closed
// (Cebab-1px); `scripts/stripCommentsConformance.test.mjs` now pins all three
// copies to the same behaviour.
import { stripComments } from './lib/strip_comments.mjs';
import { DEV_WEB_ORIGINS, DEV_WEB_PORT, withDeclaredWebOrigins } from './dev-origins.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Read a tracked file with newlines normalised. windows-2022 checks out CRLF
 *  unless `.gitattributes` says otherwise; every line-oriented scan in this
 *  repo normalises anyway, because the two that did not each failed on one
 *  runner only (`project_crlf_breaks_css_parsing_tests`). */
function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
}

/** Every literal port in a URL: a colon followed by digits. Deliberately not
 *  "any number" — `127.0.0.1` is full of digits and none of them is a port,
 *  and a matcher that flagged those would have to be loosened until it
 *  stopped catching anything. `:${config.port}` has no digits after the
 *  colon and so does not match, which is the entire point. */
function literalPorts(src) {
  return [...src.matchAll(/:(\d{2,5})\b/g)].map((m) => m[1]);
}

describe('[security] withDeclaredWebOrigins', () => {
  test('declares both loopback spellings of the dev web origin', () => {
    const env = withDeclaredWebOrigins({});
    expect(env.CEBAB_ALLOWED_ORIGINS.split(',')).toEqual([...DEV_WEB_ORIGINS]);
    expect(DEV_WEB_ORIGINS).toEqual([
      `http://127.0.0.1:${DEV_WEB_PORT}`,
      `http://localhost:${DEV_WEB_PORT}`,
    ]);
  });

  // The operator's own declaration is load-bearing: it is how the built
  // bundle is served from another port (.env.example documents exactly that).
  // Clobbering it would break that setup the moment they also used `npm run
  // dev`, and the breakage would look like an origin gate bug.
  test('appends to an operator declaration instead of replacing it', () => {
    const env = withDeclaredWebOrigins({
      CEBAB_ALLOWED_ORIGINS: 'http://127.0.0.1:8080, http://localhost:8080',
    });
    const got = env.CEBAB_ALLOWED_ORIGINS.split(',');
    expect(got.slice(0, 2)).toEqual(['http://127.0.0.1:8080', 'http://localhost:8080']);
    expect(got).toEqual(expect.arrayContaining([...DEV_WEB_ORIGINS]));
  });

  test('collapses a duplicate declaration rather than repeating it', () => {
    const env = withDeclaredWebOrigins({ CEBAB_ALLOWED_ORIGINS: DEV_WEB_ORIGINS[0] });
    expect(env.CEBAB_ALLOWED_ORIGINS.split(',')).toEqual([...DEV_WEB_ORIGINS]);
  });

  test('returns a copy and leaves the caller env untouched', () => {
    const source = { PATH: '/usr/bin', CEBAB_ALLOWED_ORIGINS: 'http://a:1' };
    const env = withDeclaredWebOrigins(source);
    expect(source.CEBAB_ALLOWED_ORIGINS).toBe('http://a:1');
    expect(env.PATH).toBe('/usr/bin');
  });
});

describe('[security] origin.ts trusts exactly one port', () => {
  const src = stripComments(read('server/src/origin.ts'));

  test('no URL carries a literal port — every one is config.port', () => {
    expect(literalPorts(src)).toEqual([]);
  });

  // Floor. Without this, deleting the origins (or renaming the field) leaves
  // the case above trivially green while the allow-list builds from nothing.
  test('the allow-list is still built from config.port', () => {
    expect(src.match(/\$\{config\.port\}/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  // Positive control. If `literalPorts` ever stops matching the shape this
  // gate exists to catch, this fails rather than the scan quietly passing.
  test('the matcher does catch a hardcoded origin', () => {
    expect(literalPorts('const a = `http://127.0.0.1:5173`;')).toEqual(['5173']);
    expect(literalPorts("const b = 'http://localhost:5173';")).toEqual(['5173']);
    expect(literalPorts('const c = `http://127.0.0.1:${config.port}`;')).toEqual([]);
  });
});

describe('[security] the launcher owns the port it declares', () => {
  const viteConfig = stripComments(read('web/vite.config.ts'));
  const devScript = stripComments(read('scripts/dev.mjs'));

  test('vite serves the port dev-origins.mjs declares', () => {
    const port = viteConfig.match(/\bport:\s*(\d+)/)?.[1];
    expect(port).toBe(String(DEV_WEB_PORT));
  });

  // The coupling this whole design rests on. Vite's default is
  // `strictPort: false` — it shifts to the next free port and prints a
  // notice, which nobody reads in an interleaved two-process log.
  test('vite refuses to shift ports, so the declaration cannot become a lie', () => {
    expect(viteConfig).toMatch(/\bstrictPort:\s*true\b/);
  });

  test('dev.mjs declares the origin to the API child', () => {
    expect(devScript).toMatch(/from '\.\/dev-origins\.mjs'/);
    expect(devScript).toMatch(/env:\s*withDeclaredWebOrigins\(process\.env\)/);
  });

  test('dev.mjs declares it to exactly one child, and spawn honours the default', () => {
    expect(devScript.match(/env:\s*withDeclaredWebOrigins\(/g)).toHaveLength(1);
    // A target without its own `env` must still inherit the ambient one —
    // otherwise Vite would spawn with an empty environment and the bug would
    // look like anything but this change.
    expect(devScript).toMatch(/env:\s*t\.env\s*\?\?\s*process\.env/);
  });

  // Floor: the scan must have found the two targets it reasons about, or a
  // restructured launcher would satisfy every assertion above vacuously.
  test('both dev targets are still present', () => {
    expect(devScript).toMatch(/name:\s*'server'/);
    expect(devScript).toMatch(/name:\s*'web'/);
  });
});
