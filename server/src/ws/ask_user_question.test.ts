/**
 * `Cebab-uhn2`: the single-agent `AskUserQuestion` gate.
 *
 * WHAT WAS WRONG, and therefore what the first case here has to catch. The tool
 * is on every ordinary turn's tool list and the model does call it, but the
 * single-agent path had no handling for it, so it fell through to the ordinary
 * permission gate. On a TRUSTED project — the default posture, and the one a
 * production operator is most likely to be on — `shouldAutoAllow` returns true
 * for every tool, so the call was auto-allowed with no card at all, and the
 * model got back the literal string "The user did not answer the questions."
 * (measured against the bundled CLI). The operator was never asked anything.
 *
 * So the load-bearing assertion is not "a card appears". It is that a card
 * appears ON A TRUSTED PROJECT AT `acceptEdits`, where the auto-allow would
 * otherwise have swallowed it. A suite that only exercised `default` mode would
 * pass on the broken implementation.
 *
 * The harness drives the REAL `send_message` path with a mocked runner and then
 * calls the `canUseTool` the turn was actually spawned with — the same shape as
 * `mcp_status_note_wiring.test.ts` next door, and for the same reason: a gate
 * wired to nothing passes every test of its parts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';

const spawned: Record<string, unknown>[] = [];

vi.mock('../runner/index.js', () => ({
  pickRunner: (opts: Record<string, unknown>) => {
    spawned.push(opts);
    return {
      async *[Symbol.asyncIterator]() {
        // no messages: the turn only needs to spawn and close for the gate to
        // have been committed to the runner options.
      },
      close: async () => {},
      interrupt: async () => {},
      setPermissionMode: async () => {},
    };
  },
}));

const { config } = await import('../config.js');
const { closeDb, getDb } = await import('../db.js');
const { closeLogger } = await import('../runner/logger.js');
const { upsertProject, setProjectTrusted } = await import('../repo/projects.js');
const { handleClientMsg, drainParkedQuestionsForSessions } = await import('./server.js');
const {
  listParkedQuestions,
  resolveQuestion,
  parkQuestion,
  __clearAllParkedQuestions,
  ASK_USER_MALFORMED_TEXT,
  ASK_USER_DISMISSED_TEXT,
} = await import('../bus/pending_questions.js');

type Conn = Parameters<typeof handleClientMsg>[0];
type Decision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };
type Gate = (
  tool: string,
  input: Record<string, unknown>,
  opts?: { toolUseID?: string },
) => Promise<Decision>;

let tmpRoot: string;
let originalDataDir: string;
let projectId: number;
let sent: ServerMsg[];

function makeConn(): Conn {
  sent = [];
  return {
    ws: {
      readyState: 1,
      send: (raw: string) => {
        sent.push(JSON.parse(raw) as ServerMsg);
      },
    },
    authorityCache: new Map(),
    inFlight: new Map(),
    pendingPermissions: new Map(),
    capturedPrompts: new Map(),
    probeScheduler: { onProjectSelected: () => {}, cancel: () => {} },
    trustGate: { pending: new Map(), denyOnce: new Set() },
    busInstallGate: { pending: new Map(), denyOnce: new Set() },
  } as unknown as Conn;
}

/** Spawn one turn and hand back the gate it was built with, plus its session. */
async function gateFor(conn: Conn): Promise<{ gate: Gate; sessionId: string }> {
  spawned.length = 0;
  await handleClientMsg(conn, { type: 'send_message', projectId, text: 'hi' } as never);
  expect(spawned).toHaveLength(1);
  const opts = spawned[0]!;
  return { gate: opts.canUseTool as Gate, sessionId: opts.sessionId as string };
}

const ONE_QUESTION = {
  questions: [
    {
      question: 'Which database?',
      header: 'DB',
      multiSelect: false,
      options: [{ label: 'Postgres' }, { label: 'SQLite', description: 'embedded' }],
    },
  ],
};

function cardsIn(msgs: ServerMsg[]): Extract<ServerMsg, { type: 'ask_user_question' }>[] {
  return msgs.filter(
    (m): m is Extract<ServerMsg, { type: 'ask_user_question' }> => m.type === 'ask_user_question',
  );
}

beforeEach(() => {
  __clearAllParkedQuestions();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-askq-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  const projectDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  projectId = upsertProject('proj', projectDir).id;
});

