import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { awaitMcpTrustDecisions, makeTrustGateState } from './mcp_trust_gate.js';
import {
  BUS_SETTING_SCOPES,
  _testing,
  detectEnvInjections,
  detectHooks,
  detectMcpServers,
  resolveProjectAuthority,
  resolveToolAuthority,
  tallyToolUsage,
} from './project_authority.js';
import { closeDb, getDb } from '../db.js';
import { config } from '../config.js';
import { upsertProject, setProjectTrusted } from './projects.js';
import { createSession } from './sessions.js';
import { insertEvent, nextSeq } from './events.js';

// Cluster B Phase 3 (§4.3): resolver tests cover the four file-read
// scanners (resolveToolAuthority, detectEnvInjections, detectHooks,
// detectMcpServers) and the top-level orchestrator (resolveProjectAuthority).
//
// The scanners are pure-data functions that take pre-built settings layers
// — no fs / DB needed — so most tests pass layers directly. The
// orchestrator needs a DB-backed project row, so those tests scaffold a
// tmp data dir + tmp project path.

// ---- pure-data fixture builder ----

type Layer = ReturnType<typeof _testing.loadSettingsLayers>[number];

function fixtureLayer(scope: Layer['scope'], data: NonNullable<Layer['data']>): Layer {
  return { scope, scopePath: `/fake/${scope}/settings.json`, data };
}

// ---- resolveToolAuthority ----

describe('resolveToolAuthority (BE-B7) — allow/deny attribution', () => {
  test('no rules → not allowed, not denied, rulingScope=default', () => {
    const out = resolveToolAuthority('Read', []);
    expect(out).toMatchObject({
      name: 'Read',
      source: 'builtin',
      allowed: false,
      denied: false,
      rulingScope: 'default',
    });
  });

  test('allow at user → allowed=true, rulingScope=user', () => {
    const out = resolveToolAuthority('Read', [
      fixtureLayer('user', { permissions: { allow: ['Read'] } }),
    ]);
    expect(out).toMatchObject({ allowed: true, denied: false, rulingScope: 'user' });
  });

  test('deny at project beats allow at user → denied=true, rulingScope=project', () => {
    const out = resolveToolAuthority('Bash', [
      fixtureLayer('user', { permissions: { allow: ['Bash'] } }),
      fixtureLayer('project', { permissions: { deny: ['Bash'] } }),
    ]);
    expect(out).toMatchObject({ allowed: false, denied: true, rulingScope: 'project' });
  });

  test('allow at local beats allow at user → rulingScope=local (deepest wins per SDK precedence)', () => {
    const out = resolveToolAuthority('Read', [
      fixtureLayer('user', { permissions: { allow: ['Read'] } }),
      fixtureLayer('local', { permissions: { allow: ['Read'] } }),
    ]);
    expect(out).toMatchObject({ allowed: true, rulingScope: 'local' });
  });

  test('parenthesized rule attributes to the leftmost tool name', () => {
    // SDK permission strings carry tool-with-input patterns like
    // `Bash(echo:*)`; the resolver attributes them to the tool itself so
    // the inspector shows "Bash has at least one rule" without trying to
    // re-implement SDK's matching semantics.
    const out = resolveToolAuthority('Bash', [
      fixtureLayer('user', { permissions: { allow: ['Bash(echo:*)'] } }),
    ]);
    expect(out).toMatchObject({ allowed: true, rulingScope: 'user' });
  });

  test('mcp__server__tool from a needs-auth server → denied (BE-B6 cascade)', () => {
    // A server in `needs-auth` cannot serve its tools; the resolver
    // cascades effectively-unavailable into ToolView regardless of
    // settings.json allow rules.
    const out = resolveToolAuthority(
      'mcp__broken__read_file',
      [
        fixtureLayer('user', {
          permissions: { allow: ['mcp__broken__read_file'] },
        }),
      ],
      {
        mcpServers: [
          {
            name: 'broken',
            status: 'needs-auth',
            scope: 'user',
            tools: [],
            trust: 'unknown',
          },
        ],
      },
    );
    expect(out).toMatchObject({
      source: 'mcp',
      mcpServer: 'broken',
      denied: true,
      rulingScope: 'default',
    });
  });

  test('mcp__server__tool from a connected server respects allow/deny normally', () => {
    const out = resolveToolAuthority(
      'mcp__filesystem__read',
      [
        fixtureLayer('local', {
          permissions: { allow: ['mcp__filesystem__read'] },
        }),
      ],
      {
        mcpServers: [
          {
            name: 'filesystem',
            status: 'connected',
            scope: 'local',
            tools: [],
            trust: 'unknown',
          },
        ],
      },
    );
    expect(out).toMatchObject({
      source: 'mcp',
      mcpServer: 'filesystem',
      allowed: true,
      denied: false,
      rulingScope: 'local',
    });
  });

  test('cebab_bus MCP tool is tagged source=cebab-injected', () => {
    // Distinguishes Cebab's identity-pinned bus_send tool from
    // operator-declared MCPs in the AuthorityPanel UI.
    const out = resolveToolAuthority('mcp__cebab_bus__bus_send', [], {
      mcpServers: [
        {
          name: 'cebab_bus',
          status: 'connected',
          scope: 'cebab-injected',
          tools: ['bus_send'],
          trust: 'unknown',
        },
      ],
    });
    expect(out.source).toBe('cebab-injected');
    expect(out.mcpServer).toBe('cebab_bus');
  });
});

// ---- detectEnvInjections ----

