import http from 'node:http';
import express from 'express';
import { config } from './config.js';
import { closeDb, getDb } from './db.js';
import { closeLogger } from './runner/logger.js';
import { closeAllQueries } from './runner/lifecycle.js';
import { startWsServer } from './ws/server.js';
import { resolveWorkspaceRoot, workspaceRootValid } from './workspace.js';

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

  const app = express();
  app.get('/health', (_req, res) => {
    res.json({ ok: true, mock: config.mock });
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
