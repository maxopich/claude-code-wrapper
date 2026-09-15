import type { HookView } from '@cebab/shared/protocol';

// Cluster B Phase 6c (UI-B40 + spec agentic-reviewer §11.1): one card per
// declared hook from any `.claude/settings*.json` layer.
//
// Why this matters even though Cebab itself doesn't auto-install hooks:
//   - The SDK auto-runs hooks declared in the merged settings.json on
//     every matching event. For trusted projects, that includes
//     `.claude/settings.local.json` — checked into the repo by a
//     teammate or carelessly autocompleted by an editor.
//   - A `PreToolUse` hook can mutate or refuse a tool call (silently
//     bypassing Cebab's approval UI on untrusted runs; running with the
//     trusted run's auto-allow).
//   - A `Stop` hook can spawn arbitrary subprocesses post-session that
//     outlive the SDK and never appear in Cebab's session log.
//
// UI-B40: warn icon on `scope === 'local'` rows. Project-local is the
// least-vetted tier — a hook landing there got checked into the repo
// without anybody approving it through Cebab.
//
// `binarySha` (when resolvable) is shown so the operator can spot a
// hook binary changing between sessions (same TOFU concept as MCP servers,
// just without the spawn gate — out of scope for v1).

const SCOPE_CHIP_CLASS: Record<HookView['scope'], string> = {
  user: 'hook-scope-user',
  project: 'hook-scope-project',
  local: 'hook-scope-local',
  plugin: 'hook-scope-plugin',
};

const SCOPE_LABEL: Record<HookView['scope'], string> = {
  user: 'user',
  project: 'project',
  local: 'local',
  plugin: 'plugin',
};

export function HooksList(props: {
  hooks: HookView[];
  unloaded?: HookView[];
  /** Cebab-aklg: account-wide, from an enabled plugin's manifest. Kept a
   *  separate prop rather than mixed into `hooks` because the two answer
   *  different questions — see `ProjectAuthority.pluginHooks`. */
  plugin?: HookView[];
}) {
  const { hooks } = props;
  const unloaded = props.unloaded ?? [];
  const plugin = props.plugin ?? [];
  if (hooks.length === 0) {
    // Cebab-66y: an empty LOADED list is not an empty project. On an untrusted
    // project the project's own `.claude/settings.json` hooks sit in a scope
    // Trust keeps out — declared, real, and inert until Trust is turned on. The
    // panel used to assert "none declared" here, which is precisely the
    // strong-negative the operator reads before trusting the project and making
    // those very hooks auto-execute. Render them as inert instead.
    if (unloaded.length > 0 || plugin.length > 0) {
      return (
        <>
          {unloaded.length > 0 && <UnloadedHooks unloaded={unloaded} />}
          {plugin.length > 0 && <PluginHooks plugin={plugin} />}
        </>
      );
    }
    return (
      <div className="hooks-empty">
        No hooks declared in this project&apos;s settings.json layers, and no enabled plugin
        declares one.
      </div>
    );
  }
  // Group by hookKind so a project with many hooks on the same event
  // doesn't visually shatter. Within a kind, project-local sorts FIRST so
  // the highest-trust-burden rows surface at the top.
  const byKind = new Map<string, HookView[]>();
  for (const h of hooks) {
    const arr = byKind.get(h.hookKind) ?? [];
    arr.push(h);
    byKind.set(h.hookKind, arr);
  }
  const kindsSorted = Array.from(byKind.keys()).sort();
  for (const k of kindsSorted) {
    byKind.get(k)!.sort((a, b) => {
      const aRank = a.scope === 'local' ? 0 : a.scope === 'project' ? 1 : 2;
      const bRank = b.scope === 'local' ? 0 : b.scope === 'project' ? 1 : 2;
      if (aRank !== bRank) return aRank - bRank;
      return a.command.localeCompare(b.command);
    });
  }
  return (
    <div className="hooks-list">
      {kindsSorted.map((kind) => (
        <section key={kind} className="hooks-kind-group">
          <header className="hooks-kind-header">
            <code className="hooks-kind-name">{kind}</code>
            <span className="hooks-kind-count">{byKind.get(kind)!.length}</span>
          </header>
          <ul className="hooks-kind-list">
            {byKind.get(kind)!.map((h, i) => (
              <HookCard key={`${kind}:${h.scope}:${h.scopePath}:${h.command}:${i}`} hook={h} />
            ))}
          </ul>
        </section>
      ))}
      {unloaded.length > 0 && <UnloadedHooks unloaded={unloaded} />}
      {plugin.length > 0 && <PluginHooks plugin={plugin} />}
    </div>
  );
}