describe('detectEnvInjections (BE-B11 / BE-B12) — credential-class env scan', () => {
  test('finds ANTHROPIC_API_KEY declared at project scope', () => {
    const layers: Layer[] = [
      fixtureLayer('project', { env: { ANTHROPIC_API_KEY: 'real-token-value' } }),
    ];
    const out = detectEnvInjections(layers);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      envKey: 'ANTHROPIC_API_KEY',
      scope: 'project',
      posture: expect.stringContaining('Subscription auth'),
    });
  });

  test('[security] never reads the value the operator put in settings.json (BE-B12)', () => {
    // The settings.json value MUST NEVER appear in the returned record;
    // a screenshot of the AuthorityPanel can't leak the operator's token.
    const layers: Layer[] = [
      fixtureLayer('local', { env: { ANTHROPIC_API_KEY: 'sk-secret-leak-me' } }),
    ];
    const out = detectEnvInjections(layers);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('leak-me');
    // Even the LENGTH or truncated prefix would be a leak vector — we
    // should ONLY have key + scope + posture + isSet.
    expect(Object.keys(out[0]).sort()).toEqual(
      ['envKey', 'isSet', 'posture', 'scope', 'scopePath'].sort(),
    );
  });

  test('multiple credential keys across multiple scopes each produce a row', () => {
    const layers: Layer[] = [
      fixtureLayer('user', { env: { ANTHROPIC_API_KEY: 'a' } }),
      fixtureLayer('project', { env: { CLAUDE_CODE_USE_BEDROCK: 'true' } }),
      fixtureLayer('local', { env: { ANTHROPIC_API_KEY: 'b' } }),
    ];
    const out = detectEnvInjections(layers);
    expect(out).toHaveLength(3);
    expect(out.map((e) => `${e.envKey}@${e.scope}`).sort()).toEqual([
      'ANTHROPIC_API_KEY@local',
      'ANTHROPIC_API_KEY@user',
      'CLAUDE_CODE_USE_BEDROCK@project',
    ]);
  });

  test('non-credential env keys are ignored', () => {
    const layers: Layer[] = [
      fixtureLayer('project', {
        env: { NODE_ENV: 'production', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'x' },
      }),
    ];
    const out = detectEnvInjections(layers);
    expect(out).toHaveLength(1);
    expect(out[0].envKey).toBe('ANTHROPIC_API_KEY');
  });

  test('isSet reflects process.env, not the settings.json value', () => {
    // The CURRENT process env decides isSet (definition: env var present
    // with a non-empty value); the settings.json value is NEVER inspected
    // (BE-B12 invariant). We explicitly mutate process.env under both
    // branches to prove the determinism — env-flag behavior at test
    // runtime doesn't drift on different operator machines.
    const layers: Layer[] = [
      fixtureLayer('project', { env: { ANTHROPIC_API_KEY: 'declared-but-unset' } }),
    ];

    const originalValue = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.ANTHROPIC_API_KEY = 'something';
      expect(detectEnvInjections(layers)[0].isSet).toBe(true);

      delete process.env.ANTHROPIC_API_KEY;
      expect(detectEnvInjections(layers)[0].isSet).toBe(false);

      // Empty-string env is "declared but vacuous" — treat as not-set so
      // operators don't see false-positive injection warnings.
      process.env.ANTHROPIC_API_KEY = '';
      expect(detectEnvInjections(layers)[0].isSet).toBe(false);
    } finally {
      if (originalValue === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalValue;
      }
    }
  });
});

// ---- detectHooks ----

describe('detectHooks (§11.1) — hook enumeration', () => {
  test('flattens matcher buckets into one HookView per concrete entry', () => {
    const layers: Layer[] = [
      fixtureLayer('local', {
        hooks: {
          PreToolUse: [
            { hooks: [{ command: '/bin/echo', args: ['pre'] }] },
            { hooks: [{ command: '/bin/echo', args: ['second'] }] },
          ],
          Stop: [{ hooks: [{ command: '/bin/cleanup.sh' }] }],
        },
      }),
    ];
    const out = detectHooks(layers);
    expect(out).toHaveLength(3);
    expect(out.map((h) => `${h.hookKind}:${h.command}`)).toEqual([
      'PreToolUse:/bin/echo',
      'PreToolUse:/bin/echo',
      'Stop:/bin/cleanup.sh',
    ]);
    expect(out[0].args).toEqual(['pre']);
    expect(out[2].args).toBeUndefined();
  });

  test('skips entries with no command (forward-compat with new SDK hook shapes)', () => {
    const layers: Layer[] = [
      fixtureLayer('user', {
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'callback' /* no command */ }] }],
        },
      }),
    ];
    expect(detectHooks(layers)).toEqual([]);
  });

  test('attributes hookKind from the parent key (forward-compat — accepts arbitrary kinds)', () => {
    // SDK declares 29 hook events and adds more across versions; the
    // resolver shouldn't refuse to enumerate a hook just because it's
    // not in our narrow list.
    const layers: Layer[] = [
      fixtureLayer('user', {
        hooks: { SomeFutureHook: [{ hooks: [{ command: '/bin/x' }] }] },
      }),
    ];
    expect(detectHooks(layers)[0].hookKind).toBe('SomeFutureHook');
  });
});

// ---- detectMcpServers ----

describe('detectMcpServers (BE-B5) — MCP server scope attribution', () => {
  test('deepest scope wins when the same name appears in multiple layers', () => {
    // SDK precedence: ['user', 'project', 'local'] — later overrides earlier.
    const layers: Layer[] = [
      fixtureLayer('user', { mcpServers: { srv: { command: 'user-cmd' } } }),
      fixtureLayer('local', { mcpServers: { srv: { command: 'local-cmd' } } }),
    ];
    const out = detectMcpServers(layers);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'srv', scope: 'local' });
    expect(out[0].config?.command).toBe('local-cmd');
  });

  test('config.envKeys lists NAMES only (no values; mirrors BE-B12)', () => {
    const layers: Layer[] = [
      fixtureLayer('project', {
        mcpServers: { x: { command: 'x', env: { SECRET: 'leak', OK: 'safe' } } },
      }),
    ];
    const out = detectMcpServers(layers);
    const serialized = JSON.stringify(out);
    expect(out[0].config?.envKeys?.sort()).toEqual(['OK', 'SECRET']);
    expect(serialized).not.toContain('leak');
    expect(serialized).not.toContain('safe');
  });

  test('starts every row with trust=unknown (Phase 4 fills via mcp_trust JOIN)', () => {
    const layers: Layer[] = [fixtureLayer('user', { mcpServers: { srv: { command: 'x' } } })];
    expect(detectMcpServers(layers)[0].trust).toBe('unknown');
  });
});

// ---- resolveProjectAuthority orchestrator ----

let tmpRoot: string;
let originalDataDir: string;
let projectPath: string;
let projectId: number;

// `os.homedir()` reads $HOME on POSIX and %USERPROFILE% on Windows. Setting
// only HOME redirects nothing on the Windows runner — measured: the guard
// assertion below caught it as `expected 'C:\Users\runneradmin' to be
// '<tmp>'`, which is precisely what the guard is for. Set both, restore both.
const HOME_VARS = ['HOME', 'USERPROFILE'] as const;
let originalHome: Partial<Record<(typeof HOME_VARS)[number], string | undefined>> = {};

function redirectHome(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  originalHome = {};
  for (const v of HOME_VARS) {
    originalHome[v] = process.env[v];
    process.env[v] = dir;
  }
}

function restoreHome(): void {
  for (const v of HOME_VARS) {
    const prev = originalHome[v];
    if (prev === undefined) delete process.env[v];
    else process.env[v] = prev;
  }
}

/** Compare paths through realpath: Windows temp dirs come back as 8.3 short
 *  names (`RUNNER~1`) from one API and long names from another. */
