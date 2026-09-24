import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  EnvInjection,
  HookView,
  McpServerView,
  PermissionRuleView,
  ProjectAuthority,
  ToolView,
} from '@cebab/shared/protocol';
import { isConnected, isSensitiveKey, mcpToolPrefix, toolsForMcpServer } from '@cebab/shared';
import { SCRUBBED_ENV_POSTURES, SCRUBBED_ENV_VAR_NAMES } from '../runner/claude.js';
import { readTextBounded } from '../safe_fs.js';

/**
 * Register H03: ceiling on a project's `.claude/settings*.json`.
 *
 * Real ones are a few KB. 1 MiB leaves enormous headroom for a legitimately
 * baroque config while refusing the multi-gigabyte file that would otherwise
 * be read whole into memory during a pre-spawn resolve.
 */
const MAX_SETTINGS_BYTES = 1024 * 1024;

/**
 * Same ceiling for the project-root `.mcp.json`. Same threat, same shape: it
 * is a project-supplied file read on the way into a spawn.
 */
const MAX_MCP_JSON_BYTES = 1024 * 1024;

/** Project-root MCP manifest. See `readMcpJsonServers` for why this exists. */
const MCP_JSON_FILENAME = '.mcp.json';

/**
 * `~/.claude.json` — the CLI's own state file, and the OTHER place MCP servers
 * actually load from. See `readClaudeJsonServers`.
 *
 * A larger ceiling than its siblings on purpose: this is CLI-managed state, not
 * a hand-written config. It accumulates a block per project the user has ever
 * opened, so it grows without anyone editing it (measured: 138 KB across 62
 * projects on the development machine). 1 MiB would be a live truncation risk
 * within a year of ordinary use, and truncating this file means silently
 * failing to gate a server.
 */
const MAX_CLAUDE_JSON_BYTES = 8 * 1024 * 1024;
const CLAUDE_JSON_FILENAME = '.claude.json';
import { getProject } from './projects.js';
import {
  checkTrust,
  computeBinarySha,
  computeScriptPin,
  firstDecisionTs,
  listForServer,
} from './mcp_trust.js';
import { listSessionsForProject } from './sessions.js';
import { getDb } from '../db.js';

// Cluster B Phase 3 (§4.3): file-read-only resolver for ProjectAuthority.
//
// The resolver does NOT spawn Claude; it reads (a) the cached
// `session_started` snapshot the WS layer already holds (= effective state
// at the runner boundary) and (b) the `.claude/settings*.json` layers
// (= declared provenance), and merges them into a single
// `ProjectAuthority` envelope that the AuthorityPanel (Phase 6+) renders.
//
// The "probe" mode of `get_project_authority` spawns a real (maxTurns:0) SDK
// run for a fresh effective snapshot; that lives in `runner/probe.ts`. NOTHING
// HERE SPAWNS, and that is the invariant to preserve.
//
// This comment used to state the mechanism as "intentionally does not import
// the SDK to keep its surface area small". The conclusion held; the mechanism
// stopped being true. Line 12 imports two name constants from
// `runner/claude.ts`, which imports `query` from the SDK, so the SDK is in
// this module's transitive graph and has been for a while. The constraint that
// actually holds — and the one `repo/project_scan.ts` leans on when it runs
// this file's readers for EVERY project on the listing path — is that no
// function in here calls `query` / `runClaude` / `pickRunner`, and every export
// is synchronous. A synchronous function cannot await a spawn, which is a
// stronger guarantee than an import list anyway.

// ---- settings.json shape ----
//
// We deliberately type only the fields we read. The SDK declares the full
// `Settings` type but pulling it in would couple the resolver to SDK
// internals we don't need.
type RawSettings = {
  permissions?: { allow?: string[]; deny?: string[] };
  /**
   * `Cebab-aklg`: which plugins are on, keyed `name@marketplace`. An explicit
   * `false` means the operator turned one off, so the value has to be read
   * rather than the key's presence — see `detectPluginHooks`.
   *
   * USER TIER ONLY, measured in the bundled CLI: its plugin-enable lookup walks
   * `["userSettings","flagSettings","policySettings"]` and never consults
   * project or local. Cebab's scope set contains `'user'` in both the trusted
   * and untrusted branch, so this key is live regardless of Trust.
   */
  enabledPlugins?: Record<string, boolean>;
  env?: Record<string, string | null | undefined>;
  mcpServers?: Record<
    string,
    | {
        command?: string;
        args?: string[];
        env?: Record<string, unknown>;
        /** `Cebab-6fax.25`: http/sse transports. A stdio server has neither. */
        url?: string;
        headers?: Record<string, unknown>;
      }
    | undefined
  >;
  hooks?: Record<
    string,
    Array<{
      hooks?: Array<{
        type?: string;
        command?: string;
        args?: string[];
      }>;
    }>
  >;
};

/**
 * `~/.claude.json`, typed to the two blocks we read. The real file carries
 * dozens of other keys (caches, counters, per-project usage stats) — none of
 * them are our business and none are typed here, deliberately: this file is
 * read for MCP declarations only.
 */
type ClaudeJson = {
  mcpServers?: RawSettings['mcpServers'];
  projects?: Record<string, { mcpServers?: RawSettings['mcpServers'] } | undefined>;
};

/** A `settings.json` scope the SDK can be told to layer in. Structurally the
 *  same set as `runner/claude.ts`'s `SettingSource`. */
export type SettingScope = 'user' | 'project' | 'local';

export type SettingsLayer = {
  scope: SettingScope;
  scopePath: string;
  data: RawSettings | null;
};

/**
 * `~/.claude/settings.json`, resolved at CALL time.
 *
 * This was a module-level const, and that made it the one reader in this file
 * a HOME redirect could not reach: `os.homedir()` runs once at import, before
 * any test can point it somewhere empty. `readClaudeJsonServers` beside it has
 * always resolved at call time and has a test pinning that. The asymmetry cost
 * nothing in production — homedir does not change under a running server — and
 * everything in a test, where a frozen path means the user-scope layer quietly
 * reads the DEVELOPER'S real settings and any count assertion becomes a
 * property of whose machine ran it.
 */
function userScopePath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * MCP server names Cebab itself injects. Only these may carry
 * `scope: 'cebab-injected'`, which grants an automatic `trust: 'trusted'`
 * (`enrichWithTrustState`) and a skip in `awaitMcpTrustDecisions`.
 *
 * Keep in sync with the `mcpServers` keys in `bus/runner.ts`'s
 * `runOneAttempt` — and keep it MINIMAL. `bus` used to be listed here for the
 * deprecation alias; now that the alias is gone, leaving it would mean a
 * participant's own server named `bus` — one Cebab does not inject and never
 * saw in a settings layer — is laundered into permanently-trusted and skipped
 * by TOFU. Only add a name here when `runOneAttempt` actually registers it.
 */
const CEBAB_INJECTED_MCP_NAMES: ReadonlySet<string> = new Set(['cebab_bus']);

/**
 * Read + parse a `.claude/settings.json` (or `.claude/settings.local.json`).
 * Returns `null` for "file absent" and "file unreadable" alike — the
 * inspector treats both as "no rules from this scope" (vs. a noisy error).
 * Malformed JSON logs a console.warn so a misconfigured operator notices
 * once on session start.
 */
function readSettingsFile(p: string): RawSettings | null {
  // Register H03: this file belongs to the PROJECT, so on an untrusted one it
  // is attacker-controlled, and this runs during the pre-spawn authority
  // resolve — on the way into every session start. It used to be a bare
  // `fs.readFileSync(p, 'utf8')`: a FIFO left at `.claude/settings.json`
  // parked the single-threaded event loop for the whole server, and a
  // multi-gigabyte file exhausted memory. `readFileBounded` opens once with
  // O_NONBLOCK, fstats that descriptor (not the path — closing the TOCTOU
  // swap window), rejects non-regular files and caps the size.
  const read = readTextBounded(p, MAX_SETTINGS_BYTES);
  if (!read.ok) {
    // 'unreadable' covers the ENOENT case this function has always treated
    // as a silent "no rules from this scope". The other refusals mean the
    // path exists but is hostile or absurd, which the operator should hear
    // about exactly once — same posture as malformed JSON below.
    if (read.refusal !== 'unreadable') {
      console.warn(`[project_authority] refused to read ${p}: ${read.refusal}`);
    }
    return null;
  }
  try {
    return JSON.parse(read.text) as RawSettings;
  } catch (e: unknown) {
    console.warn(`[project_authority] could not parse ${p}: ${String(e)}`);
    return null;
  }
}

