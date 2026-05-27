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
};

const SCOPE_LABEL: Record<HookView['scope'], string> = {
  user: 'user',
  project: 'project',
  local: 'local',
};

export function HooksList(props: { hooks: HookView[] }) {
  const { hooks } = props;
  if (hooks.length === 0) {
    return (
      <div className="hooks-empty">
        No hooks declared in this project&apos;s settings.json layers.
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
    </div>
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