function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  return path.resolve(real(a)) === path.resolve(real(b));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-pauth-orch-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  // Create a trusted project rooted at tmpRoot/proj with a .claude/ dir.
  projectPath = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(projectPath, '.claude'), { recursive: true });
  projectId = upsertProject('proj', projectPath).id;
  setProjectTrusted(projectId, true);
  // `readClaudeJsonServers` reads `~/.claude.json`, so without this the whole
  // file's expectations depend on the DEVELOPER'S real CLI config: a machine
  // with a `claude mcp add --scope user` server would see an extra row in
  // every `resolveProjectAuthority` assertion below. CI has no such file, so
  // the failure would only ever appear locally, on someone else's machine.
  // Point home at an empty dir; the cases that want a fixture write their own.
  redirectHome(path.join(tmpRoot, 'home'));
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  restoreHome();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveProjectAuthority (BE-B3) — merge cached init + file scans', () => {
  test('unknown projectId returns null (no throw)', () => {
    const out = resolveProjectAuthority({ projectId: 99999, mode: 'cache' });
    expect(out).toBeNull();
  });

  test('trusted project with project-scope settings.json yields settingSourcesUsed=[user,project,local]', () => {
    fs.writeFileSync(
      path.join(projectPath, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Read'] } }),
    );
    const out = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      latestSessionStarted: { tools: ['Read', 'Bash'] },
    });
    expect(out).not.toBeNull();
    expect(out!.settingSourcesUsed).toEqual(['user', 'project', 'local']);
    // Read is allowed (project rule); Bash falls through to default.
    const read = out!.tools.find((t) => t.name === 'Read');
    expect(read).toMatchObject({ allowed: true, rulingScope: 'project' });
    const bash = out!.tools.find((t) => t.name === 'Bash');
    expect(bash).toMatchObject({ rulingScope: 'default' });
  });

  test('untrusted project: project + local scopes skipped (settingSourcesUsed=[user] only)', () => {
    // Mirror the SDK's setting-sources narrowing for untrusted projects:
    // a hostile sibling repo's .claude/settings.local.json doesn't load.
    setProjectTrusted(projectId, false);
    fs.writeFileSync(
      path.join(projectPath, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Read'] } }),
    );
    const out = resolveProjectAuthority({ projectId, mode: 'cache' });
    expect(out!.settingSourcesUsed).toEqual(['user']);
  });

  test('cache miss (no latestSessionStarted): tools/agents/skills empty but scans populated', () => {
    // Pre-flight inspection of a project that hasn't started a session
    // in this connection still surfaces declared MCP servers, env
    // injections, and hooks — just nothing on the effective side.
    fs.writeFileSync(
      path.join(projectPath, '.claude', 'settings.local.json'),
      JSON.stringify({
        env: { ANTHROPIC_API_KEY: 'x' },
        mcpServers: { dev: { command: '/bin/dev' } },
      }),
    );
    const out = resolveProjectAuthority({ projectId, mode: 'cache' });
    expect(out!.tools).toEqual([]);
    expect(out!.agents).toEqual([]);
    expect(out!.detectedEnvInjections).toHaveLength(1);
    expect(out!.mcpServers).toHaveLength(1);
    expect(out!.mcpServers[0]).toMatchObject({ name: 'dev', scope: 'local' });
  });

  test('cached MCP server status overlays declared shape (BE-B5 + status pass-through)', () => {
    fs.writeFileSync(
      path.join(projectPath, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { broken: { command: '/x' } } }),
    );
    const out = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      latestSessionStarted: {
        mcpServers: [{ name: 'broken', status: 'needs-auth' }],
      },
    });
    const srv = out!.mcpServers.find((s) => s.name === 'broken')!;
    expect(srv.status).toBe('needs-auth');
    expect(srv.scope).toBe('project');
  });

  test('SDK-reported MCP servers without a settings.json declaration get scope=cebab-injected', () => {
    // The bus_send MCP that Cebab pins per-agent (`bus/runner.ts`) shows
    // up on the wire but never lands in any user settings.json — must
    // appear in the AuthorityPanel as "Cebab-managed".
    const out = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      latestSessionStarted: {
        mcpServers: [{ name: 'cebab_bus', status: 'connected' }],
      },
    });
    const srv = out!.mcpServers.find((s) => s.name === 'cebab_bus')!;
    expect(srv.scope).toBe('cebab-injected');
  });

  test('probe mode falls through to cache in Phase 3 (Phase 3b lands SDK spawn)', () => {
    // No throw, no spawn — just returns the cache merge with an info log.
    const out = resolveProjectAuthority({
      projectId,
      mode: 'probe',
      latestSessionStarted: { tools: ['Read'] },
    });
    expect(out).not.toBeNull();
    expect(out!.fromProbe).toBe(false); // not yet a real probe
    expect(out!.tools.map((t) => t.name)).toEqual(['Read']);
  });

  test('cached single-value fields (model, cwd, permissionMode, apiKeySource) pass through verbatim', () => {
    const out = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      latestSessionStarted: {
        model: 'claude-sonnet-4',
        cwd: '/tmp/work',
        permissionMode: 'acceptEdits',
        apiKeySource: 'oauth',
      },
    });
    expect(out).toMatchObject({
      model: 'claude-sonnet-4',
      cwd: '/tmp/work',
      permissionMode: 'acceptEdits',
      apiKeySource: 'oauth',
    });
  });
});

// ---- Phase 4: TOFU JOIN integration ----

