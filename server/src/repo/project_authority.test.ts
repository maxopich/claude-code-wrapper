import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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