/**
 * Read the project-root `.mcp.json` — the only project-scoped location the
 * CLI actually loads MCP servers from.
 *
 * WHY THIS EXISTS. Everything else in this module attributes MCP servers from
 * `mcpServers` blocks in `.claude/settings*.json`. That key is **not loaded at
 * any scope**, reading `system/init.mcp_servers`:
 *
 *   <proj>/.claude/settings.json        → mcpServers  → NOT loaded
 *   ...the same + enableAllProjectMcpServers: true    → NOT loaded
 *   <proj>/.claude/settings.local.json  → mcpServers  → NOT loaded
 *   ~/.claude/settings.json             → mcpServers  → NOT loaded
 *   <proj>/.mcp.json                                  → LOADED, 'connected'
 *
 * RE-MEASURED 2026-09-09 on SDK 0.3.251 / CLI 2.1.212 by `mcp_scope_smoke.ts`
 * Parts 2-3, which is what makes this table a measurement rather than a
 * remembered one. It had been four hand-run rows from a single 0.3.201 session,
 * restated verbatim in a test that only ever asserted `.mcp.json` behaviour —
 * so the sentence and its "test" agreed with each other and neither ran the
 * case. Two things changed on the re-run: `settings.local.json` was never in
 * the table at all (the `'local'` scope was assumed to behave like `'project'`),
 * and the user-scope row was believed unmeasurable. It is not — `CLAUDE_CONFIG_DIR`
 * relocates the whole user scope, and the probe breaks at `system/init` so it
 * never needs the credentials a redirect hides. Every row now runs with a
 * positive control in the same spawn.
 *
 * `mcpOriginLoads` (`@cebab/shared`) is the predicate this table justifies, and
 * the reason it is worth keeping honest: the TOFU gate, the probe refusal and
 * the sidebar's scan line all skip these rows on its authority (`Cebab-6fax.42`).
 *
 * `~/.claude.json` was missing from that table and is now measured too — see
 * `readClaudeJsonServers`. Both of its blocks load, so `.mcp.json` was never
 * "the only" loading location; it was the only one anyone had checked.
 *
 * So before this function the TOFU gate could only ever prompt about
 * declarations that would never run, while the servers that DO run reached
 * the spawn with no prompt, no `mcp_trust` row and no `safety_audit` row.
 * The gate was watching the wrong file.
 *
 * SCOPE GATING is not a nicety — it is the contract `loadSettingsLayers`
 * documents: read exactly what the spawn will load. `.mcp.json` loads iff the
 * spawn's `settingSources` includes `'project'` (measured: `['user']` and `[]`
 * do not load it, `['user','project','local']` does). Since `Cebab-6fax.21.1`
 * that is every TRUSTED project, single-agent turn and bus participant alike —
 * and reading it for an untrusted one either way would prompt the operator
 * about a server their Trust setting already prevents from loading.
 *
 * Returns `[]` for absent / unreadable / malformed, matching
 * `readSettingsFile`'s "no rules from this scope" posture.
 */
export function readMcpJsonServers(
  projectPath: string,
  scopes: readonly SettingScope[],
): McpServerView[] {
  if (!scopes.includes('project')) return [];

  const p = path.join(projectPath, MCP_JSON_FILENAME);
  // Bounded + TOCTOU-safe for the same reasons as `readSettingsFile`: this is
  // a project-controlled path read during a pre-spawn resolve.
  const read = readTextBounded(p, MAX_MCP_JSON_BYTES);
  if (!read.ok) {
    if (read.refusal !== 'unreadable') {
      console.warn(`[project_authority] refused to read ${p}: ${read.refusal}`);
    }
    return [];
  }

  let parsed: RawSettings;
  try {
    parsed = JSON.parse(read.text) as RawSettings;
  } catch (e: unknown) {
    console.warn(`[project_authority] could not parse ${p}: ${String(e)}`);
    return [];
  }
  if (!parsed?.mcpServers) return [];

  const out: McpServerView[] = [];
  for (const [name, conf] of Object.entries(parsed.mcpServers)) {
    if (!conf) continue;
    const envKeys = conf.env ? Object.keys(conf.env) : undefined;
    const config: McpServerView['config'] & object = {};
    if (typeof conf.command === 'string') config.command = conf.command;
    if (Array.isArray(conf.args)) config.args = conf.args;
    if (envKeys && envKeys.length > 0) config.envKeys = envKeys;
    applyRemoteIdentity(config, conf);
    const view: McpServerView = {
      name,
      status: 'unknown',
      scope: 'mcp-json',
      originPath: p,
      tools: [],
      trust: 'unknown',
    };
    // `Cebab-6fax.25`: `Object.keys` rather than a list of field names. The
    // list form is what hid the http/sse case — a remote declaration sets url
    // and headerNames and NONE of command/args/envKeys, so its config was
    // built and then dropped on the floor, and the identity digest with it.
    if (Object.keys(config).length > 0) view.config = config;
    out.push(view);
  }
  return out;
}

/**
 * Fold an http/sse declaration's endpoint and header NAMES onto the view, and
 * compute the identity digest that covers them.
 *
 * `Cebab-6fax.25`. The TOFU identity is name + origin + command + args + binary
 * sha. An http/sse declaration has none of those — no command, no args, nothing
 * to hash — so every remote server under one name shared one identity, and the
 * URL could be re-pointed at a different host with headers added or removed and
 * no re-prompt. TOFU is "the only brake" on user-scope MCP servers (CLAUDE.md);
 * a brake whose identity omits where the traffic goes measures the wrong thing.
 *
 * ABSENT WHEN THERE IS NOTHING TO COVER, which is what keeps this from being a
 * flag day. An ordinary stdio server with no `env` block produces no digest, so
 * its identity is byte-identical to before and it does not re-prompt. A server
 * that DOES have a url, headers or env has, by definition, never had those
 * covered — so a one-time re-approval there is the fix working, not a
 * regression.
 *
 * VALUES ARE EXCLUDED — see `identityDigest`'s own note. Header values are
 * bearer tokens that rotate; env values likewise. Re-prompting on a rotation is
 * daily noise, and an operator who approves daily without reading is the
 * failure this is supposed to prevent.
 */
function applyRemoteIdentity(
  config: NonNullable<McpServerView['config']>,
  conf: { url?: unknown; headers?: Record<string, unknown> | undefined },
): void {
  if (typeof conf.url === 'string' && conf.url.length > 0) config.url = conf.url;
  const headerNames =
    conf.headers && typeof conf.headers === 'object' ? Object.keys(conf.headers).sort() : [];
  if (headerNames.length > 0) config.headerNames = headerNames;

  const covered = {
    url: config.url ?? null,
    headerNames,
    envKeys: [...(config.envKeys ?? [])].sort(),
  };
  if (covered.url === null && headerNames.length === 0 && covered.envKeys.length === 0) return;
  config.identityDigest = crypto.createHash('sha256').update(JSON.stringify(covered)).digest('hex');
}

/**
 * Read `~/.claude.json` — the CLI's own state file, and the second place MCP
 * servers actually load from.
 *
 * WHY THIS EXISTS. `readMcpJsonServers` above closed the gap for
 * project-declared servers. What was left reached a spawn with **no
 * `originPath`**, so `mcp_trust_gate` skipped it (the `!server.originPath`
 * check) and it ran with no TOFU prompt, no `mcp_trust` row and no
 * `safety_audit` row. Register `x1n.6.23` guessed this was where they came
 * from and could not act on it, because a runtime-observed server has no
 * durable anchor to key `(server_name, origin_path, binary_sha)` on. Reading
 * the declaration gives it one: this file's path.
 *
 * MEASURED against SDK 0.3.201 (same method as the table above — a bogus
 * `command` in each location, read back off `system/init.mcp_servers`, with
 * `.mcp.json` as the positive control):
 *
 *   ~/.claude.json  mcpServers                       → LOADED at EVERY scope
 *                                                      set, ['user'] included
 *   ~/.claude.json  projects[<cwd>].mcpServers       → LOADED iff scopes
 *                                                      include 'local'
 *   <proj>/.mcp.json (control)                       → LOADED iff 'project'
 *
 * The first row is the one that matters most and is easy to miss: **top-level
 * `mcpServers` loads under `['user']`**, which is what an UNTRUSTED
 * single-agent project runs. The Trust toggle stops a project's own
 * `settings.local.json` from loading; it does not stop this. So a
 * `claude mcp add --scope user` server reaches every Cebab spawn regardless of
 * Trust, and before this function it did so ungated.
 *
 * KEYED BY RESOLVED PATH. The `projects` block is keyed by the CLI's resolved
 * cwd. Measured: a key written with an UNRESOLVED path matches nothing — on
 * macOS `/var/folders/…` is a symlink to `/private/var/…`, so looking up the
 * raw path silently finds no servers and reports a clean, wrong negative. We
 * look up the realpath and fall back to the literal path only when the
 * directory cannot be resolved.
 *
 * Returns `[]` for absent / unreadable / malformed, matching
 * `readSettingsFile`'s "no rules from this scope" posture.
 */
/**
 * True iff `<projectPath>/.mcp.json` exists but could not be read or parsed.
 *
 * `readMcpJsonServers` above returns `[]` for absent, refused, malformed AND
 * valid-but-declaring-nothing alike — the right collapse for a resolver, which
 * wants "no servers from this file" either way. A per-project SUMMARY cannot
 * afford it: rendering "declares nothing" for a project whose `.mcp.json` is a
 * directory, a FIFO or invalid JSON asserts the opposite of what is true.
 *
 * Lives here rather than in the caller so it shares this module's cap and
 * filename constants; a copy next to the summary would drift from the reader
 * it is meant to describe. Only worth calling when the reader already returned
 * nothing, which is when the ambiguity exists.
 */
export function mcpJsonIsUnreadable(projectPath: string): boolean {
  const p = path.join(projectPath, MCP_JSON_FILENAME);
  const read = readTextBounded(p, MAX_MCP_JSON_BYTES);
  if (!read.ok) {
    // `unreadable` covers "absent" and "permission denied" both; only the
    // latter is a degradation, and existence is what separates them.
    return read.refusal !== 'unreadable' || fs.existsSync(p);
  }
  try {
    JSON.parse(read.text);
    return false;
  } catch {
    return true;
  }
}