describe('resolveProjectAuthority — Phase 4 TOFU JOIN', () => {
  test('declared MCP with no recorded trust → trust=pending_tofu', async () => {
    // Use dynamic import here so we exercise the live mcp_trust module
    // (no mocks) — the resolver consults checkTrust internally.
    fs.writeFileSync(
      path.join(projectPath, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { fresh: { command: '/bin/echo' } } }),
    );
    const out = resolveProjectAuthority({ projectId, mode: 'cache' });
    const fresh = out!.mcpServers.find((s) => s.name === 'fresh')!;
    expect(fresh.trust).toBe('pending_tofu');
    // binarySha is computed at resolver time (real sha of /bin/echo);
    // we only assert it's a string of expected sha256 length when the
    // binary exists on this OS — but on Windows CI `/bin/echo` won't
    // resolve. Guard with a "computed-or-absent" check.
    if (fs.existsSync('/bin/echo')) {
      expect(typeof fresh.binarySha).toBe('string');
      expect(fresh.binarySha?.length).toBe(64);
    }
  });

  test('declared MCP with a trusted decision → trust=trusted + lastSeenAt populated', async () => {
    fs.writeFileSync(
      path.join(projectPath, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { remembered: { command: 'npx' } } }),
    );
    const { recordTrustDecision: rec } = await import('./mcp_trust.js');
    // npx → unresolvable, so binarySha is null in both the recorder and
    // the resolver lookup. The null-distinct lookup still matches.
    rec({
      serverName: 'remembered',
      originPath: path.join(projectPath, '.claude', 'settings.json'),
      binarySha: null,
      decision: 'trusted',
    });
    const out = resolveProjectAuthority({ projectId, mode: 'cache' });
    const view = out!.mcpServers.find((s) => s.name === 'remembered')!;
    expect(view.trust).toBe('trusted');
    expect(view.lastSeenAt).toBeTypeOf('number');
    expect(view.firstSeenAt).toBeTypeOf('number');
  });

  test('firstSeenAt is the FIRST decision, not the oldest surviving lookup row (D09)', async () => {
    // The case above asserts both fields are numbers, which is true under any
    // implementation — including the one where they are the SAME number. This
    // one pins the values apart.
    //
    // `firstSeenAt` used to come from the oldest row `listForServer` returned.
    // `mcp_trust` is a lookup whose rows are replaced, so that answered "the
    // oldest decision not yet superseded". It was already wrong for a real sha
    // (a replace deletes the older row) and only looked right for `npx` because
    // NULL-distinct semantics let the old rows pile up — the very bug 033
    // fixes. It now reads the append-only audit chain, which keeps them all.
    fs.writeFileSync(
      path.join(projectPath, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { twice: { command: 'npx' } } }),
    );
    const { recordTrustDecision: rec } = await import('./mcp_trust.js');
    const originPath = path.join(projectPath, '.claude', 'settings.json');
    rec({ serverName: 'twice', originPath, binarySha: null, decision: 'denied_remember' });
    await new Promise((r) => setTimeout(r, 5)); // distinct ts
    rec({ serverName: 'twice', originPath, binarySha: null, decision: 'trusted' });

    const out = resolveProjectAuthority({ projectId, mode: 'cache' });
    const view = out!.mcpServers.find((s) => s.name === 'twice')!;
    expect(view.trust).toBe('trusted'); // the later decision governs
    expect(view.firstSeenAt).toBeLessThan(view.lastSeenAt!);
  });

  test('cebab-injected servers always trust=trusted (skip the JOIN)', () => {
    // The cebab_bus MCP is identity-pinned by Cebab — no operator
    // decision needed; the enrichment pass shortcuts these.
    const out = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      latestSessionStarted: {
        mcpServers: [{ name: 'cebab_bus', status: 'connected' }],
      },
    });
    const bus = out!.mcpServers.find((s) => s.name === 'cebab_bus')!;
    expect(bus.scope).toBe('cebab-injected');
    expect(bus.trust).toBe('trusted');
  });

  test('declared MCP with denied_remember decision → trust=denied', async () => {
    fs.writeFileSync(
      path.join(projectPath, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { bad: { command: 'npx' } } }),
    );
    const { recordTrustDecision: rec } = await import('./mcp_trust.js');
    rec({
      serverName: 'bad',
      originPath: path.join(projectPath, '.claude', 'settings.json'),
      binarySha: null,
      decision: 'denied_remember',
    });
    const out = resolveProjectAuthority({ projectId, mode: 'cache' });
    expect(out!.mcpServers.find((s) => s.name === 'bad')!.trust).toBe('denied');
  });

  // Phase 10 tally tests live in their own describe at the bottom of the
  // file — see "tallyToolUsage / Phase 10 usage-diff pipeline".

  test('trusted_pinned_hash + binary changed → trust=hash_changed', async () => {
    // Write a fake binary, pin its hash, then mutate the file and
    // re-resolve. The post-mutation sha mismatches the pinned, so the
    // resolver flips to hash_changed.
    const fakeBin = path.join(tmpRoot, 'fake-mcp-bin');
    fs.writeFileSync(fakeBin, 'v1');
    fs.writeFileSync(
      path.join(projectPath, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { pinned: { command: fakeBin } } }),
    );
    const { computeBinarySha: csha, recordTrustDecision: rec } = await import('./mcp_trust.js');
    const v1Sha = csha(fakeBin)!;
    rec({
      serverName: 'pinned',
      originPath: path.join(projectPath, '.claude', 'settings.json'),
      binarySha: v1Sha,
      decision: 'trusted_pinned_hash',
    });
    // First resolve: hash matches → trusted.
    expect(
      resolveProjectAuthority({ projectId, mode: 'cache' })!.mcpServers.find(
        (s) => s.name === 'pinned',
      )!.trust,
    ).toBe('trusted');
    // Mutate the binary.
    fs.writeFileSync(fakeBin, 'v2-different');
    expect(
      resolveProjectAuthority({ projectId, mode: 'cache' })!.mcpServers.find(
        (s) => s.name === 'pinned',
      )!.trust,
    ).toBe('hash_changed');
  });
});

// ---- Cluster B Phase 10: tallyToolUsage + resolver enrichment ----

describe('tallyToolUsage (Phase 10 / UI-B31 / spec §4.8)', () => {
  function insertAssistantToolUse(sessionId: string, toolName: string): void {
    insertEvent(
      sessionId,
      nextSeq(sessionId),
      'assistant',
      null,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: `t-${Math.random()}`, name: toolName, input: {} }],
        },
      }),
    );
  }
  function insertPermissionRequest(sessionId: string, requestId: string, toolName: string): void {
    insertEvent(
      sessionId,
      nextSeq(sessionId),
      'wrapper',
      'permission_request',
      JSON.stringify({ type: 'wrapper', subtype: 'permission_request', requestId, toolName }),
    );
  }
  function insertPermissionDecided(
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ): void {
    insertEvent(
      sessionId,
      nextSeq(sessionId),
      'wrapper',
      'permission_decided',
      JSON.stringify({ type: 'wrapper', subtype: 'permission_decided', requestId, decision }),
    );
  }

  test('project with no sessions → empty tally', () => {
    expect(tallyToolUsage(projectId).size).toBe(0);
  });

  test('counts tool_use blocks across all sessions in the project', () => {
    const s1 = createSession('s-tally-1', projectId).id;
    const s2 = createSession('s-tally-2', projectId).id;
    insertAssistantToolUse(s1, 'Read');
    insertAssistantToolUse(s1, 'Read');
    insertAssistantToolUse(s1, 'Bash');
    insertAssistantToolUse(s2, 'Read');
    insertAssistantToolUse(s2, 'Edit');
    const tally = tallyToolUsage(projectId);
    expect(tally.get('Read')?.calledCount).toBe(3);
    expect(tally.get('Bash')?.calledCount).toBe(1);
    expect(tally.get('Edit')?.calledCount).toBe(1);
  });

  test('attributes operator denials to the right tool via the requestId index', () => {
    const s = createSession('s-tally-deny', projectId).id;
    insertPermissionRequest(s, 'req-a', 'Bash');
    insertPermissionDecided(s, 'req-a', 'deny');
    insertPermissionRequest(s, 'req-b', 'Bash');
    insertPermissionDecided(s, 'req-b', 'deny');
    insertPermissionRequest(s, 'req-c', 'Edit');
    insertPermissionDecided(s, 'req-c', 'allow'); // not counted
    const tally = tallyToolUsage(projectId);
    expect(tally.get('Bash')?.deniedCount).toBe(2);
    // Edit was allowed (not denied) — must not appear with a deniedCount.
    expect(tally.get('Edit')?.deniedCount ?? 0).toBe(0);
  });

  test('called + denied tallies coexist on the same tool', () => {
    const s = createSession('s-tally-mix', projectId).id;
    insertPermissionRequest(s, 'r1', 'Bash');
    insertPermissionDecided(s, 'r1', 'deny');
    insertAssistantToolUse(s, 'Bash');
    insertAssistantToolUse(s, 'Bash');
    const tally = tallyToolUsage(projectId);
    expect(tally.get('Bash')).toEqual({ calledCount: 2, deniedCount: 1 });
  });

  test('non-JSON raw rows are skipped (resilience)', () => {
    const s = createSession('s-tally-bad', projectId).id;
    insertEvent(s, nextSeq(s), 'assistant', null, 'this is not json');
    insertAssistantToolUse(s, 'Read');
    expect(tallyToolUsage(projectId).get('Read')?.calledCount).toBe(1);
  });

  test('denial with unknown requestId is silently dropped (no synthetic tool)', () => {
    const s = createSession('s-tally-orphan', projectId).id;
    // permission_decided lands without a prior permission_request — possible
    // if the row arrived from a different session_id (cross-session bug) or
    // an out-of-order replay. We refuse to credit it.
    insertPermissionDecided(s, 'orphan-req', 'deny');
    expect(tallyToolUsage(projectId).size).toBe(0);
  });
});

