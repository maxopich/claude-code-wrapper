/**
 * `Cebab-0fgx`: the project's own CLAUDE.md reaches an untrusted turn's spawn,
 * and does NOT reach a trusted one.
 *
 * `runner/project_rules_note.test.ts` proves the spec decides correctly and
 * `runner/system_prompt_append.test.ts` proves two sections combine. Neither
 * says the pieces are connected to the product — a helper wired to nothing
 * passes every test of its parts, which is why `mcp_status_note_wiring.test.ts`
 * exists next door for the same reason. So this drives the real `send_message`
 * path with a recording runner and reads the options a turn actually got.
 *
 * THE LAST CASE IS THE ONE TO KEEP. Both producers write the SAME options key,
 * so the bug this whole design guards against is not "the rules are missing" —
 * it is "the rules AND the MCP note are each present in the source, and only
 * one of them is in the spawn". That failure leaves every other case here
 * green, leaves both spreads visible at the call site, and is invisible to any
 * test that checks one section at a time.
 *
 * The harness — mocked runner, temp dataDir, `handleClientMsg` — is lifted from
 * `mcp_status_note_wiring.test.ts` deliberately; two different fakes of the
 * same path would eventually disagree about what a turn looks like.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const spawned: Record<string, unknown>[] = [];

vi.mock('../runner/index.js', () => ({
  pickRunner: (opts: Record<string, unknown>) => {
    spawned.push(opts);
    return {
      async *[Symbol.asyncIterator]() {
        // deliberately empty
      },
      close: async () => {},
      interrupt: async () => {},
      setPermissionMode: async () => {},
    };
  },
}));

const { config } = await import('../config.js');
const { closeDb, getDb } = await import('../db.js');
const { upsertProject, setProjectTrusted } = await import('../repo/projects.js');
const { handleClientMsg } = await import('./server.js');

let tmpRoot: string;
let projectDir: string;
let originalDataDir: string;
let projectId: number;

type Conn = Parameters<typeof handleClientMsg>[0];

/** The token planted in the temp project's CLAUDE.md. Distinctive enough that
 *  its presence in the appended text cannot come from anywhere else. */
const RULE = 'Never push to main without a green gate. (BLUEBERRY-9)';

function connWith(mcpServers?: { name: string; status: string }[]): Conn {
  const authorityCache = new Map<number, { capturedAt: number; mcpServers?: typeof mcpServers }>();
  if (mcpServers !== undefined) authorityCache.set(projectId, { capturedAt: 0, mcpServers });
  return {
    ws: { readyState: 1, send: () => {} },
    authorityCache,
    inFlight: new Map(),
    pendingPermissions: new Map(),
    capturedPrompts: new Map(),
    probeScheduler: { onProjectSelected: () => {}, cancel: () => {} },
    trustGate: { pending: new Map(), denyOnce: new Set() },
    busInstallGate: { pending: new Map(), denyOnce: new Set() },
  } as unknown as Conn;
}

async function sendOneTurn(conn: Conn): Promise<Record<string, unknown>> {
  spawned.length = 0;
  await handleClientMsg(conn, {
    type: 'send_message',
    projectId,
    text: 'hello',
  } as never);
  expect(spawned).toHaveLength(1);
  return spawned[0]!;
}

const appendOf = (opts: Record<string, unknown>): string =>
  typeof opts.systemPromptAppend === 'string' ? opts.systemPromptAppend : '';

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-rules-wiring-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  projectDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  projectId = upsertProject('proj', projectDir).id;
});

afterEach(() => {
  // closeDb before rm: Windows cannot unlink an open SQLite file.
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("a project's CLAUDE.md on an ordinary turn", () => {
  test('THE BUG: an untrusted project now ships its own rules to the model', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), `# Rules\n\n${RULE}\n`, 'utf8');
    return sendOneTurn(connWith()).then((opts) => {
      // The premise of the whole fix: untrusted means the CLI reads no
      // project-scope file, so if Cebab does not carry the bytes nothing does.
      expect(opts.settingSources).toEqual(['user']);
      expect(appendOf(opts)).toContain(RULE);
    });
  });

  test('a TRUSTED project is not sent a second copy — the SDK already loaded it', async () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), `# Rules\n\n${RULE}\n`, 'utf8');
    setProjectTrusted(projectId, true);
    const opts = await sendOneTurn(connWith());
    // Measured in `src/project_rules_smoke.ts`: with 'project' in the scope set
    // the CLI reads CLAUDE.md itself. Appending it again would pay for the same
    // file twice on every turn of every trusted project.
    expect(opts.settingSources).toEqual(['user', 'project', 'local']);
    expect(appendOf(opts)).not.toContain(RULE);
  });

  test('a project with no CLAUDE.md spawns exactly as it did before this existed', async () => {
    const opts = await sendOneTurn(connWith());
    // Not "an empty append" — no key at all. The absent-vs-empty distinction is
    // the one the spreadable-spec idiom exists to preserve.
    expect(opts.systemPromptAppend).toBeUndefined();
  });

  test('an unreadable CLAUDE.md is the same as none, not a crashed turn', async () => {
    // A directory where the file should be: the reader refuses it, and a
    // project-side mistake must not be able to kill the operator's turn.
    fs.mkdirSync(path.join(projectDir, 'CLAUDE.md'));
    const opts = await sendOneTurn(connWith());
    expect(opts.systemPromptAppend).toBeUndefined();
  });

  test('BOTH sections survive together — neither producer discards the other', async () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), `# Rules\n\n${RULE}\n`, 'utf8');
    const opts = await sendOneTurn(connWith([{ name: 'gh', status: 'needs-auth' }]));
    const append = appendOf(opts);
    // Replace the composer with two spreads of the same key and exactly one of
    // these two lines reddens — which one depends on the order they are written
    // in, so both are asserted rather than the "interesting" one.
    expect(append).toContain(RULE);
    expect(append).toContain('needs-auth');
    // And the order the call site documents: standing conventions first, the
    // volatile per-turn reading last.
    expect(append.indexOf(RULE)).toBeLessThan(append.indexOf('needs-auth'));
  });
});
