/**
 * LIVE: does the pending-retry QUEUE behave like a queue against the real SDK?
 *
 *     npm --workspace server exec tsx src/bus_pending_retry_queue_smoke.ts
 *
 * Migration 041 made the slot a per-agent queue; `Cebab-6c1m` / `Cebab-mnba`
 * moved both routers off the single-slot questions they were still asking of
 * it. The unit tests drive `onWorkerFailed` / `onTurnSucceeded` directly, which
 * is the right instrument for the branch logic and a wholly synthetic one for
 * the premise underneath it: that two workers can be in flight and fail
 * independently, and that a real resolved turn calls `onTurnSucceeded` with the
 * name of an agent that is NOT at the front. Neither can be replayed — mock
 * mode ignores `maxTurns`, so no fixture produces a failing turn at all.
 *
 * Three short capped turns. Self-contained: its own throwaway data dir and
 * worker cwds, so it never touches `~/.cebab` or a real project.
 *
 * DELIVERY ORDER IS NOT FAILURE ORDER, and this smoke learned that the hard
 * way — its first run delivered `alpha` then `beta`, asserted `alpha` owned the
 * front, and watched `beta` hit the cap first. Two concurrent turns race, and
 * which one exhausts its cap first is the SDK's business. So nothing below
 * names an agent: the front is read back from the queue and the recovery is
 * aimed at whatever sits BEHIND it. Hard-coding the names turns this smoke into
 * a coin flip that reddens on a correct fix.
 *
 * The anti-vacuity check is `parked.length === 2`, asserted before anything
 * about order and fatal on its own: with one row the front and the newest
 * failure are the same agent, so every check below would pass on a session that
 * never exercised the queue at all.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-retryq-smoke-'));
// BEFORE the first import that reads it — `config.dataDir` is captured at
// module init, and ESM hoists imports above any assignment written up here.
process.env.CEBAB_DATA_DIR = path.join(tmpRoot, '.cebab');

const { config } = await import('./config.js');
const { getDb } = await import('./db.js');
const { wireOrchestratorSession } = await import('./bus/orchestrator.js');
const { computeSessionPaths } = await import('./bus/paths.js');
const { createMultiAgentSession, listPendingRetries } = await import('./repo/multi_agent.js');
const { upsertProject } = await import('./repo/projects.js');
const { unregisterLiveSession } = await import('./bus/session_registry.js');
import type { PendingRetryDescriptor } from '@cebab/shared/protocol';

const MAX_TURNS = 2;
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

if (config.mock) {
  console.error('smoke: this measures the REAL SDK; unset MOCK and re-run.');
  process.exit(1);
}

/** A worker cwd with four files — enough that one Read per turn cannot finish. */
function makeWorkerDir(name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
    fs.writeFileSync(path.join(dir, n), `contents of ${n}\n`);
  }
  return dir;
}

const CANNOT_FINISH =
  'Read the files in this directory ONE AT A TIME with the Read tool — exactly one tool ' +
  'call per turn, describing each file before reading the next. Do not batch. Only when ' +
  'every file is read, call bus_send to report.';

getDb();
const sessionId = `retryq-smoke-${process.pid}`;
createMultiAgentSession(sessionId, 'orchestrator', 'iter-1');
const paths = computeSessionPaths(sessionId);
fs.mkdirSync(paths.iterationDir('iter-1'), { recursive: true });

const workers = ['alpha', 'beta'].map((agentName) => {
  const cwd = makeWorkerDir(agentName);
  const projectName = `retryq-smoke-${agentName}`;
  return { projectId: upsertProject(projectName, cwd).id, agentName, cwd, projectName };
});

const emitted: Array<PendingRetryDescriptor | null> = [];

const { deliver } = wireOrchestratorSession({
  sessionId,
  iterationId: 'iter-1',
  lifecycle: 'temp',
  paths,
  workers,
  onEvent: () => {},
  onEnded: () => {},
  onPendingRetry: (_sid, pending) => emitted.push(pending),
  hopBudget: 1000,
  maxTurns: MAX_TURNS,
  sendServerMsg: () => {},
});

// Both in flight at once — production's shape, and the whole premise.
for (const w of workers) deliver(w.agentName, CANNOT_FINISH);

await new Promise((r) => setTimeout(r, 180_000));

const parked = listPendingRetries(sessionId);
console.log(`     queue: [${parked.map((p) => p.agentName).join(', ')}]`);
check(parked.length === 2, `both failures parked their own row (got ${parked.length})`);
if (parked.length !== 2) {
  console.log('\nsmoke: FAIL — no queue to measure; every check below would be vacuous.');
  unregisterLiveSession(sessionId);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(1);
}

// Read the front back rather than assuming it. `listPendingRetries` orders by
// `ts ASC, rowid ASC`, so this IS "whichever failed first".
const front = parked[0]!.agentName;
const behind = parked[1]!.agentName;
console.log(`     front=${front} behind=${behind}`);

// The wire carries ONE descriptor, so the second failure must NOT displace the
// banner the operator is already looking at. `Cebab-6c1m` in chain; asserted
// here for the orchestrator because it is the router this smoke can drive.
console.log(`     emits: [${emitted.map((e) => e?.agentName ?? 'null').join(', ')}]`);
check(emitted.length === 2, `one emit per failure (got ${emitted.length})`);
check(
  emitted[emitted.length - 1]?.agentName === front,
  `the second failure left the FRONT (${front}) on the banner`,
);

// `Cebab-mnba`: a real resolved turn for the agent BEHIND the front. A prompt
// that needs no tool call finishes inside the cap.
emitted.length = 0;
deliver(behind, 'Reply with the single word: done. Do not use any tool.');
await new Promise((r) => setTimeout(r, 120_000));

const afterRecovery = listPendingRetries(sessionId);
console.log(`     queue: [${afterRecovery.map((p) => p.agentName).join(', ')}]`);
check(
  afterRecovery.length === 1 && afterRecovery[0]?.agentName === front,
  `${behind}'s row is reaped, ${front}'s survives`,
);
check(emitted.length === 0, 'and the wire stays quiet, because the front did not move');

unregisterLiveSession(sessionId);
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(failures.length === 0 ? '\nsmoke: PASS' : `\nsmoke: FAIL — ${failures.join('; ')}`);
process.exit(failures.length === 0 ? 0 : 1);