describe('resolveProjectAuthority — Phase 10 usage-diff enrichment', () => {
  test('populates calledCount / deniedCount on tools from the tally', () => {
    const s = createSession('s-enrich', projectId).id;
    // 3× Read calls, 1× Bash denied
    insertEvent(
      s,
      nextSeq(s),
      'assistant',
      null,
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read' }] },
      }),
    );
    insertEvent(
      s,
      nextSeq(s),
      'assistant',
      null,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read' },
            { type: 'tool_use', name: 'Read' },
          ],
        },
      }),
    );
    insertEvent(
      s,
      nextSeq(s),
      'wrapper',
      'permission_request',
      JSON.stringify({
        type: 'wrapper',
        subtype: 'permission_request',
        requestId: 'r',
        toolName: 'Bash',
      }),
    );
    insertEvent(
      s,
      nextSeq(s),
      'wrapper',
      'permission_decided',
      JSON.stringify({
        type: 'wrapper',
        subtype: 'permission_decided',
        requestId: 'r',
        decision: 'deny',
      }),
    );
    const out = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      latestSessionStarted: { tools: ['Read', 'Bash', 'Edit'] },
    });
    expect(out!.tools.find((t) => t.name === 'Read')?.calledCount).toBe(3);
    expect(out!.tools.find((t) => t.name === 'Bash')?.deniedCount).toBe(1);
    // Edit never appeared in tally → both counts stay undefined (distinct
    // from explicit zero; AuthorityPanel renders "no usage" rather than
    // a stale "0" chip).
    const edit = out!.tools.find((t) => t.name === 'Edit')!;
    expect(edit.calledCount).toBeUndefined();
    expect(edit.deniedCount).toBeUndefined();
  });

  test('tally names not in initTools are silently dropped (current-surface only)', () => {
    // A tool the SDK once exposed but no longer does — we don't synthesise
    // a ToolView for it in this phase. The operator's view is "what's on
    // the surface NOW, and how did it perform".
    const s = createSession('s-stale', projectId).id;
    insertEvent(
      s,
      nextSeq(s),
      'assistant',
      null,
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'RetiredTool' }] },
      }),
    );
    const out = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      latestSessionStarted: { tools: ['Read'] },
    });
    expect(out!.tools.map((t) => t.name)).toEqual(['Read']);
    // Read has no tally entry → counts undefined; sanity check.
    expect(out!.tools[0].calledCount).toBeUndefined();
  });
});

// ---- [security] bus scope parity ----
//
// The bus registers every participant with settingSources
// ['user','project','local'] regardless of the project's Trust setting
// (bus/orchestrator.ts, bus/chain.ts). The authority resolver used to derive
// its layers from Trust alone, so for an UNTRUSTED bus participant the spawn
// gates saw an empty MCP list and an empty env-injection list — and then the
// SDK loaded exactly those rules anyway.
//
// These pin both halves: bus scopes see the project's rules, and the
// single-agent default is unchanged.

describe('[security] resolveProjectAuthority — bus setting scopes', () => {
  test('untrusted project resolved with BUS_SETTING_SCOPES surfaces its env injections', () => {
    setProjectTrusted(projectId, false);
    fs.writeFileSync(
      path.join(projectPath, '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-routed-to-paid-billing' } }),
    );

    // Trust-derived (single-agent): invisible, and correctly so — the SDK
    // won't load it either.
    const singleAgent = resolveProjectAuthority({ projectId, mode: 'cache' });
    expect(singleAgent!.settingSourcesUsed).toEqual(['user']);
    expect(singleAgent!.detectedEnvInjections).toEqual([]);

    // Bus scopes: the SDK WILL load it, so the gate must see it. Pre-fix this
    // returned [] and awaitEnvInjectionAck short-circuited on length === 0.
    const bus = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      settingSources: BUS_SETTING_SCOPES,
    });
    expect(bus!.settingSourcesUsed).toEqual(['user', 'project', 'local']);
    expect(bus!.detectedEnvInjections).toHaveLength(1);
    expect(bus!.detectedEnvInjections[0]).toMatchObject({ envKey: 'ANTHROPIC_API_KEY' });
  });

  test("untrusted project's declared MCP servers reach TOFU under bus scopes", () => {
    setProjectTrusted(projectId, false);
    fs.writeFileSync(
      path.join(projectPath, '.claude', 'settings.local.json'),
      JSON.stringify({ mcpServers: { sneaky: { command: '/bin/sneaky' } } }),
    );

    expect(resolveProjectAuthority({ projectId, mode: 'cache' })!.mcpServers).toEqual([]);

    const bus = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      settingSources: BUS_SETTING_SCOPES,
    });
    expect(bus!.mcpServers).toHaveLength(1);
    // originPath is what awaitMcpTrustDecisions anchors a decision row on;
    // without it the gate silently skips the server.
    expect(bus!.mcpServers[0]).toMatchObject({
      name: 'sneaky',
      scope: 'local',
      trust: 'pending_tofu',
    });
    expect(bus!.mcpServers[0]!.originPath).toBeTruthy();
  });

  test("untrusted project's hooks become visible under bus scopes", () => {
    setProjectTrusted(projectId, false);
    fs.writeFileSync(
      path.join(projectPath, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: '/bin/echo pwned' }] }] },
      }),
    );
    // Hooks execute on EVERY bus hop for that participant, so a panel that
    // reports none for a project whose hooks run is the worst kind of wrong.
    expect(resolveProjectAuthority({ projectId, mode: 'cache' })!.hooks).toEqual([]);
    const bus = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      settingSources: BUS_SETTING_SCOPES,
    });
    expect(bus!.hooks).toHaveLength(1);
    expect(bus!.hooks[0]).toMatchObject({ hookKind: 'PreToolUse', command: '/bin/echo pwned' });
  });

  test('trusted project is unaffected — bus scopes match trust-derived', () => {
    fs.writeFileSync(
      path.join(projectPath, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { dev: { command: '/bin/dev' } } }),
    );
    const trustDerived = resolveProjectAuthority({ projectId, mode: 'cache' });
    const bus = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      settingSources: BUS_SETTING_SCOPES,
    });
    expect(bus!.settingSourcesUsed).toEqual(trustDerived!.settingSourcesUsed);
    expect(bus!.mcpServers.map((m) => m.name)).toEqual(trustDerived!.mcpServers.map((m) => m.name));
  });
});

// ---- [security] cebab-injected label is not a laundering path ----