export function readClaudeJsonServers(
  projectPath: string,
  scopes: readonly SettingScope[],
): McpServerView[] {
  const p = path.join(os.homedir(), CLAUDE_JSON_FILENAME);
  const read = readTextBounded(p, MAX_CLAUDE_JSON_BYTES);
  if (!read.ok) {
    if (read.refusal !== 'unreadable') {
      console.warn(`[project_authority] refused to read ${p}: ${read.refusal}`);
    }
    return [];
  }

  let parsed: ClaudeJson;
  try {
    parsed = JSON.parse(read.text) as ClaudeJson;
  } catch (e: unknown) {
    console.warn(`[project_authority] could not parse ${p}: ${String(e)}`);
    return [];
  }

  const out: McpServerView[] = [];
  const push = (block: RawSettings['mcpServers'] | undefined) => {
    if (!block) return;
    for (const [name, conf] of Object.entries(block)) {
      if (!conf) continue;
      // A name already taken by the other block in the SAME file: keep the
      // first. Both anchor to this path, so the trust row is identical either
      // way and there is nothing to choose between them.
      if (out.some((v) => v.name === name)) continue;
      const envKeys = conf.env ? Object.keys(conf.env) : undefined;
      const config: NonNullable<McpServerView['config']> = {};
      if (typeof conf.command === 'string') config.command = conf.command;
      if (Array.isArray(conf.args)) config.args = conf.args;
      if (envKeys && envKeys.length > 0) config.envKeys = envKeys;
      // `Cebab-6fax.25`: same identity extension as `.mcp.json`. This file is
      // where `claude mcp add --scope user` writes — the servers Trust does not
      // reach and TOFU is the only brake on.
      applyRemoteIdentity(config, conf);
      const view: McpServerView = {
        name,
        status: 'unknown',
        scope: 'claude-json',
        originPath: p,
        tools: [],
        trust: 'unknown',
      };
      // `Cebab-6fax.25`: `Object.keys` rather than a list of field names. The
      // list form is what hid the http/sse case — a remote declaration sets url
      // and headerNames and NONE of command/args/envKeys, so its config was
      // built and then dropped on the floor, and the identity digest with it.
      if (Object.keys(config).length > 0) view.config = config;
      out.push(view);
    }
  };

  // Unconditional: measured to load at every scope set Cebab passes, including
  // the `['user']` an untrusted project runs. Gating it on a scope would make
  // Cebab stop prompting for a server that still loads.
  push(parsed.mcpServers);

  if (scopes.includes('local')) {
    let key: string;
    try {
      key = fs.realpathSync(projectPath);
    } catch {
      key = projectPath;
    }
    push(parsed.projects?.[key]?.mcpServers);
  }
  return out;
}

/**
 * Collect the settings layers for a project, for a GIVEN scope set.
 *
 * The scope set must be the one the spawn this resolution gates will
 * actually pass to the SDK — that is the whole contract. Reading fewer
 * layers than the spawn loads makes the inspector and, far worse, the
 * spawn gates (`awaitMcpTrustDecisions` / `awaitEnvInjectionAck`) blind to
 * rules that then execute.
 *
 * Two callers, ONE rule since `Cebab-6fax.21.1` — both trust-derived:
 *   - single-agent — `trustDerivedScopes(trusted)`, matching `ws/server.ts`.
 *   - bus participants — `busSettingScopesFor(projectId)`, which is that same
 *     function over the participant project's own row, read per hop. The
 *     literal `['user','project','local']` the register sites used to pass
 *     regardless of Trust is gone from the bus path.
 *
 * `settingSourcesUsed` on the resolved authority reflects whatever was
 * passed, so the AuthorityPanel never claims a layer that wasn't applied.
 */
/**
 * Read the `settings.json` layers for an explicit scope set. Exported for
 * `repo/project_scan.ts`, which needs the same layers this resolver builds but
 * none of the expensive work that follows them (Cebab-ws0.6) — sharing the
 * reader rather than re-implementing it is the point: a second copy would
 * inherit this one's refusal and parse semantics only until one of them
 * changed.
 */
export function loadSettingsLayers(
  projectPath: string,
  scopes: readonly SettingScope[],
): SettingsLayer[] {
  const layers: SettingsLayer[] = [];
  for (const scope of scopes) {
    if (scope === 'user') {
      const userPath = userScopePath();
      layers.push({ scope: 'user', scopePath: userPath, data: readSettingsFile(userPath) });
      continue;
    }
    const scopePath = path.join(
      projectPath,
      '.claude',
      scope === 'project' ? 'settings.json' : 'settings.local.json',
    );
    layers.push({ scope, scopePath, data: readSettingsFile(scopePath) });
  }
  return layers;
}

/**
 * The scope set a project's run uses, derived from Trust. Single-agent AND
 * multi-agent bus alike: _trusted_ → all three layers (its `.claude/settings*`
 * hooks and env injectors and its `.mcp.json` load), _untrusted_ → `['user']`
 * (they do not). Mirrors `ws/server.ts`'s single-agent
 * `const settingSources = trusted ? [...] : [...]`.
 */
export function trustDerivedScopes(trusted: boolean): readonly SettingScope[] {
  return trusted ? (['user', 'project', 'local'] as const) : (['user'] as const);
}

/**
 * The scope set a BUS participant rooted in `projectId` runs under, read from
 * that project's CURRENT Trust — `Cebab-6fax.21.1`. This is THE one function
 * every bus scope decision goes through: the per-hop spawn (`bus/runner.ts`
 * reads it at turn time, so a mid-run Trust toggle applies on the participant's
 * next hop) AND every spawn gate (`gateProjectsForSpawn`) resolve MCP/env/hook
 * authority against it. Routing both through one function is what stops the
 * spawn and the gate disagreeing about a participant's scopes — the divergence
 * that previously let an UNTRUSTED worker's project-declared MCP servers,
 * `env:` block and hooks load with all three layers while the operator's Trust
 * toggle said `['user']`. `bus/scope_conformance.test.ts` pins the shared use.
 *
 * A missing project row resolves to untrusted (`['user']`) — the safe default,
 * and structurally unreachable in practice since the spawn was already gated on
 * the row existing.
 *
 * ONE FUNCTION IS NOT ONE MOMENT. The gate calls this at session start, at
 * `addWorker` and on the R-B Continue path; the spawn calls it every hop. They
 * cannot disagree about what a Trust value means, and they can disagree about
 * the value — a Trust elevation mid-run spawns wider than the gate ever saw
 * (`Cebab-ipbr`).
 */
export function busSettingScopesFor(projectId: number): readonly SettingScope[] {
  return trustDerivedScopes(getProject(projectId)?.trusted === 1);
}

/**
 * Normalize a permissions.allow / .deny entry to the tool name it
 * targets. SDK permission strings are either bare tool names (`"Read"`)
 * or tool-with-input patterns (`"Bash(echo:*)"`); both attribute to the
 * tool itself (`"Read"` / `"Bash"`). Patterns past Phase 3's matching
 * granularity (regex etc.) still attribute to the leftmost identifier.
 */
function ruleTargetTool(rule: string): string {
  const parenIdx = rule.indexOf('(');
  return (parenIdx === -1 ? rule : rule.slice(0, parenIdx)).trim();
}

/**
 * `Cebab-0viu`: does exact equality FAIL to settle whether a rule targeting
 * `target` covers `toolName`, in a way the CLI's own matcher might still
 * resolve either direction?
 *
 * DETECTION, NOT EVALUATION. This says only "exact equality cannot answer this
 * and a glob matcher might" — it never decides which tools the rule covers.
 * Reimplementing the CLI's glob semantics is out of scope (a guessed glob would
 * agree with itself and could be wrong), so the two cases here are exactly the
 * ones the CLI documents that carry no exact-match answer:
 *
 *   - a wildcard target (`mcp__github__*`, `mcp__*`, `Bash*`), and
 *   - the bare-server form `mcp__<server>` — an `mcp__`-prefixed proper prefix
 *     of the tool name, which carries no `*` but which the CLI's help text lists
 *     alongside `mcp__*`. The `__` boundary is what distinguishes the real
 *     server prefix `mcp__github` (of `mcp__github__create_issue`) from a
 *     coincidental string prefix like `mcp__git`.
 *
 * A target equal to the tool name is settled by exact equality and is NOT
 * unevaluated. `Bash(*)` / `Bash(echo:*)` reduce to the target `Bash` (the
 * paren argument is stripped by `ruleTargetTool`), so against tool `Bash` they
 * are exact matches and correctly excluded — the wildcard lives in the argument
 * the CLI matches separately, not in the tool identity.
 */
function ruleIsUnevaluatable(target: string, toolName: string): boolean {
  if (target === toolName) return false;
  const star = target.indexOf('*');
  if (star !== -1) {
    // RELEVANCE, still not evaluation. Everything before the first `*` must be
    // a literal prefix of the tool name — a necessary condition under ANY
    // semantics where `*` stands for a run of characters, so applying it
    // decides nothing the CLI might decide differently. Without it, one
    // wildcard rule anywhere made EVERY tool report "cannot decide":
    // `mcp__slack__*` flagged `Read` and `Bash`, `mcp__*` flagged `Read`. That
    // trades a wrong answer on a few rows for a non-answer on all of them,
    // which is not what "silence beats a confident wrong answer" licenses.
    return toolName.startsWith(target.slice(0, star));
  }
  return target.startsWith('mcp__') && toolName.startsWith(`${target}__`);
}

