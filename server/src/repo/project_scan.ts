/**
 * Cebab-ws0.6 — the FILE-SCAN tier: what every project declares on disk, read
 * on the project-listing path with no `claude` spawn of any kind.
 *
 * WHY THIS IS NOT `resolveProjectAuthority`. That resolver answers a richer
 * question for ONE project at a time, and three of the things it does are
 * unaffordable once per project per listing:
 *
 *   - `tallyToolUsage` walks every assistant + permission event row of every
 *     session of the project and `JSON.parse`s each one. Unbounded in project
 *     history, and it exists only to decorate `tools` — which is empty here,
 *     because tool names come from an SDK `system/init` payload and no session
 *     has run.
 *   - `enrichWithTrustState` reads and sha256s each MCP server's binary (cap
 *     64 MiB) and runs three DB queries per server. So MCP TOFU state is
 *     deliberately absent from this tier; `Cebab-8g3` carries the measurement.
 *   - `resolveToolAuthority` attributes SDK-reported tool names. Same reason:
 *     there are none without a session.
 *
 * What is left is cheap, and this module composes it from the resolver's own
 * exported pieces rather than re-reading the files itself. That matters more
 * than it looks: a second copy of the read-and-parse logic would inherit this
 * one's refusal semantics (bounded reads, non-regular-file rejection, silent
 * absent-vs-malformed handling) exactly until one of the two changed.
 *
 * DECLARED IS NOT LOADED, AND THE DIFFERENCE IS THE POINT. `readMcpJsonServers`
 * opens with `if (!scopes.includes('project')) return []`, so on an UNTRUSTED
 * project — the default — a `.mcp.json` declaration is not merely inactive, it
 * is invisible: the resolver reports zero declared servers and the panel's best
 * sentence is "project scope not read", which says *we did not look*, never
 * *there is one here and it will not load*. That gap is what this epic was
 * reported for. So this scan reads every scope and marks each declaration with
 * whether the project's current scope set actually loads it.
 *
 * The asymmetry in `~/.claude.json` is deliberate and runs the safe way. Its
 * top-level `mcpServers` block loads at EVERY scope set, `['user']` included —
 * measured, and the one thing Trust demonstrably does not stop. Its
 * `projects[<cwd>]` block loads only under `'local'`. Rather than guess which
 * block a row came from, we ask the reader what loads (trust-derived scopes)
 * and, only when that differs from the full set, ask again what is declared.
 * A name in the second answer but not the first is inert. Getting this
 * backwards would paint an always-loading server as inert, which is the
 * dangerous direction.
 */

import fs from 'node:fs';

import type { McpServerView, ProjectScan, ScannedMcpServer } from '@cebab/shared/protocol';

import {
  detectEnvInjections,
  detectHooks,
  detectMcpServers,
  loadSettingsLayers,
  mcpJsonIsUnreadable,
  readClaudeJsonServers,
  readMcpJsonServers,
  trustDerivedScopes,
  type SettingScope,
} from './project_authority.js';
import type { ProjectRow } from './projects.js';

/** Every scope a settings file can live in — "what is declared", before Trust. */
const ALL_SETTING_SCOPES: readonly SettingScope[] = ['user', 'project', 'local'];

/**
 * Project-owned files whose presence-but-absence-of-data means we failed to
 * read something, rather than that nothing is declared.
 *
 * `readSettingsFile` and `readMcpJsonServers` collapse "absent" and "refused"
 * to the same empty answer on purpose — the resolver wants "no rules from this
 * scope" either way. A summary cannot afford that collapse: rendering "declares
 * nothing" for a project whose settings file is a directory, a FIFO, or invalid
 * JSON would assert the opposite of what is true. So we ask a second, cheap
 * question the readers do not answer — does the path exist at all — and report
 * the combination as `degraded`.
 */