describe('[security] unattributable SDK-reported MCP servers', () => {
  test('a server matching no layer is scope=unknown, not cebab-injected', () => {
    // `scope: 'cebab-injected'` grants an automatic trust: 'trusted' in
    // enrichWithTrustState AND a `continue` in awaitMcpTrustDecisions. Handing
    // that label to anything we merely OBSERVED would permanently trust it.
    const out = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      latestSessionStarted: { mcpServers: [{ name: 'mystery', status: 'connected' }] },
    });
    expect(out!.mcpServers).toHaveLength(1);
    expect(out!.mcpServers[0]).toMatchObject({
      name: 'mystery',
      scope: 'unknown',
      trust: 'unknown',
    });
  });

  test("Cebab's own bus injection keeps the cebab-injected label and auto-trust", () => {
    const out = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      latestSessionStarted: { mcpServers: [{ name: 'cebab_bus', status: 'connected' }] },
    });
    expect(out!.mcpServers[0]).toMatchObject({
      name: 'cebab_bus',
      scope: 'cebab-injected',
      trust: 'trusted',
    });
  });

  test('a server named `bus` is NOT auto-trusted (the alias is gone)', () => {
    // `bus` was on CEBAB_INJECTED_MCP_NAMES only because `runOneAttempt`
    // registered a second, aliased copy of the bus tool server under that key.
    // With the alias removed, a server named `bus` can only be someone else's
    // — and auto-trusting it would skip the TOFU gate for a server Cebab does
    // not control. The allowlist must track what is actually injected.
    const out = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      latestSessionStarted: { mcpServers: [{ name: 'bus', status: 'connected' }] },
    });
    expect(out!.mcpServers[0]).toMatchObject({
      name: 'bus',
      scope: 'unknown',
      trust: 'unknown',
    });
  });
});

/**
 * [security] Register H03. `readSettingsFile` was a bare
 * `fs.readFileSync(p, 'utf8')` on a file the PROJECT owns, run during the
 * pre-spawn authority resolve — i.e. on the way into every session start.
 * No regular-file check, no size cap, no O_NONBLOCK.
 *
 * Reproduced before fixing: a bare readFileSync on a FIFO with no writer
 * never returns (a child process doing it had to be SIGKILLed at 5s). On a
 * single-threaded server that is the whole process wedged by a sibling repo.
 */
describe('[security] readSettingsFile — hostile settings files', () => {
  const posixOnly = process.platform === 'win32' ? test.skip : test;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-h03-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an ordinary settings file still parses (unchanged)', () => {
    const p = path.join(dir, 'settings.json');
    fs.writeFileSync(p, JSON.stringify({ env: { NODE_ENV: 'production' } }));
    expect(_testing.readSettingsFile(p)).toEqual({ env: { NODE_ENV: 'production' } });
  });

  test('a missing file is still "no rules from this scope" (unchanged)', () => {
    expect(_testing.readSettingsFile(path.join(dir, 'absent.json'))).toBeNull();
  });

  test('malformed JSON is still null (unchanged)', () => {
    const p = path.join(dir, 'bad.json');
    fs.writeFileSync(p, '{ not json');
    expect(_testing.readSettingsFile(p)).toBeNull();
  });

  test('refuses an oversized settings file instead of reading it whole', () => {
    const p = path.join(dir, 'huge.json');
    const fd = fs.openSync(p, 'w');
    try {
      // 2 MiB, over the 1 MiB cap. Sparse — the point is the declared size.
      fs.ftruncateSync(fd, 2 * 1024 * 1024);
    } finally {
      fs.closeSync(fd);
    }
    expect(_testing.readSettingsFile(p)).toBeNull();
  }, 30_000);

  test('refuses a directory where a settings file should be', () => {
    const p = path.join(dir, 'settings.json');
    fs.mkdirSync(p);
    expect(_testing.readSettingsFile(p)).toBeNull();
  });

  posixOnly(
    'refuses a FIFO without hanging — the DoS',
    () => {
      const p = path.join(dir, 'settings.json');
      execFileSync('mkfifo', [p]);
      const started = Date.now();
      expect(_testing.readSettingsFile(p)).toBeNull();
      expect(Date.now() - started).toBeLessThan(2000);
    },
    10_000,
  );

  posixOnly(
    'a FIFO in a real layer load degrades to no rules, it does not wedge',
    () => {
      // End to end through the actual resolver entry point, not just the reader:
      // a hostile project must yield "no rules from this scope" and return.
      const claudeDir = path.join(dir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      execFileSync('mkfifo', [path.join(claudeDir, 'settings.json')]);
      const started = Date.now();
      const layers = _testing.loadSettingsLayers(dir, ['project']);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(layers).toHaveLength(1);
      expect(layers[0].data).toBeNull();
    },
    10_000,
  );
});

/**
 * Register H05. `detectEnvInjections` filtered on the five-name
 * SCRUBBED_ENV_VAR_NAMES list, and `session_start_gate.awaitEnvInjectionAck`
 * returns immediately when that list comes back EMPTY. So a project declaring
 * GITHUB_TOKEN / AWS_SECRET_ACCESS_KEY / NPM_TOKEN produced no gate, no
 * operator prompt and no audit row, while the SDK layered those values into
 * the agent's spawn env.
 */
describe('detectEnvInjections — non-Anthropic credentials (H05)', () => {
  test('a GitHub token now produces an injection row', () => {
    const layers: Layer[] = [fixtureLayer('project', { env: { GITHUB_TOKEN: 'ghp_xxx' } })];
    const out = detectEnvInjections(layers);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ envKey: 'GITHUB_TOKEN', scope: 'project' });
  });

  test.each([
    'AWS_SECRET_ACCESS_KEY',
    'NPM_TOKEN',
    'DATABASE_PASSWORD',
    'STRIPE_API_KEY',
    'MY_CLIENT_SECRET',
    'SESSION_ID',
    'PRIVATE_KEY',
  ])('%s is detected', (key) => {
    const out = detectEnvInjections([fixtureLayer('project', { env: { [key]: 'v' } })]);
    expect(out.map((e) => e.envKey)).toEqual([key]);
  });

  test('heuristic matches carry the generic posture', () => {
    // The fallback string at the posture lookup was previously UNREACHABLE —
    // nothing outside the five names could get there. The code anticipated
    // this widening.
    const out = detectEnvInjections([fixtureLayer('project', { env: { GITHUB_TOKEN: 'x' } })]);
    expect(out[0].posture).toBe('credential-class env injection');
  });

  test('the five scrubbed names keep their SPECIFIC postures', () => {
    // The high-signal class must stay distinguishable from the heuristic one.
    const out = detectEnvInjections([
      fixtureLayer('project', { env: { ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_USE_BEDROCK: '1' } }),
    ]);
    const byKey = Object.fromEntries(out.map((e) => [e.envKey, e.posture]));
    expect(byKey.ANTHROPIC_API_KEY).toContain('Subscription auth');
    expect(byKey.CLAUDE_CODE_USE_BEDROCK).toContain('Bedrock');
  });

  test.each(['NODE_ENV', 'PORT', 'HOME', 'LANG', 'EDITOR'])(
    'plainly-innocent key %s is still ignored',
    (key) => {
      expect(detectEnvInjections([fixtureLayer('project', { env: { [key]: 'v' } })])).toEqual([]);
    },
  );

  test('[security] widening did not start leaking VALUES (BE-B12)', () => {
    // The whole point of the gate is the operator seeing a NAME, never the
    // secret. Re-asserted on the new path, not just the old one.
    const out = detectEnvInjections([
      fixtureLayer('local', { env: { GITHUB_TOKEN: 'ghp_super_secret_value' } }),
    ]);
    expect(JSON.stringify(out)).not.toContain('ghp_super_secret_value');
    expect(Object.keys(out[0]).sort()).toEqual(
      ['envKey', 'isSet', 'posture', 'scope', 'scopePath'].sort(),
    );
  });

  test('a credential key at every scope is reported once per scope', () => {
    const out = detectEnvInjections([
      fixtureLayer('user', { env: { GITHUB_TOKEN: 'a' } }),
      fixtureLayer('project', { env: { GITHUB_TOKEN: 'b' } }),
      fixtureLayer('local', { env: { GITHUB_TOKEN: 'c' } }),
    ]);
    expect(out.map((e) => e.scope).sort()).toEqual(['local', 'project', 'user']);
  });
});