/**
 * Walk a single tool through every settings layer and return the merged
 * allow/deny decision per spec BE-B7. Convention (matches SDK):
 *
 *   - deny wins over allow
 *   - if multiple scopes match, the DEEPEST one wins (local > project > user),
 *     matching the SDK's settingSources merging (`runner/claude.ts:80`)
 *   - no matching rule → not allowed, not denied, rulingScope='default'
 *     (i.e. the SDK applies its built-in fallback)
 *
 * The agentic-reviewer §6.4 "tool denied by SDK not in any visible deny
 * list" divergence is precisely the `rulingScope='default' + denied=false`
 * + at-runtime-denied case — Phase 3 surfaces it via `rulingScope`, Phase
 * 10's usage-diff highlights it in the "Attempted-but-denied" column.
 */
export function resolveToolAuthority(
  toolName: string,
  layers: SettingsLayer[],
  options?: { mcpServers?: McpServerView[] },
): ToolView {
  let allowScope: 'user' | 'project' | 'local' | null = null;
  let denyScope: 'user' | 'project' | 'local' | null = null;
  // `Cebab-0viu`: rules that mention this tool but that exact equality cannot
  // settle. Collected from both the allow and the deny list — a glob in either
  // is a rule Cebab does not evaluate — so the panel can say "cannot decide"
  // instead of asserting "not allowed". Stays empty (→ field absent) whenever
  // every rule matched, or missed, by exact equality.
  const unevaluatedRules: NonNullable<ToolView['unevaluatedRules']> = [];
  for (const layer of layers) {
    if (!layer.data?.permissions) continue;
    const allowList = layer.data.permissions.allow ?? [];
    const denyList = layer.data.permissions.deny ?? [];
    if (allowList.some((r) => ruleTargetTool(r) === toolName)) {
      allowScope = layer.scope;
    }
    if (denyList.some((r) => ruleTargetTool(r) === toolName)) {
      denyScope = layer.scope;
    }
    for (const rule of [...allowList, ...denyList]) {
      if (ruleIsUnevaluatable(ruleTargetTool(rule), toolName)) {
        unevaluatedRules.push({ rule, scope: layer.scope });
      }
    }
  }
  // mcp__<server>__<tool> conventions: if the named MCP server is
  // `needs-auth`/`disabled`/`failed`, the tool is effectively unavailable
  // regardless of allow/deny (BE-B6). We surface this as denied=true with
  // rulingScope='default' so the AuthorityPanel can render it distinctly
  // from operator-declared denies — the ruling came from MCP runtime
  // status, NOT from any settings-layer rule.
  let mcpUnavailable = false;
  let source: ToolView['source'] = 'builtin';
  let mcpServer: string | undefined;
  if (toolName.startsWith('mcp__')) {
    // Server names themselves may contain underscores (e.g. 'cebab_bus'),
    // so we can't match `[^_]+`. The `__` (double underscore) is the
    // delimiter — find the FIRST occurrence after the 'mcp__' prefix.
    const sepIdx = toolName.indexOf('__', 5);
    if (sepIdx > 5) {
      source = 'mcp';
      mcpServer = toolName.slice(5, sepIdx);
      // Cebab-as7x: match on the TOOL PREFIX, not on the raw name. The CLI
      // replaces every character outside [A-Za-z0-9_] when it builds a tool
      // name, so `s.name === mcpServer` found nothing for any server carrying a
      // space or a dot — every claude.ai connector — and this whole branch
      // quietly did not run for them. The failure direction was the dangerous
      // one: a `needs-auth` connector's tools were presented as available.
      const owner = options?.mcpServers?.find((s) => mcpToolPrefix(s.name) === mcpServer);
      // Conservative: anything other than "connected" treated as unavailable.
      // The predicate is shared (`Cebab-ws0.15`) so this view, the operator's
      // banner and the model's note cannot drift apart about one session.
      if (owner && !isConnected(owner)) {
        mcpUnavailable = true;
      }
    }
  }
  // The cebab_bus injection is identity-pinned by Cebab (`bus/runner.ts`).
  // Surface its origin distinctly so the operator can see it isn't from
  // their own MCP config.
  if (mcpServer === 'cebab_bus') {
    source = 'cebab-injected';
  }
  const denied = denyScope !== null || mcpUnavailable;
  const allowed = !denied && allowScope !== null;
  // Ruling priority: explicit deny > explicit allow > 'default'. When the
  // ruling came from an MCP cascade (not a settings-layer rule), we report
  // 'default' even if allow was granted at user/project/local — the deny
  // doesn't trace back to a visible rule.
  const rulingScope: ToolView['rulingScope'] = mcpUnavailable
    ? 'default'
    : (denyScope ?? allowScope ?? 'default');
  const view: ToolView = {
    name: toolName,
    source,
    allowed,
    denied,
    rulingScope,
  };
  if (mcpServer) view.mcpServer = mcpServer;
  // Absent, not `[]`, when nothing was skipped — the wire contract.
  if (unevaluatedRules.length > 0) view.unevaluatedRules = unevaluatedRules;
  return view;
}

/**
 * Scan every settings layer for `env:` keys matching the credential-class
 * list (`SCRUBBED_ENV_VAR_NAMES`). Returns one row per (envKey, scope)
 * tuple — the operator may have the same key declared at multiple layers
 * and the inspector needs to surface every one so edits don't miss a
 * sibling declaration.
 *
 * BE-B11: detection covers every credential-class key. BE-B12 [security]:
 * we never read the VALUE the operator put in `settings.json`; only the
 * key's presence + posture hint + whether `process.env` currently has
 * something for it. A screenshot of the AuthorityPanel must not leak the
 * operator's token.
 */
/**
 * EVERY key of every layer's `env:` block, deduped, in no particular order.
 *
 * `Cebab-en70`: distinct from `detectEnvInjections` below, which filters to
 * names that are credential-SHAPED (on the scrub list, or matching the
 * redactor's key heuristic) because its job is to decide what to PROMPT the
 * operator about. That filter is exactly wrong for redaction: the names it
 * drops — `MAPBOX_PK`, `SENTRY_DSN`, `OPENAI_ORG` — are the ones the redactor's
 * own spelling heuristic already misses, so reusing it would have built a
 * feature that helps only where help was not needed.
 *
 * An `env:` block is the operator saying "inject these values into the agent's
 * environment". For a share-safe artifact, masking all of them is the
 * defensible direction: over-masking costs a log line's readability, and
 * under-masking ships a key.
 */
export function declaredEnvKeys(layers: SettingsLayer[]): string[] {
  const out = new Set<string>();
  for (const layer of layers) {
    if (!layer.data?.env) continue;
    for (const key of Object.keys(layer.data.env)) out.add(key);
  }
  return [...out];
}

export function detectEnvInjections(layers: SettingsLayer[]): EnvInjection[] {
  const out: EnvInjection[] = [];
  const scrubbed = new Set(SCRUBBED_ENV_VAR_NAMES);
  for (const layer of layers) {
    if (!layer.data?.env) continue;
    for (const envKey of Object.keys(layer.data.env)) {
      // Register H05: this used to be `if (!scrubbed.has(envKey)) continue`,
      // i.e. only the five Anthropic/cloud-backend switches counted. But this
      // list is what `session_start_gate.awaitEnvInjectionAck` gates on, and
      // it returns immediately when the list is EMPTY — so a project
      // declaring `env: { GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, NPM_TOKEN }`
      // produced no gate, no operator prompt and no audit row, while the SDK
      // layered those values straight into the agent's spawn env.
      //
      // `isSensitiveKey` is the redactor's own key heuristic, shared rather
      // than re-implemented, so a name masked in a transcript is a name
      // prompted for here. Fail-closed by design: it will also match things
      // like AUTH_ENABLED or TOKEN_LIMIT, and asking about a non-credential
      // is a far cheaper mistake than silently shipping a real one.
      if (!scrubbed.has(envKey) && !isSensitiveKey(envKey)) continue;
      out.push({
        envKey,
        scope: layer.scope,
        scopePath: layer.scopePath,
        posture: SCRUBBED_ENV_POSTURES[envKey] ?? 'credential-class env injection',
        // Whether the operator's CURRENT process env has this key — orthogonal
        // to settings.json's declared value (which we deliberately never read).
        isSet: typeof process.env[envKey] === 'string' && process.env[envKey] !== '',
      });
    }
  }
  return out;
}

/**
 * Scan every settings layer for `hooks:` declarations. Per spec §11.1
 * (agentic-reviewer) the AuthorityPanel surfaces every hook so the
 * operator can see what's been pre-wired before committing to a session
 * start; UI-B40 force-expands the section when any hook is at the local
 * tier (least-trusted).
 *
 * SDK shape: `hooks: { [hookKind]: [{ hooks: [{ type, command, args }] }] }`
 * — the outer array is matcher buckets, the inner is concrete hook entries.
 * We flatten because the AuthorityPanel renders one card per concrete
 * entry regardless of matcher grouping.
 *
 * `binarySha` (sha256 of the resolved hook command's binary target) is
 * computed in Phase 4 alongside the TOFU MCP gate — Phase 3 just enumerates.
 */
