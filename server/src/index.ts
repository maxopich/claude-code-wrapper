import http from 'node:http';
import express from 'express';
import { config } from './config.js';
import { closeDb, getDb } from './db.js';
import { closeLogger } from './runner/logger.js';
import { closeAllQueries } from './runner/lifecycle.js';
import { startWsServer } from './ws/server.js';
import { resolveWorkspaceRoot, workspaceRootValid } from './workspace.js';
import { authTokenPath, getAuthToken, initAuthToken } from './auth.js';
import { buildAllowedOrigins, isAllowedHost } from './origin.js';

function main(): void {
  console.log(`[cebab] starting on ${config.host}:${config.port} (mock=${config.mock})`);
  // resolveWorkspaceRoot reads from DB which requires getDb() to have run; we
  // call it after that below. Log the default here for early visibility.
  console.log(`[cebab] workspace default=${config.workspaceRootDefault}`);
  console.log(`[cebab] data=${config.dataDir}`);

  getDb();

  const root = resolveWorkspaceRoot();
  console.log(
    `[cebab] workspace=${root} (${workspaceRootValid() ? 'ok' : 'missing — set via UI'})`,
  );

  // F4: generate per-launch WS auth token before mounting routes. The token
  //     lands in ~/.cebab/auth-token (mode 0600); the browser fetches it
  //     via the Origin-gated /auth-token endpoint below, and the WS
  //     upgrade requires it as `?token=`. See server/src/auth.ts.
  initAuthToken();
  console.log(`[cebab] auth-token written to ${authTokenPath()}`);

  const allowedOrigins = buildAllowedOrigins();

  const app = express();
  app.get('/health', (_req, res) => {
    res.json({ ok: true, mock: config.mock });
  });
  app.get('/auth-token', (req, res) => {
    // Same Origin+Host gate as the WS upgrade — a browser tab from
    // another origin trying to read the token would carry a disallowed
    // Origin. Non-browser clients (smoke tests, curl) get no Origin
    // header and must read ~/.cebab/auth-token from disk instead.
    const origin = String(req.headers.origin ?? '');
    const host = String(req.headers.host ?? '');
    if (origin && !allowedOrigins.has(origin)) {
      console.warn(`[http] /auth-token reject: bad origin ${JSON.stringify(origin)}`);
      res.status(403).end();
      return;
    }
    if (!isAllowedHost(host)) {
      console.warn(`[http] /auth-token reject: bad host ${JSON.stringify(host)}`);
      res.status(403).end();
      return;
    }
    // Empty Origin: a non-browser local client. Same trust model as the
    // WS upgrade — they could read the file directly anyway if running
    // under the operator's uid, so this branch isn't a hole.
    if (!origin) {
      console.warn('[http] /auth-token: serving to empty-Origin client');
    }
    // CORS: in dev the web origin is :5173 but the API is :4319, so a
    // bare fetch fails the browser's same-origin check. Echo back the
    // (already allow-listed above) Origin so the browser permits the
    // page to read the response. No preflight is involved — the fetch
    // sends no custom headers.
    if (origin) {
      // Reflective CORS is the canonical safe pattern when the value is
      // already gated against allowedOrigins (line 46 above). Semgrep's
      // generic rule can't see the upstream check.
      // nosemgrep: javascript.express.security.cors-misconfiguration.cors-misconfiguration
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.type('text/plain').send(getAuthToken());
  });

  const server = http.createServer(app);
  const wss = startWsServer(server);

  server.listen(config.port, config.host, () => {
    console.log(`[cebab] listening at http://${config.host}:${config.port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[cebab] received ${signal}, shutting down`);
    closeAllQueries();
    wss.clients.forEach((c) => c.terminate());
    wss.close();
    server.close(() => {
      closeLogger();
      closeDb();
      console.log('[cebab] bye');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
