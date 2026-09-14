import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import type { MockOptions, RunOptions, Runner } from '../runner/index.js';
import { upsertProject, setProjectTrusted } from '../repo/projects.js';
import {
  busSettingScopesFor,
  resolveProjectAuthority,
  trustDerivedScopes,
} from '../repo/project_authority.js';
import { AgentRunner } from './runner.js';

// [security] Cebab-6fax.21.1 — a bus participant's setting scopes FOLLOW its
// project's Trust, and the scopes it SPAWNS with are the SAME function of Trust
// as the scopes its spawn GATE resolves against. Both go through the one
// exported `busSettingScopesFor`, so they can never disagree — the divergence
// that previously let an UNTRUSTED worker's project MCP servers, `env:` block
// and hooks load with all three layers while its Trust toggle said `['user']`,
// and the gate (resolving trust-derived) saw nothing to prompt about.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpRoot: string;
let projectDir: string;
let originalDataDir: string;
let projectId: number;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-scope-conf-'));
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

function fakeRunner(messages: SDKMessage[]): Runner {
  async function* gen(): AsyncGenerator<SDKMessage> {
    for (const m of messages) yield m;
  }
  const it = gen();
  return { [Symbol.asyncIterator]: () => it, close: () => {} };
}

function resultMsg(sessionId: string): SDKMessage {
  return { type: 'result', subtype: 'success', session_id: sessionId } as unknown as SDKMessage;
}

/**
 * Register one participant rooted in `projectId` and capture the RunOptions its
 * next hop spawns with. `registerScopes`, if given, is put on the spec's
 * `settingSources` — DELIBERATELY MISMATCHED from the project's trust-derived
 * value by the callers below. The point is that a `projectId`-bearing spec
 * derives its scopes from Trust at turn time and IGNORES whatever
 * `settingSources` the spec carries; the pre-fix runner instead passed
 * `spec.settingSources ?? ['user']` straight through, so asserting the
 * trust-derived value reddens on revert (the old passthrough surfaces the
 * mismatched register value). Omit it and the fallback is `['user']`.
 */