afterEach(async () => {
  __clearAllParkedQuestions();
  closeDb();
  // `Cebab-kji`, re-learned the hard way: BEFORE the rmSync, and awaited.
  // A turn here persists through the transcript logger, which keeps a
  // module-level map of write streams pointing into this directory and opens
  // each fd on a later tick. Removing the directory first races that open, and
  // the stream's `'error'` handler then logs AFTER the test has finished —
  // which vitest reports as `EnvironmentTeardownError: Closing rpc while
  // "onUserConsoleLog" was pending` and which fails the WHOLE run with every
  // test green. Observed exactly that way on CI (ubuntu, `test:security`:
  // 136 files passed, run exit 1, blamed on this file).
  //
  // This hand-rolled preamble is why: `withTempDataDir` in `test_support/`
  // already does this, and copying the twelve lines instead of calling it
  // copied everything except the one line that matters. Cheap when nothing
  // logged — with no streams open it resolves without waiting.
  await closeLogger();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('a question reaches the operator instead of being auto-allowed', () => {
  test('THE BUG: a TRUSTED project at acceptEdits still shows the card', async () => {
    // Trust is what made this invisible: `shouldAutoAllow(true, 'acceptEdits', …)`
    // returns true for EVERY tool. If the AskUserQuestion branch ever moves
    // below that check, this case goes red and the rest of the file does not.
    setProjectTrusted(projectId, true);
    const conn = makeConn();
    const { gate, sessionId } = await gateFor(conn);

    const pending = gate('AskUserQuestion', ONE_QUESTION, { toolUseID: 'tu-1' });
    await vi.waitFor(() => expect(cardsIn(sent)).toHaveLength(1));

    const card = cardsIn(sent)[0]!;
    expect(card.toolUseId).toBe('tu-1');
    expect(card.agent).toBe('proj');
    expect(card.questions[0]!.question).toBe('Which database?');
    // The turn really is parked — not allowed-and-forgotten.
    expect(listParkedQuestions(sessionId)).toHaveLength(1);

    resolveQuestion(sessionId, 'tu-1', 'The user answered:\n• Which database?\n  → Postgres');
    const decision = await pending;
    // A DENY carrying the answer is the mechanism: it is the only channel by
    // which canUseTool can put text in front of the model. An `allow` here is
    // exactly the old behaviour, and the model would receive "The user did not
    // answer the questions."
    expect(decision.behavior).toBe('deny');
    expect(decision).toMatchObject({ message: expect.stringContaining('Postgres') });
  });

  test('an untrusted project at default mode shows the same card', async () => {
    const conn = makeConn();
    const { gate, sessionId } = await gateFor(conn);
    const pending = gate('AskUserQuestion', ONE_QUESTION, { toolUseID: 'tu-2' });
    await vi.waitFor(() => expect(cardsIn(sent)).toHaveLength(1));
    // and it is NOT the ordinary permission card — that one cannot be answered.
    expect(sent.filter((m) => m.type === 'permission_request')).toHaveLength(0);
    resolveQuestion(sessionId, 'tu-2', 'answered');
    await expect(pending).resolves.toMatchObject({ behavior: 'deny', message: 'answered' });
  });

  test('a malformed call is refused WITHOUT parking and without a card', async () => {
    // Every field is model-authored, so this is reachable with nothing wrong in
    // Cebab. Parking on it would put an unanswerable card on screen and block
    // the turn behind it.
    setProjectTrusted(projectId, true);
    const conn = makeConn();
    const { gate, sessionId } = await gateFor(conn);
    const decision = await gate('AskUserQuestion', { questions: 'not-an-array' });
    expect(decision).toEqual({ behavior: 'deny', message: ASK_USER_MALFORMED_TEXT });
    expect(listParkedQuestions(sessionId)).toHaveLength(0);
    expect(cardsIn(sent)).toHaveLength(0);
  });

  test('every OTHER tool is untouched — a trusted acceptEdits turn still auto-allows', async () => {
    // The anti-vacuity control. An implementation that parked everything, or
    // that broke the auto-allow while adding this branch, would pass every case
    // above and fail here.
    setProjectTrusted(projectId, true);
    const conn = makeConn();
    const { gate } = await gateFor(conn);
    await expect(gate('Bash', { command: 'ls' })).resolves.toMatchObject({ behavior: 'allow' });
    expect(cardsIn(sent)).toHaveLength(0);
  });
});

describe('answering, and the guards around it', () => {
  test('[security] an answer for a session this connection is not running is ignored', async () => {
    // `pending_questions` is ONE process-wide registry shared with the bus, and
    // `resolveQuestion` is keyed by (sessionId, toolUseId) alone — it cannot
    // tell which path parked an entry. Without the `inFlight` guard in the
    // handler, this verb would answer a BUS question while skipping the bus's
    // own persistence, and that run's scrollback would silently lose the answer
    // that steered it.
    const conn = makeConn();
    const busish = parkQuestion('bus-session', {
      agent: 'scribe',
      toolUseId: 'tu-bus',
      questions: [],
    });
    let settled = false;
    void busish.then(() => {
      settled = true;
    });

    await handleClientMsg(conn, {
      type: 'ask_user_answer',
      sessionId: 'bus-session',
      toolUseId: 'tu-bus',
      answers: { q: 'a' },
    } as never);

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(listParkedQuestions('bus-session')).toHaveLength(1);
    expect(sent.filter((m) => m.type === 'ask_user_resolved')).toHaveLength(0);
  });

  test('an answer for a live single-agent turn resolves it and echoes _resolved', async () => {
    // The positive control for the case above: same verb, same shape, and the
    // only difference is that this session IS one this connection is running.
    const conn = makeConn();
    const { gate, sessionId } = await gateFor(conn);
    // The turn has ended in this harness, so re-arm the one fact the guard
    // reads. (In production the turn is still in flight while the card is up.)
    (conn.inFlight as Map<string, unknown>).set(sessionId, {});
    const pending = gate('AskUserQuestion', ONE_QUESTION, { toolUseID: 'tu-3' });
    await vi.waitFor(() => expect(cardsIn(sent)).toHaveLength(1));

    await handleClientMsg(conn, {
      type: 'ask_user_answer',
      sessionId,
      toolUseId: 'tu-3',
      answers: { 'Which database?': 'SQLite' },
    } as never);

    await expect(pending).resolves.toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('SQLite'),
    });
    expect(sent.filter((m) => m.type === 'ask_user_resolved')).toHaveLength(1);
  });
});