// ---------------------------------------------------------------------------
// Cebab-x1n.6.22: the gate has to watch the file the CLI actually reads.
//
// MEASURED against @anthropic-ai/claude-agent-sdk 0.3.201 with a real MCP
// stdio server, reading `system/init.mcp_servers`:
//
//   <proj>/.claude/settings.json    → mcpServers → NOT loaded
//   ...+ enableAllProjectMcpServers → NOT loaded
//   ~/.claude/settings.json         → mcpServers → NOT loaded
//   <proj>/.mcp.json                             → LOADED, 'connected'
//
// So before `readMcpJsonServers` the TOFU gate could only prompt about
// declarations that never run, while every server that DOES run reached the
// spawn with no prompt, no mcp_trust row and no safety_audit row.
// ---------------------------------------------------------------------------
describe('[security] .mcp.json is the declaration that actually loads', () => {
  function writeMcpJson(servers: Record<string, unknown>): void {
    fs.writeFileSync(path.join(projectPath, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
  }

  test('a .mcp.json server reaches the authority view with its own scope', () => {
    writeMcpJson({ probe: { command: '/bin/echo', args: ['hi'] } });
    const out = resolveProjectAuthority({ projectId, mode: 'cache' });
    const probe = out!.mcpServers.find((m) => m.name === 'probe');
    expect(probe).toBeDefined();
    expect(probe!.scope).toBe('mcp-json');
    // originPath is the trust anchor: without it `awaitMcpTrustDecisions`
    // skips the row outright (mcp_trust_gate.ts:143), which is exactly how
    // SDK-observed servers slip past the gate today.
    expect(probe!.originPath).toBe(path.join(projectPath, '.mcp.json'));
    expect(probe!.config?.command).toBe('/bin/echo');
  });

  test('it is gated on TOFU rather than silently trusted', () => {
    writeMcpJson({ probe: { command: '/bin/echo' } });
    const out = resolveProjectAuthority({ projectId, mode: 'cache' });
    const probe = out!.mcpServers.find((m) => m.name === 'probe');
    // pending_tofu is what makes the gate PROMPT. 'unknown' or 'trusted'
    // would both mean the operator is never asked.
    expect(probe!.trust).toBe('pending_tofu');
  });

  test('an untrusted project does not read it — the spawn will not load it either', () => {
    // The contract for every reader here is "read exactly what the spawn
    // loads". Measured: .mcp.json loads under settingSources ['user',
    // 'project','local'] and NOT under ['user'], so an untrusted single-agent
    // project must not be prompted about a server its Trust setting already
    // blocks.
    setProjectTrusted(projectId, false);
    writeMcpJson({ probe: { command: '/bin/echo' } });
    const out = resolveProjectAuthority({ projectId, mode: 'cache' });
    expect(out!.mcpServers.find((m) => m.name === 'probe')).toBeUndefined();
  });

  test('a bus spawn reads it even for an untrusted project', () => {
    // Bus participants always run with all three scopes regardless of Trust,
    // so the gate must see .mcp.json for them or the blindness persists
    // exactly where the multi-agent blast radius is largest.
    setProjectTrusted(projectId, false);
    writeMcpJson({ probe: { command: '/bin/echo' } });
    const out = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      settingSources: BUS_SETTING_SCOPES,
    });
    expect(out!.mcpServers.find((m) => m.name === 'probe')).toBeDefined();
  });

  test('.mcp.json wins over a same-named settings.json entry', () => {
    // The settings.json row describes a server the CLI never starts. Anchoring
    // the trust decision to it would pin the wrong file and the wrong binary.
    fs.writeFileSync(
      path.join(projectPath, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { probe: { command: '/bin/false' } } }),
    );
    writeMcpJson({ probe: { command: '/bin/echo' } });
    const out = resolveProjectAuthority({ projectId, mode: 'cache' });
    const rows = out!.mcpServers.filter((m) => m.name === 'probe');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scope).toBe('mcp-json');
    expect(rows[0]!.config?.command).toBe('/bin/echo');
  });

  test('env keys are reported as NAMES only (BE-B12)', () => {
    writeMcpJson({ probe: { command: '/bin/echo', env: { SECRET_TOKEN: 'hunter2' } } });
    const out = resolveProjectAuthority({ projectId, mode: 'cache' });
    const probe = out!.mcpServers.find((m) => m.name === 'probe');
    expect(probe!.config?.envKeys).toEqual(['SECRET_TOKEN']);
    expect(JSON.stringify(probe)).not.toContain('hunter2');
  });

  test('absent, malformed and non-file .mcp.json all resolve to no servers', () => {
    // Absent
    expect(_testing.readMcpJsonServers(projectPath, ['project'])).toEqual([]);
    // Malformed
    fs.writeFileSync(path.join(projectPath, '.mcp.json'), '{ not json');
    expect(_testing.readMcpJsonServers(projectPath, ['project'])).toEqual([]);
    // Present but no mcpServers key
    fs.writeFileSync(path.join(projectPath, '.mcp.json'), JSON.stringify({ other: 1 }));
    expect(_testing.readMcpJsonServers(projectPath, ['project'])).toEqual([]);
    // A directory where the file should be — must refuse, not throw.
    fs.rmSync(path.join(projectPath, '.mcp.json'));
    fs.mkdirSync(path.join(projectPath, '.mcp.json'));
    expect(_testing.readMcpJsonServers(projectPath, ['project'])).toEqual([]);
  });

  test('an oversized .mcp.json is refused rather than read into memory', () => {
    // Same H03 ceiling and the same reasoning: a project-controlled file read
    // on the way into a spawn must not be able to exhaust the server.
    fs.writeFileSync(path.join(projectPath, '.mcp.json'), 'x'.repeat(1024 * 1024 + 1));
    expect(_testing.readMcpJsonServers(projectPath, ['project'])).toEqual([]);
  });
});