export function detectHooks(layers: SettingsLayer[]): HookView[] {
  const out: HookView[] = [];
  for (const layer of layers) {
    if (!layer.data?.hooks) continue;
    for (const [hookKind, buckets] of Object.entries(layer.data.hooks)) {
      if (!Array.isArray(buckets)) continue;
      for (const bucket of buckets) {
        const entries = bucket?.hooks;
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (typeof entry.command !== 'string') continue;
          const view: HookView = {
            hookKind,
            scope: layer.scope,
            scopePath: layer.scopePath,
            command: entry.command,
          };
          if (Array.isArray(entry.args)) view.args = entry.args;
          out.push(view);
        }
      }
    }
  }
  return out;
}

/**
 * Every `permissions.allow` / `.deny` entry across the given layers, verbatim
 * (`Cebab-tzz7`).
 *
 * WHY THIS EXISTS. `resolveToolAuthority` above answers the allow/deny question
 * per TOOL, by walking the loaded layers — so it can only ever describe rules
 * in a scope the resolve actually read. On an untrusted project the project and
 * local layers are absent, and there the operator's accumulated
 * `settings.local.json` allow-rules live. Every one of them resolves against
 * nothing: a tool a rule would pre-approve prompts anyway, and no `ToolView`
 * carries any trace that a rule was declared — "we did not look" rendered as
 * "there is no rule", the exact blind spot `detectHooks` /
 * `readMcpJsonServers` closed for the other two declaration kinds.
 *
 * This is the DECLARED form: the raw rule string, its effect and its scope. It
 * is deliberately NOT resolved per-tool the way `resolveToolAuthority` is — the
 * point is to name what sits inert on disk, not to re-run the CLI's matcher
 * against a surface that will not load anyway. The caller passes the UNLOADED
 * scopes only; a rule the resolve already applied rides its tool's `ToolView`.
 */
export function detectPermissionRules(layers: SettingsLayer[]): PermissionRuleView[] {
  const out: PermissionRuleView[] = [];
  for (const layer of layers) {
    const perms = layer.data?.permissions;
    if (!perms) continue;
    for (const rule of perms.allow ?? []) out.push({ rule, effect: 'allow', scope: layer.scope });
    for (const rule of perms.deny ?? []) out.push({ rule, effect: 'deny', scope: layer.scope });
  }
  return out;
}

/**
 * Hooks that a plugin brings, which no settings layer declares (`Cebab-aklg`).
 *
 * WHAT WAS WRONG. `detectHooks` above iterates `SettingsLayer[]`, and a
 * SettingsLayer is only `~/.claude/settings.json`, `.claude/settings.json` and
 * `.claude/settings.local.json`. No plugin manifest was ever read. The CLI, by
 * contrast, registers plugin hooks into the SAME registry as settings hooks —
 * it logs `Loading hooks from plugin: <name>` and pushes them onto the
 * PreToolUse / PostToolUse / SessionStart / … arrays. So the panel's hooks row
 * said "none" while hooks definitely ran.
 *
 * Not hypothetical on the machine this was found on: the enabled `beads` plugin
 * ships `SessionStart` and `PreCompact` entries that execute on every turn, on
 * every project. A row that says "no hooks" while a hook runs is the panel
 * asserting a wrong answer, not omitting an unknown one.
 *
 * TRUST DOES NOT GATE ANY OF IT, and that is the part worth showing rather than
 * merely fixing. `enabledPlugins` is read from the USER tier only, and Cebab's
 * scope set contains `'user'` in both its trusted and untrusted branch — so an
 * operator who turns Trust OFF to stop a project's hooks is still running
 * these, and nothing told them so.
 *
 * WHY IT IS NOT FOLDED INTO `detectHooks`. That function is on the hot path:
 * `repo/project_scan.ts` runs it for EVERY project on every `projects` message
 * (measured at ~3.98 ms for 21 projects, which is the budget that justifies its
 * existence). Plugin hooks are account-wide and identical for every project, so
 * paying three extra file reads per project to learn the same answer 21 times
 * is the wrong trade. This is called from the panel's resolve only — opened
 * deliberately, once.
 *
 * Read failures are silent and yield nothing, matching every other reader here:
 * a malformed plugin manifest must not take down the panel.
 */
export function detectPluginHooks(): HookView[] {
  const out: HookView[] = [];

  const settings = readSettingsFile(userScopePath());
  const enabled = settings?.enabledPlugins;
  if (!enabled || typeof enabled !== 'object') return out;

  const installedPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  const installedRaw = readTextBounded(installedPath, MAX_SETTINGS_BYTES);
  if (!installedRaw.ok) return out;
  let installed: { plugins?: Record<string, { installPath?: string }[]> };
  try {
    installed = JSON.parse(installedRaw.text) as typeof installed;
  } catch {
    return out;
  }

  for (const [pluginId, isEnabled] of Object.entries(enabled)) {
    // `enabledPlugins` carries explicit `false` entries for plugins the
    // operator turned off. Those load nothing and must not be reported.
    if (isEnabled !== true) continue;
    const installPath = installed.plugins?.[pluginId]?.[0]?.installPath;
    if (typeof installPath !== 'string' || installPath.length === 0) continue;

    const manifestPath = path.join(installPath, '.claude-plugin', 'plugin.json');
    const manifestRaw = readTextBounded(manifestPath, MAX_SETTINGS_BYTES);
    if (!manifestRaw.ok) continue;
    let manifest: { hooks?: Record<string, { hooks?: { command?: unknown; args?: unknown }[] }[]> };
    try {
      manifest = JSON.parse(manifestRaw.text) as typeof manifest;
    } catch {
      continue;
    }
    if (!manifest.hooks || typeof manifest.hooks !== 'object') continue;

    // Same flattening as `detectHooks`: the outer array is matcher buckets,
    // the inner is concrete entries, and the panel renders one card per entry.
    for (const [hookKind, buckets] of Object.entries(manifest.hooks)) {
      if (!Array.isArray(buckets)) continue;
      for (const bucket of buckets) {
        const entries = bucket?.hooks;
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (typeof entry.command !== 'string') continue;
          const view: HookView = {
            hookKind,
            scope: 'plugin',
            scopePath: manifestPath,
            pluginId,
            command: entry.command,
          };
          if (Array.isArray(entry.args)) view.args = entry.args as string[];
          out.push(view);
        }
      }
    }
  }
  return out;
}

/**
 * Project MCP servers from each settings layer into McpServerView rows.
 * Phase 3 attributes scope via SDK precedence (deepest wins) so a server
 * declared at user AND local gets one row attributed to local — matching
 * what the SDK actually uses. The `originPath` points at the winning
 * layer's settings file so the operator can `[Open settings.json]` on the
 * right file.
 *
 * Phase 4 fills in the TOFU fields (`trust`, `binarySha`, `firstSeenAt`,
 * `lastSeenAt`) via a JOIN against `mcp_trust` (see
 * `enrichWithTrustState`). Without the enrichment pass the row stays
 * `trust: 'unknown'` — the resolver's orchestrator always runs the JOIN,
 * but callers (tests, etc.) can use `detectMcpServers` alone if they
 * don't want the DB hit.
 *
 * Effective status (`status: 'connected' | 'needs-auth' | …`) is overlaid
 * from the cached `session_started.mcpServers` at merge time — settings
 * declarations alone can't say whether a server is actually running.
 */
export function detectMcpServers(layers: SettingsLayer[]): McpServerView[] {
  // Map<name, [scope, scopePath, config]> — last write wins (deepest scope).
  const byName = new Map<
    string,
    {
      scope: McpServerView['scope'];
      scopePath: string;
      config: { command?: string; args?: string[]; envKeys?: string[] };
    }
  >();
  for (const layer of layers) {
    if (!layer.data?.mcpServers) continue;
    for (const [name, conf] of Object.entries(layer.data.mcpServers)) {
      if (!conf) continue;
      const envKeys = conf.env ? Object.keys(conf.env) : undefined;
      const config: { command?: string; args?: string[]; envKeys?: string[] } = {};
      if (typeof conf.command === 'string') config.command = conf.command;
      if (Array.isArray(conf.args)) config.args = conf.args;
      if (envKeys && envKeys.length > 0) config.envKeys = envKeys;
      byName.set(name, { scope: layer.scope, scopePath: layer.scopePath, config });
    }
  }
  const out: McpServerView[] = [];
  for (const [name, entry] of byName.entries()) {
    const view: McpServerView = {
      name,
      // Overlaid by the merger when cached session_started is available.
      status: 'unknown',
      scope: entry.scope,
      originPath: entry.scopePath,
      tools: [],
      trust: 'unknown',
    };
    if (entry.config.command || entry.config.args || entry.config.envKeys) {
      view.config = entry.config;
    }
    out.push(view);
  }
  return out;
}

