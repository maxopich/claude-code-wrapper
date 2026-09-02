/**
 * Route precedence for single-port serving.
 *
 * The hazard this file exists for is not "does static serving work" — it is
 * that an SPA history fallback answers EVERYTHING with 200 and a page of HTML.
 * Mount it in the wrong order, or without an API carve-out, and `/health`
 * stops reporting health while still returning 200; every caller downstream
 * reads success. So each test below asserts on the BODY, not the status.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import request from 'node:http';

import { mountWebApp, resolveWebDist, webDistPath } from './static_web.js';

const MARKER = '<!doctype html><title>cebab-spa-fixture</title>';
const ASSET = 'console.log("asset");';

let dist: string;
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-static-'));
  dist = path.join(tmpRoot, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), MARKER);
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), ASSET);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** The `:sid` the parameterised route last received, or null if it never ran. */
let seenSid: string | null = null;

/** An app with the real API-route shapes mounted BEFORE the SPA, as index.ts does. */
function appWithRoutes(): express.Express {
  seenSid = null;
  const app = express();
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/auth-token', (_req, res) => {
    res.type('text/plain').send('TOKEN');
  });
  app.get('/session-log/:sid', (req, res) => {
    // The param is RECORDED, not echoed. Reflecting it would make this
    // fixture a real reflected-XSS sink — CodeQL flagged exactly that on the
    // first version — and the assertion does not need the round trip: what
    // the test is proving is that the parameterised route matched at all
    // rather than the SPA fallback swallowing it.
    seenSid = req.params.sid;
    res.type('text/plain').send('log');
  });
  mountWebApp(app, dist);
  return app;
}

function get(app: express.Express, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      const req = request.request({ host: '127.0.0.1', port, path: urlPath }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          server.close(() => resolve({ status: res.statusCode ?? 0, body }));
        });
      });
      req.on('error', (e) => server.close(() => reject(e)));
      req.end();
    });
  });
}

describe('mountWebApp route precedence', () => {
  test('the API routes still answer, not the SPA', async () => {
    const app = appWithRoutes();
    expect((await get(app, '/health')).body).toBe('{"ok":true}');
    expect((await get(app, '/auth-token')).body).toBe('TOKEN');
    expect((await get(app, '/session-log/abc')).body).toBe('log');
    expect(seenSid).toBe('abc');
  });

  test('a typo under an API prefix 404s instead of returning the SPA', async () => {
    // The second line of defence. Registration order alone already sends
    // `/health` to its handler; this is what stops `/healht` from looking
    // like a 200 to a caller that only checks the status code.
    const res = await get(appWithRoutes(), '/session-log');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('cebab-spa-fixture');
  });

  test('a real asset is served from disk', async () => {
    expect((await get(appWithRoutes(), '/assets/app.js')).body).toBe(ASSET);
  });

  test('an unknown app route falls back to index.html', async () => {
    const res = await get(appWithRoutes(), '/some/deep/client/route');
    expect(res.status).toBe(200);
    expect(res.body).toBe(MARKER);
  });

  test('the root serves index.html', async () => {
    expect((await get(appWithRoutes(), '/')).body).toBe(MARKER);
  });

  test('the fallback works when the install path contains a dot-directory', async () => {
    // `send` rejects dot-SEGMENTS, and given an absolute path with no `root`
    // it applies that to every segment — so `~/.local/share/cebab` or a git
    // worktree under `.claude/` served assets correctly and 404'd every client
    // route: a blank page with a healthy-looking network tab. `os.tmpdir()`
    // has no dot-segment, which is exactly why the other tests here missed it.
    const dotted = path.join(tmpRoot, '.hidden', 'dist');
    fs.mkdirSync(dotted, { recursive: true });
    fs.writeFileSync(path.join(dotted, 'index.html'), MARKER);

    const app = express();
    mountWebApp(app, dotted);
    const res = await get(app, '/some/client/route');
    expect(res.status).toBe(200);
    expect(res.body).toBe(MARKER);
  });

  test('mounting is a no-op when there is no build', () => {
    const app = express();
    app.get('/health', (_req, res) => {
      res.json({ ok: true });
    });
    expect(mountWebApp(app, null)).toBeNull();
  });
});

describe('webDistPath', () => {
  test('lands on web/dist inside this repo', () => {
    // The assertion that matters is the `..` COUNT: one segment too few or too
    // many still produces a plausible-looking absolute path ending in
    // `web/dist`, and `resolveWebDist` would then just return null forever and
    // the server would silently never serve the UI. Anchoring on the repo root
    // — the directory that holds the workspace manifest — is what catches it.
    const dist = webDistPath();
    expect(dist.endsWith(path.join('web', 'dist'))).toBe(true);

    const repoRoot = path.resolve(dist, '..', '..');
    expect(fs.existsSync(path.join(repoRoot, 'package.json'))).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.workspaces).toContain('web');
  });

  test('resolveWebDist returns that path, or null when unbuilt', () => {
    const resolved = resolveWebDist();
    expect(resolved === null || resolved === webDistPath()).toBe(true);
    expect(resolved === null).toBe(!fs.existsSync(path.join(webDistPath(), 'index.html')));
  });
});
