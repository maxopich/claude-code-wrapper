import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  _testing,
  detectEnvInjections,
  detectHooks,
  detectMcpServers,
  resolveProjectAuthority,
  resolveToolAuthority,
} from './project_authority.js';
import { closeDb, getDb } from '../db.js';
import { config } from '../config.js';
import { upsertProject, setProjectTrusted } from './projects.js';

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
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
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