/**
 * Cluster B Phase 4 (§4.4): TOFU enrichment pass. For each declared MCP
 * server with a resolvable command, computes the binary sha and looks up
 * the trust state in `mcp_trust`. Mutates the views in-place and returns
 * them for chaining.
 *
 * Mapping from repository lookup → protocol enum:
 *   - `trusted` / `trusted_pinned_hash` → `trust: 'trusted'`
 *   - `denied_remember`                  → `trust: 'denied'`
 *   - `hash_changed`                     → `trust: 'hash_changed'`
 *   - `script_changed`                   → `trust: 'script_changed'` (Cebab-1af)
 *   - `first_seen`                       → `trust: 'pending_tofu'`
 *
 * `Cebab-6fax.42.1`: when the file pin comes back `oversized` — the declaration
 * names more files (or more candidate tokens) than the budget can hash — the row
 * is `trust: 'pin_oversized'` (carrying which ceiling it hit in
 * `pinOversizedReason`). A pin cannot be built, so the only honest states are
 * "refuse" or "store a null that silently stops protecting", and this module
 * exists to never do the latter. The gate refuses a `pin_oversized` server; the
 * panel tells the operator to shrink the declaration. But the trust LOOKUP still
 * runs first, because a STANDING DENIAL outranks the oversized refusal: an
 * operator who already denied this server keeps `trust: 'denied'` (audited under
 * their own reason), not a `pin_oversized` relabel.
 *
 * `projectPath` is the spawn cwd, and it is required rather than derived from
 * `originPath`: relative tokens in a declaration resolve against the directory
 * the CLI runs in, not against the file the declaration was read from — the two
 * differ for every server declared in `~/.claude.json`.
 *
 * Cebab-injected servers (`scope: 'cebab-injected'`, e.g. `cebab_bus`)
 * are always `trust: 'trusted'` — Cebab pins them, no operator decision
 * is needed. They skip the lookup.
 *
 * `lastSeenAt` comes from `listForServer` (most-recent first). `firstSeenAt`
 * comes from `firstDecisionTs`, i.e. the append-only `safety_audit` chain —
 * NOT from the oldest surviving lookup row, which is a different question.
 * `mcp_trust` replaces rows it supersedes, so its oldest survivor answers
 * "the oldest decision not yet overwritten"; on the non-null-sha path that has
 * never equalled the first decision, and register D09's migration 033 makes the
 * null-sha path behave the same way. Both absent when the server has never had
 * a recorded decision.
 */
export function enrichWithTrustState(views: McpServerView[], projectPath: string): McpServerView[] {
  for (const view of views) {
    if (view.scope === 'cebab-injected') {
      view.trust = 'trusted';
      continue;
    }
    if (!view.originPath) continue;
    const candidateSha = view.config?.command ? computeBinarySha(view.config.command) : null;
    if (candidateSha !== null) view.binarySha = candidateSha;
    // Cebab-1af: and the files the declaration RUNS, which `binary_sha` never
    // covered — it hashes the command, and the command is `node`.
    const pin = computeScriptPin(view.config?.command ?? '', view.config?.args ?? [], projectPath);
    const scriptShas = pin.kind === 'pinned' ? pin.shas : null;
    if (scriptShas !== null) view.scriptShas = scriptShas;
    // Cebab-rxg: the DECLARATION is part of the lookup, not just the command's
    // hash. `computeBinarySha` returns null for every non-absolute command, so
    // `npx`, `node` and `bash` shared one identity and a rewritten `.mcp.json`
    // matched the row the operator had approved for a different program.
    //
    // `Cebab-6fax.42.1`: the lookup runs BEFORE the `pin_oversized` short-circuit
    // on purpose. A STANDING DENIAL outranks the oversized refusal — the operator
    // already decided this server does not run, and re-labelling it `pin_oversized`
    // would audit their denial under the wrong reason and lose its `denied` chip.
    const lookup = checkTrust({
      serverName: view.name,
      originPath: view.originPath,
      candidateSha,
      command: view.config?.command ?? '',
      args: view.config?.args ?? [],
      candidateScriptShas: scriptShas,
      // `Cebab-6fax.25`: the url / header names / env names, for the
      // declarations whose identity command-and-args cannot express.
      ...(view.config?.identityDigest !== undefined
        ? { identityDigest: view.config.identityDigest }
        : {}),
    });
    if (lookup.decision === 'denied_remember') {
      // A standing denial wins over everything, including an oversized pin.
      view.trust = 'denied';
    } else if (pin.kind === 'oversized') {
      // `Cebab-6fax.42.1`: a declaration too large to pin degrades to a REFUSAL,
      // not to a silent null. There is no pin to compare and no decision to
      // offer; storing null here is the very bug (`no later spawn can report
      // script_changed`) this state replaces. Carry which ceiling it hit so the
      // panel can name the real trigger.
      view.trust = 'pin_oversized';
      view.pinOversizedReason = pin.reason;
    } else {
      switch (lookup.decision) {
        case 'trusted':
        case 'trusted_pinned_hash':
          view.trust = 'trusted';
          break;
        // `denied_remember` is handled above the pin_oversized branch (a standing
        // denial outranks the refusal), so it cannot reach here.
        case 'declaration_changed':
          view.trust = 'declaration_changed';
          break;
        case 'hash_changed':
          view.trust = 'hash_changed';
          break;
        case 'script_changed':
          view.trust = 'script_changed';
          // The diff is computed once, here, and carried on the view. The gate
          // renders it; recomputing it there would be a second read of the same
          // files with a window in between.
          view.scriptChanges = lookup.changedPaths.map((token) => ({
            path: token,
            previousSha: lookup.previousShas[token],
            sha: lookup.candidateShas[token],
          }));
          break;
        case 'first_seen':
          view.trust = 'pending_tofu';
          break;
      }
    }
    // Decision history → first/last seen, from the two sources that actually
    // answer each question: the lookup for "most recent", the audit chain for
    // "first ever".
    const history = listForServer(view.name, view.originPath);
    if (history.length > 0) {
      view.lastSeenAt = history[0].ts;
    }
    const firstTs = firstDecisionTs(view.name, view.originPath);
    if (firstTs !== null) {
      view.firstSeenAt = firstTs;
    }
  }
  return views;
}

/**
 * Cluster B Phase 10 (UI-B31 / spec §4.8): per-tool usage tally across every
 * session in a project.
 *
 * The "Used vs Available" inspector (`<ToolsList mode='usage-diff'>`) wants
 * two counters on every `ToolView`:
 *   - `calledCount` — how many times the SDK ran this tool (post-permission)
 *   - `deniedCount` — how many times the operator denied a request for it
 *
 * Both signals live in the `events` table, which already records every SDK
 * message via `persistMessage()`. We don't add new instrumentation — just an
 * aggregation pass (spec §4.8: "every tool call already produces an SDK
 * event with `tool_name + ts + result_status`. No new instrumentation;
 * just retention + aggregation."). Three event shapes feed the tally:
 *
 *   - `type='assistant'` rows whose `message.content` contains a
 *     `tool_use` block — the SDK actually invoked the tool. Each block
 *     bumps `calledCount[name]`.
 *   - `type='wrapper' subtype='permission_request'` rows carry
 *     `{ requestId, toolName }` — we index them so we can resolve a
 *     denial's `requestId` back to a tool name.
 *   - `type='wrapper' subtype='permission_decided'` rows carry
 *     `{ requestId, decision }` — when `decision === 'deny'`, we look up
 *     the toolName via the requestId index and bump `deniedCount[name]`.
 *
 * The two passes happen in a single SQL fetch + JS aggregation. We
 * deliberately don't try to surface "SDK refused at runtime" denials
 * (tool_result with is_error=true) — those are usually input-shape
 * failures rather than authorization signals and would muddy the
 * "Attempted-but-denied" column the operator reads for trust intent.
 *
 * Stream events are excluded from `events` (see `persistMessage()` line
 * 23-24 — `stream_event` short-circuits before insert), so we don't
 * double-count tool_use blocks that arrive both as deltas and again in
 * the final assistant message.
 *
 * Sessions with no events (newly-created) contribute zero rows. Projects
 * with no sessions return an empty Map — the resolver then leaves every
 * `ToolView.calledCount` / `deniedCount` undefined, which the
 * AuthorityPanel renders as "(no usage yet)" rather than zero badges.
 */
export type ToolUsageTally = Map<string, { calledCount: number; deniedCount: number }>;

export function tallyToolUsage(projectId: number): ToolUsageTally {
  const sessions = listSessionsForProject(projectId);
  if (sessions.length === 0) return new Map();
  const sessionIds = sessions.map((s) => s.id);
  // Bind every session id as a positional parameter — better-sqlite3 won't
  // bind an array in a single placeholder, so we expand. The list is
  // bounded by the operator's per-project session count (typically <100).
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare<string[], { type: string; subtype: string | null; raw: string }>(
      `SELECT type, subtype, raw FROM events
        WHERE session_id IN (${placeholders})
          AND (
            type = 'assistant'
            OR (type = 'wrapper' AND (subtype = 'permission_request' OR subtype = 'permission_decided'))
          )`,
    )
    .all(...sessionIds);

  const tally: ToolUsageTally = new Map();
  const reqToTool = new Map<string, string>();

  for (const r of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(r.raw);
    } catch {
      // A row with non-JSON raw is broken at persistence time; skip rather
      // than poison the tally for one bad row.
      continue;
    }

    if (r.type === 'assistant') {
      // SDK shape: { type: 'assistant', message: { content: ContentBlock[] }, ... }
      const content = (payload as { message?: { content?: unknown } })?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'tool_use' &&
          typeof (block as { name?: unknown }).name === 'string'
        ) {
          bumpCalled(tally, (block as { name: string }).name);
        }
      }
    } else if (r.type === 'wrapper' && r.subtype === 'permission_request') {
      const p = payload as { requestId?: unknown; toolName?: unknown };
      if (typeof p.requestId === 'string' && typeof p.toolName === 'string') {
        reqToTool.set(p.requestId, p.toolName);
      }
    } else if (r.type === 'wrapper' && r.subtype === 'permission_decided') {
      const p = payload as { requestId?: unknown; decision?: unknown };
      if (p.decision === 'deny' && typeof p.requestId === 'string') {
        const toolName = reqToTool.get(p.requestId);
        if (toolName) bumpDenied(tally, toolName);
      }
    }
  }
  return tally;
}