// ---- ~/.claude.json: the second location that actually loads servers ----
//
// Register x1n.6.23. Before `readClaudeJsonServers`, a server declared here
// reached the spawn as an SDK-observed row with NO `originPath` — and
// `awaitMcpTrustDecisions` skips exactly on that, so it ran with no TOFU
// prompt, no `mcp_trust` row and no `safety_audit` row.
//
// THE FIXTURE IS THE WHOLE TEST. Every case below declares the server ONLY in
// `~/.claude.json` — never in `.mcp.json`, never in a settings layer. A
// fixture that also declared it elsewhere would pass on the broken code,
// because some other reader would have supplied the `originPath`.
describe('readClaudeJsonServers (x1n.6.23) — the ungated class, closed', () => {
  let fakeHome: string;

  beforeEach(() => {
    // The outer beforeEach already redirected home to this dir; re-assert it
    // here because every case below is meaningless if it did not take. The
    // reader calls os.homedir() at CALL time — if that ever moves to
    // module-load time these tests would silently read the real config, which
    // is the failure this guard exists to make loud rather than green.
    fakeHome = path.join(tmpRoot, 'home');
    expect(samePath(os.homedir(), fakeHome)).toBe(true);
    // Platform-independent half of the same guard, and the one that would
    // have caught the Windows break on a POSIX dev machine: os.homedir()
    // consults $HOME on POSIX and %USERPROFILE% on Windows, so redirecting
    // only one passes locally and fails on the other runner. Asserting
    // os.homedir() alone can never detect that from here.
    //
    // BOTH NAMES ARE WRITTEN OUT ON PURPOSE. Looping over `HOME_VARS` looks
    // tidier and is worthless: dropping a name from that list would shrink
    // what the loop checks, so the assertion would still pass on the exact
    // regression it exists to catch. Verified by revert-check — the loop
    // version stayed green with USERPROFILE removed.
    expect(process.env.HOME).toBe(fakeHome);
    expect(process.env.USERPROFILE).toBe(fakeHome);
  });

  const writeClaudeJson = (obj: unknown) =>
    fs.writeFileSync(path.join(os.homedir(), '.claude.json'), JSON.stringify(obj));

  const server = { command: '/usr/local/bin/shady', args: ['--serve'] };

  test('top-level mcpServers is read at EVERY scope, including [user]', () => {
    // Measured: this block loads even under settingSources ['user'], which is
    // what an UNTRUSTED single-agent project runs. Gating it on a scope would
    // leave Cebab silent about a server that still loads.
    writeClaudeJson({ mcpServers: { 'shady-mcp': server } });
    for (const scopes of [['user'], ['user', 'project', 'local']] as const) {
      const out = _testing.readClaudeJsonServers(projectPath, [...scopes]);
      expect(out.map((s) => s.name)).toEqual(['shady-mcp']);
      expect(out[0]!.scope).toBe('claude-json');
      expect(out[0]!.originPath).toBe(path.join(os.homedir(), '.claude.json'));
    }
  });

  test('the per-project block is read only when scopes include local', () => {
    writeClaudeJson({
      projects: { [fs.realpathSync(projectPath)]: { mcpServers: { 'local-mcp': server } } },
    });
    expect(_testing.readClaudeJsonServers(projectPath, ['user'])).toEqual([]);
    expect(_testing.readClaudeJsonServers(projectPath, ['user', 'project'])).toEqual([]);
    expect(
      _testing.readClaudeJsonServers(projectPath, ['user', 'local']).map((s) => s.name),
    ).toEqual(['local-mcp']);
  });

  test('the per-project block is keyed by RESOLVED path, not the literal one', () => {
    // On macOS os.tmpdir() is /var/folders/… -> /private/var/folders/…, so a
    // reader that looks up the unresolved path finds nothing and reports a
    // clean, wrong negative. This asserts we look up what the CLI writes.
    const resolved = fs.realpathSync(projectPath);
    writeClaudeJson({ projects: { [resolved]: { mcpServers: { 'local-mcp': server } } } });
    expect(
      _testing.readClaudeJsonServers(projectPath, ['user', 'local']).map((s) => s.name),
    ).toEqual(['local-mcp']);
  });

  test('env is exposed as NAMES only (BE-B12)', () => {
    writeClaudeJson({
      mcpServers: { 'shady-mcp': { command: 'x', env: { TOKEN: 'super-secret-value' } } },
    });
    const out = _testing.readClaudeJsonServers(projectPath, ['user']);
    expect(out[0]!.config?.envKeys).toEqual(['TOKEN']);
    expect(JSON.stringify(out)).not.toContain('super-secret-value');
  });

  test('absent / malformed / oversized files yield no rows rather than throwing', () => {
    expect(_testing.readClaudeJsonServers(projectPath, ['user'])).toEqual([]);
    fs.writeFileSync(path.join(os.homedir(), '.claude.json'), '{ not json');
    expect(_testing.readClaudeJsonServers(projectPath, ['user'])).toEqual([]);
    fs.writeFileSync(path.join(os.homedir(), '.claude.json'), 'x'.repeat(8 * 1024 * 1024 + 1));
    expect(_testing.readClaudeJsonServers(projectPath, ['user'])).toEqual([]);
  });

  test('resolveProjectAuthority surfaces it with a durable originPath', () => {
    writeClaudeJson({ mcpServers: { 'shady-mcp': server } });
    const out = resolveProjectAuthority({ projectId, mode: 'cache' });
    const row = out!.mcpServers.find((m) => m.name === 'shady-mcp');
    expect(row).toBeDefined();
    expect(row!.scope).toBe('claude-json');
    expect(row!.originPath).toBe(path.join(os.homedir(), '.claude.json'));
  });

  // THE ASSERTION THAT MATTERS. A row with an originPath that still is not
  // gated would satisfy every test above and fix nothing — the bug was never
  // "the panel does not show it", it was "the gate does not stop for it".
  test('[security] the gate now PROMPTS for it, where before it skipped silently', async () => {
    writeClaudeJson({ mcpServers: { 'shady-mcp': server } });
    const resolved = resolveProjectAuthority({ projectId, mode: 'cache' })!;
    const row = resolved.mcpServers.find((m) => m.name === 'shady-mcp')!;

    const sent: ServerMsg[] = [];
    const gateState = makeTrustGateState();
    // The prompt envelope is emitted synchronously; the returned promise then
    // parks on the operator's decision. `mcp_auto_install_pending` is the TOFU
    // prompt — the name is historical (Phase 4a), not a different mechanism.
    const gatePromise = awaitMcpTrustDecisions({
      projectId,
      gate: gateState,
      send: (m: ServerMsg) => sent.push(m),
      servers: [row],
    });
    expect(sent).toHaveLength(1);
    const env = sent[0] as Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>;
    expect(env.type).toBe('mcp_auto_install_pending');
    // Name AND origin, so this cannot pass on a prompt about something else —
    // the originPath IS the durable anchor the register said was missing.
    expect(env.serverName).toBe('shady-mcp');
    expect(env.originPath).toBe(path.join(os.homedir(), '.claude.json'));
    expect(env.reason).toBe('first_seen');

    // Let the operator answer so the parked promise resolves and the gate
    // state is cleaned up rather than left pending for the whole file.
    gateState.pending.get(env.pendingId)!.resolve({ kind: 'allow' });
    expect((await gatePromise).approvals).toBe(1);

    // CONTROL, and it is what makes the line above mean anything: the SAME
    // server shaped as it arrived BEFORE this change — SDK-observed, no
    // originPath — emits nothing at all. Without this the assertion could
    // pass on a gate that prompts for everything.
    const sentBefore: ServerMsg[] = [];
    const outcome = await awaitMcpTrustDecisions({
      projectId,
      gate: makeTrustGateState(),
      send: (m: ServerMsg) => sentBefore.push(m),
      servers: [{ ...row, scope: 'unknown', originPath: undefined }],
    });
    expect(sentBefore).toEqual([]);
    expect(outcome.refused).toEqual([]);
  });
});
