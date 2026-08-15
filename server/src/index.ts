import http from 'node:http';
import express from 'express';
import { config } from './config.js';
import { closeDb, declareRealDataDirIntent, getDb, resolveMigrationsDir } from './db.js';
import { runDataPermsBootCheck } from './data_perms_boot.js';
import { closeLogger } from './runner/logger.js';
import { closeAllQueries } from './runner/lifecycle.js';
import { verifyChain } from './notifications/safety_audit.js';
import { runMigrationIntegrityBootCheck } from './migration_integrity.js';
import { emit as emitNotification } from './notifications/dispatcher.js';
import { describeChainFailure, startWsServer } from './ws/server.js';
import { createShutdown, registerSignalHandlers } from './shutdown.js';
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

  // The server is the ONE process entitled to open the operator's real
  // ~/.cebab. Everything else — smoke scripts, benchmarks, one-off tsx files —
  // must point CEBAB_DATA_DIR at a scratch directory, and `getDb()` refuses
  // otherwise. See `declareRealDataDirIntent` for the incident that made this
  // a guard rather than a convention.
  declareRealDataDirIntent();
  getDb();

  // Register H01: bring `~/.cebab` to owner-only. `getDb()` above already
  // created the directory and the database with the right modes, but that does
  // nothing for an install written by an earlier build — `mkdirSync` ignores
  // its `mode` for a directory that already exists. This is the retrofit, and
  // it is what actually protects the database you already have.
  //
  // Must run after `getDb()`: the "have I already swept?" flag lives in the
  // `settings` table. Everything — the sweep decision, the log line, and the
  // notification when it could not finish — sits behind this one call, because
  // `main()` is not reachable from a unit test and a sequence here could
  // silently lose a step.
  runDataPermsBootCheck();

  // Cluster A Phase 1: walk the safety_audit hash chain at boot. The walk is
  // cheap (the genesis marker anchors verification, so the chain length equals
  // real-event count since the last migration).
  //
  // A failure now emits an `audit.tamper_detected` safety notification, not
  // just a stderr line: `emit()` persists the row (sticky) and the operator
  // picks it up from the inbox snapshot seeded on WS connect. There is no WS
  // client at boot, so `send` is a no-op — persistence is what carries it.
  //
  // Boot deliberately CONTINUES. Refusing to start on a suspected tamper turns
  // this fail-open into a fail-closed that bricks the whole app over a stale
  // marker allowlist; "refuse further safety emissions until acknowledged" is
  // still Phase 3 and still unimplemented.
  const chainResult = verifyChain();
  if (chainResult.ok) {
    console.log(`[cebab] safety_audit chain ok (${chainResult.rowsChecked} rows)`);
  } else {
    const where = chainResult.brokenAt ? ` at ${chainResult.brokenAt}` : '';
    console.error(`[cebab] safety_audit chain BROKEN (${chainResult.reason})${where}`);
    const result = emitNotification(
      {
        severity: 'danger',
        class: 'safety',
        dedupeKey: 'audit.tamper_detected',
        title: 'Safety audit chain failed verification',
        // H07: shared with the attach path so boot and re-verify cannot drift
        // into describing the same condition differently.
        message: describeChainFailure(chainResult.reason, chainResult.brokenAt),
        reasonCode: chainResult.reason,
        auditKind: 'audit.tamper_detected',
        auditPayload: { reason: chainResult.reason, brokenAt: chainResult.brokenAt ?? null },
      },
      () => {},
    );
    if (!result.ok) {
      // The audit append itself failed — the chain is unwritable as well as
      // unverifiable. Nothing left but the log line.
      console.error(`[cebab] could not record tamper notification: ${result.error}`);
    }
  }

  // Cebab-x1n.7.31: has an already-applied migration been edited since it was
  // applied? The runner keys on filename alone, so without this an edited
  // `.sql` splits installs silently — old schema here, new schema on a fresh
  // install, identical ledgers on both. Everything (the log lines, the ONE
  // safety notification, and the decision to carry on booting) sits behind
  // this call for the same reason `runDataPermsBootCheck` does: `main()` is
  // not reachable from a unit test.
  runMigrationIntegrityBootCheck({ db: getDb(), migrationsDir: resolveMigrationsDir() });

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

  // Register C15: the sequence lives in `shutdown.ts` so it can be tested.
  // It used to be a closure over these four locals inside `main()`, and
  // `main()` runs on import — so the drain that keeps `claude` subprocesses
  // from outliving the server (and spending quota) was unreachable from any
  // test. The signal list, the ordering, and the re-entrancy guard are pinned
  // in `shutdown.test.ts`.
  const shutdown = createShutdown({
    stopSessionPurgeCron,
    closeAllQueries,
    terminateClients: () => wss.clients.forEach((c) => c.terminate()),
    closeWss: () => wss.close(),
    closeServer: (cb) => server.close(cb),
    closeLogger,
    closeDb,
    exit: (code) => process.exit(code),
  });

  registerSignalHandlers(shutdown);

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