describe('draining a parked question', () => {
  test('a drain unblocks the SDK and clears the card', async () => {
    const conn = makeConn();
    const { gate, sessionId } = await gateFor(conn);
    const pending = gate('AskUserQuestion', ONE_QUESTION, { toolUseID: 'tu-4' });
    await vi.waitFor(() => expect(cardsIn(sent)).toHaveLength(1));

    const drained = drainParkedQuestionsForSessions([sessionId], 'turn ended', (m) => sent.push(m));
    expect(drained).toBe(1);
    // The turn must not stay blocked on an operator who has gone.
    await expect(pending).resolves.toEqual({
      behavior: 'deny',
      message: ASK_USER_DISMISSED_TEXT,
    });
    expect(sent.filter((m) => m.type === 'ask_user_resolved')).toHaveLength(1);
  });

  test('[security] draining one session leaves another session’s question parked', async () => {
    // The socket-close drain passes `conn.inFlight.keys()`, not "everything
    // parked". A bus question deliberately OUTLIVES a browser disconnect (R-A),
    // so a blanket drain would cancel a live bus run because an unrelated chat
    // tab closed.
    const other = parkQuestion('bus-session', {
      agent: 'scribe',
      toolUseId: 'tu-other',
      questions: [],
    });
    let otherSettled = false;
    void other.then(
      () => {
        otherSettled = true;
      },
      () => {
        otherSettled = true;
      },
    );

    const conn = makeConn();
    const { gate, sessionId } = await gateFor(conn);
    void gate('AskUserQuestion', ONE_QUESTION, { toolUseID: 'tu-5' });
    await vi.waitFor(() => expect(cardsIn(sent)).toHaveLength(1));

    expect(drainParkedQuestionsForSessions([sessionId], 'client disconnected')).toBe(1);
    await Promise.resolve();
    expect(otherSettled).toBe(false);
    expect(listParkedQuestions('bus-session')).toHaveLength(1);
  });
});
