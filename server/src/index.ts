import http from 'node:http';
import express from 'express';
import { config } from './config.js';
import { closeDb, getDb } from './db.js';
import { closeLogger } from './runner/logger.js';
import { closeAllQueries } from './runner/lifecycle.js';
import { verifyChain } from './notifications/safety_audit.js';
import { startWsServer } from './ws/server.js';
import { resolveWorkspaceRoot, workspaceRootValid } from './workspace.js';
import { authTokenPath, initAuthToken } from './auth.js';
import { mountAuthTokenRoute } from './auth_token_route.js';
import { mountSessionLogExport } from './session_log_export.js';
import { getSession } from './repo/sessions.js';
import { getMultiAgentSession } from './repo/multi_agent.js';
import { startSessionPurgeCron } from './bulk_session_op.js';

function main(): void {
  console.log(`[cebab] starting on ${config.host}:${config.port} (mock=${config.mock})`);
  // resolveWorkspaceRoot reads from DB which requires getDb() to have run; we
  // call it after that below. Log the default here for early visibility.
  console.log(`[cebab] workspace default=${config.workspaceRootDefault}`);
  console.log(`[cebab] data=${config.dataDir}`);

  getDb();

  // Cluster A Phase 1: walk the safety_audit hash chain at boot. Phase 1
  // just logs the outcome — a broken chain in Phase 3 will additionally
  // emit an `audit.tamper_detected` danger notification and refuse further
  // safety emissions until acknowledged. The walk is cheap (the genesis
  // marker anchors verification, so the chain length equals real-event
  // count since the last migration).
  const chainResult = verifyChain();
  if (chainResult.ok) {
    console.log(`[cebab] safety_audit chain ok (${chainResult.rowsChecked} rows)`);
  } else {
    console.error(`[cebab] safety_audit chain BROKEN at ${chainResult.brokenAt}`);
  }

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

  const app = express();
  app.get('/health', (_req, res) => {
    res.json({ ok: true, mock: config.mock });
  });
  mountAuthTokenRoute(app);

  // Cluster I C2 backend: per-session JSONL download. Reads the on-disk
  // log written by runner/logger.ts, applies LogsModal redaction line by
  // line (default), and serves with Content-Disposition: attachment.
  // Gated on the same Origin+Host+token as /auth-token; raw exports
  // additionally require an X-Cebab-Acknowledge-Raw header set by the
  // operator-facing typed-confirmation modal (slice 2). Every export
  // writes a forensic safety_audit row before the body streams.
  mountSessionLogExport(app, {
    getSessionStartMs: (sid: string): number | null => {
      // Single-agent sessions: sessions.created_at. Multi-agent: their
      // own table. Either one is fine for the export filename label;
      // we check single first because that's where logger.ts writes
      // JSONLs today (multi-agent rows live in the DB, not on disk —
      // so the lookup for a multi-agent sid lands on a missing file
      // before the filename matters). Falling back to null lets
      // exportFilename use Date.now() as a last resort.
      const s = getSession(sid);
      if (s) return s.created_at;
      const m = getMultiAgentSession(sid);
      if (m) return m.started_at;
      return null;
    },
  });

  const server = http.createServer(app);
  const wss = startWsServer(server);

  // Cluster I Phase C5 (UI_Findings spec §4.3): boot the 7-day soft-delete
  // purge cron. Fires once now, then every 6h. The cron is `.unref()`'d
  // inside startSessionPurgeCron so it won't keep the process alive if
  // everything else has shut down, but we still hold the disposer so the
  // graceful shutdown path can stop it cleanly.
  const stopSessionPurgeCron = startSessionPurgeCron();

  server.listen(config.port, config.host, () => {
    console.log(`[cebab] listening at http://${config.host}:${config.port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[cebab] received ${signal}, shutting down`);
    stopSessionPurgeCron();
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
  // Windows: Ctrl+Break (and `taskkill` without /F) raises SIGBREAK, and
  // SIGTERM is never delivered there. Registering SIGBREAK gives the same
  // graceful drain (closeAllQueries → reap claude subprocesses) on Windows
  // that SIGINT/SIGTERM give on POSIX. Harmless no-op on non-Windows
  // (the signal is simply never emitted).
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));

  // Last-resort containment: a stray unhandled rejection or uncaught exception
  // must NOT take down the whole server. The motivating case is the multi-agent
  // bus — closing a wedged worker Query rejects its in-flight control/MCP
  // promises with "Query closed before response received", and Node's default is
  // to terminate the process on an unhandled rejection. One background worker's
  // teardown should never kill the operator's session (and every sibling agent
  // with it), so we log and stay up. Deliberate posture for a local single-user
  // tool; revisit if it ever masks real state corruption.
  process.on('unhandledRejection', (reason) => {
    console.error('[cebab] unhandledRejection (contained; server stays up)', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[cebab] uncaughtException (contained; server stays up)', err);
  });
}

main();