async function captureSpawnOptions(
  registerScopes?: readonly ('user' | 'project' | 'local')[],
): Promise<RunOptions & Partial<MockOptions>> {
  const calls: (RunOptions & Partial<MockOptions>)[] = [];
  const runner = new AgentRunner({
    onEvent: () => {},
    runnerFactory: (opts) => {
      calls.push(opts);
      return fakeRunner([resultMsg('sess-conf')]);
    },
  });
  runner.register({
    name: 'worker',
    cwd: projectDir,
    projectId,
    ...(registerScopes ? { settingSources: [...registerScopes] } : {}),
  });
  await runner.deliverTurn('worker', 'go');
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

/** A spec `settingSources` guaranteed to differ from `trust`'s derived value,
 *  so the runner's trust-override is observable (and the pre-fix passthrough
 *  would surface THIS instead). */
function mismatchedScopes(trusted: boolean): ('user' | 'project' | 'local')[] {
  return trusted ? ['user'] : ['user', 'project', 'local'];
}

describe('[security] busSettingScopesFor is the trust-derived scope function', () => {
  test('untrusted → ["user"], trusted → all three, matching trustDerivedScopes', () => {
    setProjectTrusted(projectId, false);
    expect(busSettingScopesFor(projectId)).toEqual(['user']);
    expect(busSettingScopesFor(projectId)).toEqual(trustDerivedScopes(false));

    setProjectTrusted(projectId, true);
    expect(busSettingScopesFor(projectId)).toEqual(['user', 'project', 'local']);
    expect(busSettingScopesFor(projectId)).toEqual(trustDerivedScopes(true));
  });

  test('a missing project row resolves to the safe untrusted default', () => {
    expect(busSettingScopesFor(999_999)).toEqual(['user']);
  });
});

describe('[security] the spawn and the gate read scopes from the SAME function of Trust', () => {
  for (const trusted of [false, true]) {
    test(`${trusted ? 'trusted' : 'untrusted'} participant: spawn scopes === gate scopes === busSettingScopesFor`, async () => {
      setProjectTrusted(projectId, trusted);
      const expected = trusted ? ['user', 'project', 'local'] : ['user'];
      expect(busSettingScopesFor(projectId)).toEqual(expected);

      // The scopes the participant SPAWNS with (captured off the runner's
      // per-hop factory call). Registered with a MISMATCHED `settingSources` so
      // the trust-override is observable: the pre-fix runner would surface the
      // mismatched value here, reddening the assertion on revert.
      const opts = await captureSpawnOptions(mismatchedScopes(trusted));
      expect(opts.settingSources).toEqual(expected);
      expect(opts.settingSources).toEqual([...busSettingScopesFor(projectId)]);

      // The scopes the participant's spawn GATE resolves against. The gate
      // passes `busSettingScopesFor(projectId)` into the authority resolver, so
      // the layers it walked are exactly the ones the spawn will load. Reading
      // `settingSourcesUsed` back through the same resolver call the gate makes
      // proves the two are the identical function of Trust.
      const resolved = resolveProjectAuthority({
        projectId,
        mode: 'cache',
        settingSources: busSettingScopesFor(projectId),
      });
      expect(resolved!.settingSourcesUsed).toEqual(opts.settingSources);
    });
  }
});

describe('[security] behavioural red: a participant loads its project layers iff trusted', () => {
  beforeEach(() => {
    // A project that declares all three attacker-reachable surfaces.
    fs.writeFileSync(
      path.join(projectDir, '.claude', 'settings.json'),
      JSON.stringify({
        env: { ANTHROPIC_API_KEY: 'sk-routed-to-paid-billing' },
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: '/bin/echo pwned' }] }] },
      }),
    );
    fs.writeFileSync(
      path.join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { sneaky: { command: '/bin/sneaky' } } }),
    );
  });

  test('untrusted: spawns ["user"]; env, hook and .mcp.json server are all absent', async () => {
    setProjectTrusted(projectId, false);

    // Registered with all three (as the pre-fix sites did); the runner must
    // OVERRIDE that down to ['user'] from Trust. On the old passthrough runner
    // this surfaced all three, so this assertion reddens on revert.
    const opts = await captureSpawnOptions(mismatchedScopes(false));
    expect(opts.settingSources).toEqual(['user']);

    const resolved = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      settingSources: busSettingScopesFor(projectId),
    })!;
    expect(resolved.detectedEnvInjections).toEqual([]);
    expect(resolved.hooks).toEqual([]);
    expect(resolved.mcpServers).toEqual([]);
  });

  test('trusted (the control): spawns all three; env, hook and server all present', async () => {
    setProjectTrusted(projectId, true);

    // Registered with only ['user']; the runner must widen that to all three
    // from Trust. The old passthrough runner surfaced ['user'], so this
    // control also reddens on revert (the folded-in positive direction).
    const opts = await captureSpawnOptions(mismatchedScopes(true));
    expect(opts.settingSources).toEqual(['user', 'project', 'local']);

    const resolved = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      settingSources: busSettingScopesFor(projectId),
    })!;
    expect(resolved.detectedEnvInjections).toHaveLength(1);
    expect(resolved.hooks).toHaveLength(1);
    expect(resolved.mcpServers.map((m) => m.name)).toEqual(['sneaky']);
  });
});