function bumpCalled(t: ToolUsageTally, name: string): void {
  const cur = t.get(name);
  if (cur) cur.calledCount += 1;
  else t.set(name, { calledCount: 1, deniedCount: 0 });
}

function bumpDenied(t: ToolUsageTally, name: string): void {
  const cur = t.get(name);
  if (cur) cur.deniedCount += 1;
  else t.set(name, { calledCount: 0, deniedCount: 1 });
}

/**
 * Cluster B Phase 3 (BE-B3): resolver entry point. Given a `projectId` and
 * (optionally) the most recent `session_started` snapshot the WS layer has
 * cached for any session in this project, return the merged
 * `ProjectAuthority` envelope.
 *
 * Cache-miss behavior: when `latestSessionStarted` is undefined, the
 * resolver still returns a snapshot — populated from file-read scans only.
 * Tools / agents / slash_commands / skills / plugins come from the SDK
 * init payload, so they'll be empty (the AuthorityPanel renders
 * "Authority snapshot unavailable; start a session to populate" in that
 * case). The settings-declared data (MCP servers, env injections, hooks,
 * allow/deny rules) is still useful pre-flight.
 *
 * Probe mode (`mode === 'probe'`) is handled by the CALLER, not here: the WS
 * `get_project_authority` handler runs `probeSessionStarted` and writes the
 * result into the same per-connection cache a real turn fills, then calls this
 * resolver unchanged. This function stays synchronous and file-read-only, and
 * `mode` is carried on the input only so the envelope can report which kind of
 * resolve produced it.
 */
export type ResolverInput = {
  /**
   * `Cebab-qz7m`: whether to decorate the tool list with per-tool usage counts.
   *
   * The tally exists for ONE reader — the authority panel's usage-diff mode.
   * It walks every `assistant` row and every permission wrapper row across
   * every session of the project and JSON.parses each, synchronously.
   * Measured: ~1.4 us per event, so 150 ms at 100k events and 281 ms at 200k.
   *
   * The pre-spawn gate resolves before every message and reads exactly three
   * fields of the result — `mcpServers`, `detectedEnvInjections`, `hooks`. It
   * never touches `tools`, so it was paying that walk and throwing it away, on
   * every message, growing with how long the project had been used.
   *
   * DEFAULTS TO `'tally'`, and that direction is deliberate: a caller who
   * forgets to think about this pays performance, not correctness. The opposite
   * default would silently empty the panel's usage columns for the next caller
   * who forgets — a wrong answer rather than a slow one.
   */
  toolUsage?: 'tally' | 'skip';
  projectId: number;
  mode: 'cache' | 'probe';
  /**
   * Scope set to resolve against. Omit for the trust-derived default, which
   * is what the AuthorityPanel and the single-agent spawn gate want.
   *
   * A BUS spawn gate passes `busSettingScopesFor(projectId)` — the SAME
   * trust-derived scopes the participant will spawn with (`Cebab-6fax.21.1`).
   * That value equals the trust-derived default here, so passing it is belt
   * and suspenders; it is passed explicitly so the gate and the spawn read
   * from one shared function and can never resolve against different scopes.
   */
  settingSources?: readonly SettingScope[];
  latestSessionStarted?: {
    tools?: string[];
    model?: string;
    apiKeySource?: string;
    permissionMode?: string;
    cwd?: string;
    mcpServers?: { name: string; status: string }[];
    slashCommands?: string[];
    skills?: string[];
    agents?: string[];
    plugins?: { name: string; path: string }[];
    /**
     * `Cebab-ajvv`: `serverName → CLI scope label`, captured by the authority
     * probe. Used ONLY to attribute an undeclared SDK-reported server (the
     * `scope: 'unknown'` append below); it never touches a file-declared row and
     * feeds no gate. Absent when no probe captured it.
     */
    mcpScopes?: ReadonlyMap<string, string>;
  };
};