function existsOnDisk(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function scopeLoads(scopes: readonly SettingScope[], scope: string): boolean {
  return (ALL_SETTING_SCOPES as readonly string[]).includes(scope)
    ? scopes.includes(scope as SettingScope)
    : false;
}

/**
 * Fold every declaration source into one name-keyed list.
 *
 * `loads` is OR-ed across duplicate names: a server declared in two places
 * where one of them loads IS loaded, and claiming otherwise would tell the
 * operator an active server is inert.
 */
function foldMcp(entries: { view: McpServerView; loads: boolean }[]): ScannedMcpServer[] {
  const byName = new Map<string, ScannedMcpServer>();
  for (const { view, loads } of entries) {
    const prior = byName.get(view.name);
    if (prior) {
      prior.loads = prior.loads || loads;
      if (!prior.originPath && view.originPath) prior.originPath = view.originPath;
      continue;
    }
    const next: ScannedMcpServer = { name: view.name, loads };
    if (view.originPath) next.originPath = view.originPath;
    byName.set(view.name, next);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/**
 * Scan one project. Never throws: a project whose files cannot be read
 * degrades to an empty `degraded` scan so it cannot take the listing down
 * with it.
 */
export function scanProject(row: ProjectRow, scannedAt: number = Date.now()): ProjectScan {
  const trusted = row.trusted === 1;
  const scopesLoaded = [...trustDerivedScopes(trusted)];
  const empty: ProjectScan = {
    projectId: row.id,
    scannedAt,
    scopesLoaded,
    mcpServers: [],
    hooks: { declared: 0, loaded: 0, hasLocalScope: false },
    envInjections: { declared: 0, loaded: 0 },
    degraded: true,
  };

  try {
    // One read of each settings file, at EVERY scope — the per-item `scope`
    // field is what tells us afterwards whether it loads, so a second pass
    // over the same files would buy nothing.
    const layers = loadSettingsLayers(row.path, ALL_SETTING_SCOPES);

    const declaredMcpJson = readMcpJsonServers(row.path, ALL_SETTING_SCOPES);
    const loadedClaudeJson = readClaudeJsonServers(row.path, scopesLoaded);
    const declaredClaudeJson =
      scopesLoaded.length === ALL_SETTING_SCOPES.length
        ? loadedClaudeJson
        : readClaudeJsonServers(row.path, ALL_SETTING_SCOPES);
    const loadedClaudeJsonNames = new Set(loadedClaudeJson.map((s) => s.name));

    const mcpServers = foldMcp([
      ...detectMcpServers(layers).map((view) => ({
        view,
        loads: scopeLoads(scopesLoaded, view.scope),
      })),
      // `.mcp.json` loads iff the project scope is read — the reader's own gate.
      ...declaredMcpJson.map((view) => ({ view, loads: scopesLoaded.includes('project') })),
      ...declaredClaudeJson.map((view) => ({
        view,
        loads: loadedClaudeJsonNames.has(view.name),
      })),
    ]);

    const hooks = detectHooks(layers);
    const envInjections = detectEnvInjections(layers);

    // A file we could not read is not a file that declares nothing. For the
    // settings layers this is exact and free: `readSettingsFile` returns a
    // parsed object for a valid-but-empty file and `null` only for absent,
    // refused or malformed, so "null but present on disk" is precisely the
    // failure. `.mcp.json` collapses one case more, so it needs the reader's
    // own probe — and only when it already came back empty.
    const unreadable = layers.some((l) => l.data === null && existsOnDisk(l.scopePath));
    const mcpJsonUnreadable = declaredMcpJson.length === 0 && mcpJsonIsUnreadable(row.path);

    return {
      projectId: row.id,
      scannedAt,
      scopesLoaded,
      mcpServers,
      hooks: {
        declared: hooks.length,
        loaded: hooks.filter((h) => scopeLoads(scopesLoaded, h.scope)).length,
        hasLocalScope: hooks.some((h) => h.scope === 'local'),
      },
      envInjections: {
        declared: envInjections.length,
        loaded: envInjections.filter((e) => scopeLoads(scopesLoaded, e.scope)).length,
      },
      degraded: unreadable || mcpJsonUnreadable,
    };
  } catch {
    return empty;
  }
}

/** Scan every project in one pass. One timestamp for the whole pass. */
export function scanProjects(rows: ProjectRow[]): ProjectScan[] {
  const scannedAt = Date.now();
  return rows.map((row) => scanProject(row, scannedAt));
}