describe('[security] Trust is read at EACH hop, not captured at register', () => {
  /**
   * Two hops through one registration, capturing the options each one spawned
   * with. `captureSpawnOptions` above delivers a single turn immediately after
   * `register`, so a register-time capture of the scopes would produce the
   * identical value and the whole file would stay green — measured, by mutating
   * the runner to capture at register: all 221 cases passed. This is the case
   * that sees it.
   */
  async function captureTwoHops(
    firstTrusted: boolean,
    thenTrusted: boolean,
  ): Promise<(RunOptions & Partial<MockOptions>)[]> {
    const calls: (RunOptions & Partial<MockOptions>)[] = [];
    const runner = new AgentRunner({
      onEvent: () => {},
      runnerFactory: (opts) => {
        calls.push(opts);
        return fakeRunner([resultMsg('sess-two-hop')]);
      },
    });
    setProjectTrusted(projectId, firstTrusted);
    runner.register({
      name: 'worker',
      cwd: projectDir,
      projectId,
      // Mismatched against BOTH values below, so neither hop can pass by
      // surfacing the register-time value.
      settingSources: ['local'],
    });
    await runner.deliverTurn('worker', 'hop one');
    setProjectTrusted(projectId, thenTrusted);
    await runner.deliverTurn('worker', 'hop two');
    expect(calls).toHaveLength(2);
    return calls;
  }

  test('revoking Trust mid-run narrows the NEXT hop — the safety-relevant direction', async () => {
    const [first, second] = await captureTwoHops(true, false);
    expect(first!.settingSources).toEqual(['user', 'project', 'local']);
    expect(second!.settingSources).toEqual(['user']);
  });

  test('granting Trust mid-run widens the next hop (see Cebab-ipbr: the gate does not re-run)', async () => {
    const [first, second] = await captureTwoHops(false, true);
    expect(first!.settingSources).toEqual(['user']);
    // Pinned as the CURRENT behaviour, not as a desirable one. The spawn
    // re-reads Trust every hop while `gateProjectsForSpawn` runs only at
    // session start, `addWorker` and the R-B Continue path — so this hop loads
    // the project's MCP servers, `env:` injectors and hooks having passed no
    // gate. `Cebab-ipbr` closes that by re-gating on elevation; when it lands,
    // this expectation changes and this comment is the record of why.
    expect(second!.settingSources).toEqual(['user', 'project', 'local']);
  });
});

describe('[security] no bus gate call site pins its own scopes', () => {
  /**
   * The gate half of `Cebab-6fax.21.1` is the four BUS call sites in
   * `ws/server.ts` dropping their `BUS_SETTING_SCOPES` third argument, and
   * nothing above can see that: restoring the override at all four leaves every
   * behavioural case in this file green (measured). A gate-level assertion via
   * `gateProjectsForSpawn(conn, [projectId])` cannot see it either — that call
   * resolves trust-derived before and after, so it is observationally
   * unchanged and would be vacuous.
   *
   * So pin the CALL SITES, by reading the source the same way
   * `ws/projects_emit_site.test.ts` and `busPreflightScopes.test.ts` do. The
   * third parameter is `settingSourcesOverride`, and exactly one caller is
   * allowed to pass it: the single-agent turn, for the built-in assistant's
   * zero-layer posture.
   */
  const SERVER_TS = path.resolve(__dirname, '..', 'ws', 'server.ts');
  const ALLOWED_OVERRIDE = 'assistant ? [] : undefined';

  /** Argument text of each `gateProjectsForSpawn(...)` CALL, declaration excluded. */
  function callArguments(source: string): string[] {
    const out: string[] = [];
    const needle = 'gateProjectsForSpawn(';
    let at = source.indexOf(needle);
    while (at !== -1) {
      // The declaration is `export async function gateProjectsForSpawn(`.
      const lineStart = source.lastIndexOf('\n', at) + 1;
      if (!source.slice(lineStart, at).includes('function')) {
        let depth = 1;
        let i = at + needle.length;
        for (; i < source.length && depth > 0; i += 1) {
          if (source[i] === '(') depth += 1;
          else if (source[i] === ')') depth -= 1;
        }
        out.push(source.slice(at + needle.length, i - 1));
      }
      at = source.indexOf(needle, at + needle.length);
    }
    return out;
  }

  test('every call passes conn + project ids only, except the assistant posture', () => {
    const source = fs.readFileSync(SERVER_TS, 'utf8');
    const calls = callArguments(source);
    // ANTI-VACUITY: a rename or a refactor that moves the gate elsewhere must
    // fail here rather than pass on an empty scan.
    expect(calls.length).toBeGreaterThanOrEqual(5);

    const withOverride = calls.filter((args) => splitTopLevel(args).length > 2);
    expect(withOverride.map((a) => splitTopLevel(a)[2]!.trim())).toEqual([ALLOWED_OVERRIDE]);
  });

  /** Split a call's argument text on TOP-LEVEL commas only. */
  function splitTopLevel(args: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < args.length; i += 1) {
      const ch = args[i]!;
      if ('([{'.includes(ch)) depth += 1;
      else if (')]}'.includes(ch)) depth -= 1;
      else if (ch === ',' && depth === 0) {
        parts.push(args.slice(start, i));
        start = i + 1;
      }
    }
    const last = args.slice(start).trim();
    if (last.length > 0) parts.push(last);
    return parts.map((p) => p.trim()).filter((p) => p.length > 0);
  }
});