export function resolveProjectAuthority(input: ResolverInput): ProjectAuthority | null {
  const project = getProject(input.projectId);
  if (!project) return null;

  const trusted = project.trusted === 1;
  const scopes = input.settingSources ?? trustDerivedScopes(trusted);
  const layers = loadSettingsLayers(project.path, scopes);
  const settingSourcesUsed = layers.map((l) => l.scope);

  // MCP servers: declared shape from layers, overlaid with effective status
  // from the cached session_started (when present).
  //
  // `.mcp.json` is merged in FIRST and wins on a name collision, because it is
  // the declaration that actually loads — a same-named `mcpServers` entry in
  // `.claude/settings.json` describes a server the CLI never starts (see
  // `readMcpJsonServers`). Letting the settings row win would anchor the trust
  // decision to the wrong file and the wrong binary path.
  const declaredMcp = detectMcpServers(layers);
  // `~/.claude.json` is merged on the same rule and for the same reason: both
  // it and `.mcp.json` are measured to load, and a settings row of the same
  // name is a declaration the CLI never starts. `.mcp.json` is applied LAST so
  // it wins a collision between the two loading files — an arbitrary but fixed
  // choice (which one the CLI itself prefers on a duplicate name is not
  // measured), and it preserves the precedence that shipped first.
  for (const fromLoadingFile of [
    ...readClaudeJsonServers(project.path, scopes),
    ...readMcpJsonServers(project.path, scopes),
  ]) {
    const clash = declaredMcp.findIndex((d) => d.name === fromLoadingFile.name);
    if (clash >= 0) declaredMcp.splice(clash, 1);
    declaredMcp.push(fromLoadingFile);
  }
  const initMcp = input.latestSessionStarted?.mcpServers ?? [];
  for (const dm of declaredMcp) {
    const init = initMcp.find((m) => m.name === dm.name);
    if (init) dm.status = init.status;
  }
  // SDK-reported servers that aren't in any settings layer get appended.
  //
  // `scope: 'cebab-injected'` means "Cebab itself injected this", and
  // `enrichWithTrustState` grants those `trust: 'trusted'` unconditionally
  // while `mcp_trust_gate` skips them entirely. So the label must be reserved
  // for servers Cebab actually injects — otherwise a server merely OBSERVED in
  // a prior session's `session_started` (e.g. a project-scope one that the
  // trust-truncated layer read missed) gets laundered into permanently
  // trusted-and-never-prompted.
  //
  // Anything else unattributable stays `scope: 'unknown'` + `trust: 'unknown'`
  // so it is visible in the panel.
  //
  // STILL NOT GATED, and the class that reaches here has shrunk twice. An
  // appended row has no `originPath`, so `awaitMcpTrustDecisions` skips it at
  // the `!server.originPath` check, and its `trust: 'unknown'` would hit the
  // silent-continue case immediately after anyway. (An earlier version of this
  // comment claimed these "still reach TOFU" — they never did.)
  //
  // `readMcpJsonServers` removed project-declared servers from this class;
  // `readClaudeJsonServers` removed the `claude mcp add` ones at both scopes,
  // which register x1n.6.23 correctly guessed were the bulk of the remainder.
  // What is left is servers with NO on-disk declaration Cebab can find —
  // plugin-provided ones, and anything a future CLI loads from a location not
  // in the measured table above. Those genuinely have no durable anchor to key
  // `(server_name, origin_path, binary_sha)` on, so they stay visible-but-
  // ungated by design rather than by omission.
  const mcpScopes = input.latestSessionStarted?.mcpScopes;
  for (const im of initMcp) {
    if (!declaredMcp.some((d) => d.name === im.name)) {
      const isCebabInjected = CEBAB_INJECTED_MCP_NAMES.has(im.name);
      const row: McpServerView = {
        name: im.name,
        status: im.status,
        scope: isCebabInjected ? 'cebab-injected' : 'unknown',
        tools: [],
        trust: 'unknown',
      };
      // `Cebab-ajvv`: label a genuinely undeclared server with the CLI's own
      // scope, when a probe captured one. LABEL ONLY — `scope` stays `'unknown'`
      // and `trust` stays `'unknown'`, so it grants nothing; it just tells the
      // operator a claude.ai connector came from `claudeai` rather than reading
      // as an unattributable mystery. Never applied to a `cebab-injected` row —
      // that label is Cebab's own and outranks whatever the CLI calls the bus.
      if (!isCebabInjected) {
        const reported = mcpScopes?.get(im.name);
        if (reported !== undefined) row.reportedScope = reported;
      }
      declaredMcp.push(row);
    }
  }
  // Phase 4 (§4.4): JOIN against mcp_trust to populate per-row TOFU
  // state. Runs after the cebab-injected append so those rows get
  // 'trusted' via the same pass (no operator decision needed for
  // Cebab-pinned servers).
  enrichWithTrustState(declaredMcp, project.path);

  // Cebab-66y: what this project declares in scopes the current scope set does
  // NOT load. For a trusted single-agent project (and every bus participant)
  // the scope set is all three, so these stay empty. For an UNTRUSTED project
  // (scopes = ['user']) they are where the project's own `.claude/settings.json`
  // hooks and `.mcp.json` servers live — declared, real, and inert until Trust
  // is turned on. The panel renders them as "declared but not loaded" rather
  // than asserting "none declared", the exact contradiction with the sidebar
  // tier (`repo/project_scan.ts`) this bead was filed to remove.
  //
  // These feed NO gate. Only the LOADED lists above (`declaredMcp`, and the
  // hook/env scans below, all resolved against `scopes`) reach
  // `refuseUnapprovedForProbe` / `awaitMcpTrustDecisions` / `awaitEnvInjectionAck`.
  // Surfacing an inert declaration to a gate would make it prompt about a
  // server or hook the spawn never starts — the mirror of the bug this fixes.
  const unloadedScopes = trustDerivedScopes(true).filter((s) => !scopes.includes(s));
  // Read the unloaded layers ONCE and derive every unloaded-declaration list
  // from them — hooks, permission rules and (below) `.mcp.json` servers all
  // describe the same files. `detectHooks([])` / `detectPermissionRules([])`
  // return `[]`, so the empty-scope case needs no guard.
  const unloadedLayers =
    unloadedScopes.length > 0 ? loadSettingsLayers(project.path, unloadedScopes) : [];
  const unloadedHooks: HookView[] = detectHooks(unloadedLayers);
  // Cebab-tzz7: the third declaration kind Trust gates. `resolveToolAuthority`
  // only ever describes rules in a LOADED scope (it walks `layers`), so an
  // untrusted project's own allow/deny rules resolve against nothing and leave
  // no trace on any `ToolView` — the panel would render every tool as if no
  // rule mentioned it. Name the inert rules here, exactly as `unloadedHooks`
  // does for the scope's hooks.
  const unloadedPermissionRules: PermissionRuleView[] = detectPermissionRules(unloadedLayers);

  // Only the two files whose servers the CLI actually loads can be "declared
  // but not loaded": `.mcp.json` (loads iff 'project' is read) and
  // `~/.claude.json`'s per-project block (loads iff 'local' is read). A
  // settings-layer `mcpServers` key never loads at any scope, so its absence
  // from the loaded list is not a Trust artifact and it is not surfaced here as
  // if Trust would make it load.
  const unloadedMcpServers: McpServerView[] = [];
  const loadedMcpNames = new Set(declaredMcp.map((d) => d.name));
  if (!scopes.includes('project')) {
    // `Cebab-6fax.42`: NO name filter on this loop, unlike the one below.
    //
    // It ran only when `'project'` is absent from `scopes` — in which case
    // `readMcpJsonServers(path, scopes)` returned `[]` and no `.mcp.json` row
    // can be in `declaredMcp` at all. So the filter could only ever suppress a
    // row because a DIFFERENT file happened to declare the same name, which is
    // exactly backwards: the merge loop forty lines up pushes `.mcp.json` LAST
    // and splices out the clash, so with Trust ON the `.mcp.json` declaration
    // is the one Cebab reports as loading. The panel was hiding the single row
    // whose behaviour the Trust toggle changes — and, because that row has its
    // own `originPath`, it needs a TOFU decision the operator had never been
    // shown.
    for (const s of readMcpJsonServers(project.path, ['project'])) {
      unloadedMcpServers.push(s);
    }
  }
  if (!scopes.includes('local')) {
    // `['user', 'local']` returns the always-loading top-level block (already
    // in `declaredMcp`) plus the per-project block that needs 'local'; the
    // name filters below keep only the latter. The `loadedMcpNames` filter
    // STAYS here, unlike on the `.mcp.json` loop above: these two blocks live
    // in the same file and anchor to the same `originPath`, so a name in both
    // is one declaration, not two.
    for (const s of readClaudeJsonServers(project.path, ['user', 'local'])) {
      if (!loadedMcpNames.has(s.name) && !unloadedMcpServers.some((u) => u.name === s.name)) {
        unloadedMcpServers.push(s);
      }
    }
  }
  if (unloadedMcpServers.length > 0) enrichWithTrustState(unloadedMcpServers, project.path);

  // Tools: every tool name the SDK reported, attributed against layers +
  // MCP availability. When the cache is empty, no tools are resolved
  // (operator opens an empty Tools section).
  const initTools = input.latestSessionStarted?.tools ?? [];

  // Cebab-as7x: attribute the session's tools to the servers that contributed
  // them. Every construction site above fills `tools: []` because it builds a
  // row from a DECLARATION, where the tool list is not yet known; the tool list
  // only exists once a session has started, which is here. Without this the
  // panel's per-server count read "0 tools" for every server, which is the only
  // affordance that answers "which of these is actually giving me anything" on
  // a project with several.
  //
  // Unguarded on purpose. The obvious `if (initTools.length > 0)` wrapper was
  // written first, with a comment claiming it preserved the distinction between
  // "we did not look" and "it contributed none" — and a revert-check showed it
  // changed nothing: with no snapshot `initTools` is `[]`, so the filter
  // assigns `[]` and the guard is a no-op. Shipping it would have been a
  // comment asserting a semantic the code cannot express. The distinction is
  // real and it lives one level up, on `ProjectAuthority.sdkSnapshot`, which
  // says outright whether an init was ever seen.
  for (const server of declaredMcp) {
    server.tools = toolsForMcpServer(server.name, initTools);
  }

  const tools: ToolView[] = initTools.map((t) =>
    resolveToolAuthority(t, layers, { mcpServers: declaredMcp }),
  );

  // Cluster B Phase 10 (UI-B31 / spec §4.8): attach the usage tally so the
  // ToolsList's usage-diff mode can render Used + Attempted-but-denied
  // counts per tool. Tally walks the project's persisted `events` rows;
  // missing names in `initTools` (e.g. a tool the operator denied that
  // was later removed from the SDK's surface) are silently ignored — the
  // operator can still see total denies for the current surface, which is
  // the most-asked question. A future enhancement could surface "denied
  // but no longer on surface" as its own row when that edge case matters.
  //
  // Cebab-8ml: guarded on a non-empty tool surface. The tally only ever
  // decorates `tools`, which is empty whenever there is no cached SDK
  // snapshot (`initTools = []`) — the common case on the pre-spawn gate
  // (`gateProjectsForSpawn`, before every single spawn). The walk itself is
  // unbounded in project history (`listSessionsForProject`, then a SELECT
  // over every event row of every session, JSON.parsed per row), so running
  // it to decorate nothing was pure waste that grew with how long the
  // project had been used. Nothing downstream changes: the loop below is a
  // no-op over an empty `tools`, so an empty tally is byte-identical output.
  // `Cebab-qz7m`: the `initTools.length > 0` guard was the whole protection
  // here, and its own comment (Cebab-8ml) explains why it was thought
  // sufficient — "tools is empty whenever there is no cached SDK snapshot, the
  // common case on the pre-spawn gate". Probe-on-selection (Cebab-ws0.7) ended
  // that: the selection probe fills the connection's authority cache, the gate
  // passes it in, and by the time the operator sends a message the snapshot
  // exists. The guard stayed green and stopped guarding.
  const tally: ToolUsageTally =
    input.toolUsage !== 'skip' && initTools.length > 0
      ? tallyToolUsage(input.projectId)
      : new Map();
  for (const tool of tools) {
    const counts = tally.get(tool.name);
    if (!counts) continue;
    // Leave undefined when zero so the AuthorityPanel can distinguish
    // "tool exists on surface but nobody has tried it" from "tool was
    // tried zero times" — both are the same number but the former is the
    // expected default and shouldn't paint a chip.
    if (counts.calledCount > 0) tool.calledCount = counts.calledCount;
    if (counts.deniedCount > 0) tool.deniedCount = counts.deniedCount;
  }

  const out: ProjectAuthority = {
    projectId: input.projectId,
    capturedAt: Date.now(),
    fromProbe: input.mode === 'probe',
    // Empty and unmeasured are different facts. Without this the panel had to
    // guess from `model === undefined`, and guessed wrong in the direction
    // that asserts the project has nothing.
    sdkSnapshot: input.latestSessionStarted !== undefined,
    settingSourcesUsed,
    tools,
    mcpServers: declaredMcp,
    slashCommands: input.latestSessionStarted?.slashCommands ?? [],
    skills: input.latestSessionStarted?.skills ?? [],
    agents: input.latestSessionStarted?.agents ?? [],
    plugins: input.latestSessionStarted?.plugins ?? [],
    hooks: detectHooks(layers),
    // Cebab-aklg: alongside, never merged. `hooks` feeds the per-project hook
    // TOFU ledger (`reportHookObservations`); an account-wide plugin hook
    // folded in there would write one identical row per project and announce
    // itself once per project. The panel joins the two for display; the ledger
    // must not.
    pluginHooks: detectPluginHooks(),
    detectedEnvInjections: detectEnvInjections(layers),
    unloadedHooks,
    unloadedMcpServers,
    unloadedPermissionRules,
  };
  // Pick-through cached single-value fields.
  if (input.latestSessionStarted?.model !== undefined) {
    out.model = input.latestSessionStarted.model;
  }
  if (input.latestSessionStarted?.apiKeySource !== undefined) {
    out.apiKeySource = input.latestSessionStarted.apiKeySource;
  }
  if (input.latestSessionStarted?.permissionMode !== undefined) {
    out.permissionMode = input.latestSessionStarted.permissionMode;
  }
  if (input.latestSessionStarted?.cwd !== undefined) {
    out.cwd = input.latestSessionStarted.cwd;
  }
  return out;
}

// Re-exported for the resolver test suite — they don't need a real DB and
// pass settings layers directly.
export const _testing = {
  loadSettingsLayers,
  readSettingsFile,
  readMcpJsonServers,
  readClaudeJsonServers,
  userScopePath,
};