/**
 * Cebab-66y: hooks a project declares in a scope its next run will NOT load —
 * an untrusted project's own `.claude/settings.json` / `.mcp.json`. They are
 * real and would auto-execute the moment Trust is turned on, so the panel names
 * them explicitly rather than letting the section read "none declared".
 */
function UnloadedHooks(props: { unloaded: HookView[] }) {
  const { unloaded } = props;
  return (
    <section className="hooks-unloaded">
      <div className="hooks-unloaded-note">
        {unloaded.length} {unloaded.length === 1 ? 'hook is' : 'hooks are'} declared in this
        project&apos;s own settings but will <strong>not load</strong> while Trust is off. Turning
        Trust on in the sidebar makes {unloaded.length === 1 ? 'it' : 'them'} auto-execute.
      </div>
      <ul className="hooks-unloaded-list">
        {unloaded.map((h, i) => (
          <HookCard
            key={`unloaded:${h.hookKind}:${h.scope}:${h.scopePath}:${h.command}:${i}`}
            hook={h}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * Cebab-aklg: hooks an enabled PLUGIN brings.
 *
 * Separated from the project's own hooks in the render for the same reason they
 * are a separate field on the wire: an operator reading this section is asking
 * "what will this project run, and what can I do about it", and these answer it
 * differently. Trust decides whether the rows above load. It decides nothing
 * here — `enabledPlugins` is read from the user tier alone, which Cebab's scope
 * set includes whether or not the project is trusted — so the only lever is
 * disabling the plugin itself.
 */
function PluginHooks(props: { plugin: HookView[] }) {
  const { plugin } = props;
  return (
    <section className="hooks-plugin">
      <div className="hooks-plugin-note">
        {plugin.length} {plugin.length === 1 ? 'hook comes' : 'hooks come'} from an enabled plugin
        and {plugin.length === 1 ? 'runs' : 'run'} on every turn of <strong>every</strong> project.
        Trust does not gate {plugin.length === 1 ? 'it' : 'them'}; disabling the plugin is the only
        lever.
      </div>
      <ul className="hooks-plugin-list">
        {plugin.map((h, i) => (
          <HookCard key={`plugin:${h.pluginId ?? ''}:${h.hookKind}:${h.command}:${i}`} hook={h} />
        ))}
      </ul>
    </section>
  );
}

function HookCard(props: { hook: HookView }) {
  const { hook } = props;
  const isLocal = hook.scope === 'local';
  return (
    <li className={`hook-card hook-card-${hook.scope} ${isLocal ? 'hook-card-warn' : ''}`}>
      <header className="hook-card-header">
        {isLocal && (
          <span
            className="hook-card-warn-icon"
            aria-label="project-local scope (warn)"
            title="Declared in .claude/settings.local.json — lowest-trust tier"
          >
            ⚠
          </span>
        )}
        <span className={`hook-scope-chip ${SCOPE_CHIP_CLASS[hook.scope]}`}>
          {SCOPE_LABEL[hook.scope]}
        </span>
        <span className="hook-card-path">
          <code>{hook.scopePath}</code>
        </span>
      </header>
      <dl className="hook-card-facts">
        <div className="hook-card-fact">
          <dt>Command</dt>
          <dd>
            <code>{hook.command}</code>
            {hook.args && hook.args.length > 0 && (
              <code className="hook-card-args"> {hook.args.join(' ')}</code>
            )}
          </dd>
        </div>
        {hook.binarySha && (
          <div className="hook-card-fact">
            <dt>Binary sha256</dt>
            <dd>
              <code className="hook-card-sha">{hook.binarySha}</code>
            </dd>
          </div>
        )}
      </dl>
    </li>
  );
}
