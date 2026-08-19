import type { ProjectScan } from '@cebab/shared/protocol';

/**
 * Cebab-ws0.6 — the second line of a project row: what this agent declares on
 * disk, without a session having run.
 *
 * WHY IT IS NOT BLANK WHEN THERE IS NOTHING. "Declares nothing" and "nothing
 * has looked" are different facts, and a blank strip asserts the second while
 * meaning the first. That distinction is the reason the authority panel exists
 * at all (Cebab-ys9), and it is doubly load-bearing here because this strip
 * renders for every project at once — a row of blanks would read as "Cebab
 * knows nothing about any of these".
 *
 * WHY DECLARED, NOT LOADED, IS THE HEADLINE NUMBER. The reported case that
 * started this epic was an untrusted project whose `.mcp.json` server produced
 * no tools and whose declaration was invisible everywhere in the UI. Counting
 * only what loads would reproduce that exactly. So the counts are what is on
 * disk, and a single warn chip carries the "and Trust is keeping some of it
 * out" half — one place to say it, rather than a qualifier on every chip.
 *
 * The warn chip also does work the trust pill cannot. That pill is about
 * permissions ("auto-approve tools" vs "ask"); Trust separately decides which
 * SETTING FILES load, and operators conflate the two. This names the second
 * meaning at the moment it has a visible consequence.
 */

export type ProjectScanLineProps = {
  /** Absent when no scan arrived for this project — renders nothing at all. */
  scan?: ProjectScan;
};

/** Total declarations found on disk, across all three kinds. */
export function declaredTotal(scan: ProjectScan): number {
  return scan.mcpServers.length + scan.hooks.declared + scan.envInjections.declared;
}

/** How many of those this project's current scope set does NOT load. */
export function notLoadedTotal(scan: ProjectScan): number {
  const mcp = scan.mcpServers.filter((s) => !s.loads).length;
  return (
    mcp +
    (scan.hooks.declared - scan.hooks.loaded) +
    (scan.envInjections.declared - scan.envInjections.loaded)
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function ProjectScanLine({ scan }: ProjectScanLineProps) {
  if (!scan) return null;

  const declared = declaredTotal(scan);
  const notLoaded = notLoadedTotal(scan);
  const mcpNames = scan.mcpServers.map((s) => s.name).join(', ');

  return (
    <div className="project-scan-line">
      {scan.mcpServers.length > 0 && (
        <span className="project-scan-chip" title={`Declared MCP servers: ${mcpNames}`}>
          {plural(scan.mcpServers.length, 'MCP server', 'MCP servers')}
        </span>
      )}
      {scan.hooks.declared > 0 && (
        <span
          className={`project-scan-chip${scan.hooks.hasLocalScope ? ' is-warn' : ''}`}
          title={
            scan.hooks.hasLocalScope
              ? 'At least one hook comes from settings.local.json — a file that is neither committed nor reviewed.'
              : 'Hooks declared by this project’s settings files.'
          }
        >
          {plural(scan.hooks.declared, 'hook', 'hooks')}
        </span>
      )}
      {scan.envInjections.declared > 0 && (
        <span
          className="project-scan-chip"
          title="Environment variables this project’s settings files inject into a session. Names only — Cebab never reads the values."
        >
          {plural(scan.envInjections.declared, 'env override', 'env overrides')}
        </span>
      )}
      {notLoaded > 0 && (
        <span
          className="project-scan-chip is-warn"
          title={
            'This project is not trusted, so its own settings files are not loaded into a session: ' +
            '.claude/settings.json, .claude/settings.local.json and .mcp.json. ' +
            'They are counted here because they exist on disk. Trust the project to load them.'
          }
        >
          <span className="project-scan-glyph" aria-hidden="true">
            ⚠
          </span>{' '}
          {notLoaded} not loaded
        </span>
      )}
      {declared === 0 && !scan.degraded && (
        <span
          className="project-scan-chip is-muted"
          title="Cebab read this project’s settings files and found no MCP servers, hooks or environment overrides. This is a measured answer, not a missing one."
        >
          declares nothing
        </span>
      )}
      {scan.degraded && (
        <span
          className="project-scan-chip is-err"
          title="At least one settings file exists but could not be read or parsed, so part of this summary is missing. The counts shown are whatever did read."
        >
          <span className="project-scan-glyph" aria-hidden="true">
            ⚠
          </span>{' '}
          settings unreadable
        </span>
      )}
    </div>
  );
}
