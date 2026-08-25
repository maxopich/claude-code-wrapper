/**
 * LIVE: does the per-hop turn cap actually bind a bus hop?
 *
 *     npm --workspace server exec tsx src/bus_max_turns_smoke.ts
 *
 * `Cebab-vie.17` gave bus hops a `maxTurns` they never had. Every unit test
 * for it asserts on the CAPTURED options object, and it has to: `runMock`
 * type-accepts `maxTurns` and ignores it (grep it — there is no occurrence),
 * so no replay can ever produce an `error_max_turns` result. That means the
 * whole suite would stay green if the value reached the SDK and the SDK did
 * nothing with it, or if the key were spelled in a way `buildSdkOptions`
 * drops. This smoke is the one measurement that closes that gap, which is why
 * it exists rather than being one more mocked case.
 *
 * It spends ONE short capped turn. Self-contained: it builds its own throwaway
 * data dir and worker cwd, so it never touches `~/.cebab` or a real project.
 *
 * Measured note the wording depends on: the SDK reports `num_turns` ONE HIGHER
 * than the cap (3 against a cap of 2). Re-run this if that ever changes — the
 * sentinel's sentence reads "cap of N (M ran)" because of it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-cap-smoke-'));
// BEFORE the first import that reads it — `config.dataDir` is captured at
// module init, and ESM hoists imports above any assignment written up here.
process.env.CEBAB_DATA_DIR = path.join(tmpRoot, '.cebab');

const { config } = await import('./config.js');
const { getDb } = await import('./db.js');
const { wireOrchestratorSession } = await import('./bus/orchestrator.js');
const { computeSessionPaths } = await import('./bus/paths.js');
const { createMultiAgentSession, listMultiAgentEvents, getPendingRetry } =
  await import('./repo/multi_agent.js');
const { upsertProject } = await import('./repo/projects.js');
const { verifyChain } = await import('./notifications/safety_audit.js');
const { unregisterLiveSession } = await import('./bus/session_registry.js');

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

const workerDir = path.join(tmpRoot, 'worker');
fs.mkdirSync(workerDir, { recursive: true });
for (const n of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
  fs.writeFileSync(path.join(workerDir, n), `contents of ${n}\n`);
}

getDb();
const sessionId = `cap-smoke-${process.pid}`;
createMultiAgentSession(sessionId, 'orchestrator', 'iter-1');
const paths = computeSessionPaths(sessionId);
fs.mkdirSync(paths.iterationDir('iter-1'), { recursive: true });
const proj = upsertProject('cap-smoke-worker', workerDir);

const { deliver } = wireOrchestratorSession({
  sessionId,
  iterationId: 'iter-1',
  lifecycle: 'temp',
  paths,
  workers: [
    { projectId: proj.id, agentName: 'probe', cwd: workerDir, projectName: 'cap-smoke-worker' },
  ],
  onEvent: () => {},
  onEnded: () => {},
  hopBudget: 1000,
  maxTurns: MAX_TURNS,
  sendServerMsg: () => {},
});

// A task that cannot finish inside the cap: one Read per turn, four files.
deliver(
  'probe',
  'Read the files in this directory ONE AT A TIME with the Read tool — exactly one tool ' +
    'call per turn, describing each file before reading the next. Do not batch. Only when ' +
    'every file is read, call bus_send to report.',
);

await new Promise((r) => setTimeout(r, 120_000));

const rows = getDb()
  .prepare(
    `SELECT kind, reason_code, agent_id, payload_json FROM safety_audit WHERE kind = 'max_turns.hit'`,
  )
  .all() as Array<{ kind: string; reason_code: string; agent_id: string; payload_json: string }>;

check(rows.length === 1, `exactly one max_turns.hit audit row (got ${rows.length})`);
if (rows[0]) {
  const payload = JSON.parse(rows[0].payload_json) as Record<string, unknown>;
  console.log(`     payload: ${rows[0].payload_json}`);
  check(rows[0].agent_id === 'probe', 'the row names the agent that hit the cap');
  check(payload.surface === 'bus', "payload.surface is 'bus'");
  check(
    payload.effectiveMaxTurns === MAX_TURNS,
    `the cap the SDK was given is what was recorded (${String(payload.effectiveMaxTurns)})`,
  );
  check(
    typeof payload.numTurns === 'number' && payload.numTurns >= MAX_TURNS,
    `the SDK ran at least the cap before stopping (num_turns=${String(payload.numTurns)})`,
  );
}
check(verifyChain().ok, 'the hash chain still verifies');

const errText = listMultiAgentEvents(sessionId)
  .filter((e) => e.kind === 'error')
  .map((e) => e.text)
  .join('\n');
check(errText.includes('turn cap'), 'the operator is told a cap stopped the turn');
check(!errText.includes('subtype='), 'and not shown the raw SDK enum');
check(getPendingRetry(sessionId) !== null, 'a retry slot is parked so the work can continue');

unregisterLiveSession(sessionId);
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(failures.length === 0 ? '\nsmoke: PASS' : `\nsmoke: FAIL — ${failures.join('; ')}`);
process.exit(failures.length === 0 ? 0 : 1);
