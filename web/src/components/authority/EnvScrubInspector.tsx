import type { EnvInjection } from '@cebab/shared/protocol';

// Cluster B Phase 6c (UI-B14 / B20 / B21 + spec §4.5 E1): env-injection
// inspector inside the AuthorityPanel.
//
// Renders the resolver's `detectedEnvInjections` — credential-class env
// keys that any `.claude/settings*.json` layer's `env:` block would inject
// into the SDK spawn for THIS project. Each row carries:
//   - envKey   — the variable NAME (BE-B12 [security]: never the value)
//   - posture  — human-readable hint ("subscription auth bypass", etc.)
//   - scope    — user / project / local
//   - scopePath — which file declared it
//   - isSet    — whether process.env actually carries a value right now
//                (boolean, NOT the value)
//
// UI-B14 / B20 explicitly: env VALUES are never rendered, and there is no
// Reveal affordance. This is enforced by the wire shape — `EnvInjection`
// carries no value field — and by the [security] test that asserts the
// rendered DOM contains no `sk-…` / `Bearer …` patterns even with
// adversarial input.
//
// UI-B21: when injections are detected, an inline warn banner sits inside
// the inspector body (NOT in the page-level BannerStack — the banner is
// scoped to this view because it's only actionable from inside the
// AuthorityPanel).
//
// When `detectedInjections` is empty the inspector shows an explicit
// "no credential-class injections detected" message rather than collapsing
// to blank — operators need to confirm the scan ran and found nothing.

const SCOPE_CHIP_CLASS: Record<EnvInjection['scope'], string> = {
  user: 'env-injection-scope-user',
  project: 'env-injection-scope-project',
  local: 'env-injection-scope-local',
};

export function EnvScrubInspector(props: { injections: EnvInjection[] }) {
  const { injections } = props;

  if (injections.length === 0) {
    return (
      <div className="env-scrub-empty">
        <p>
          No credential-class environment variables declared in this project&apos;s
          <code> .claude/settings*.json</code> <code>env:</code> blocks.
        </p>
        <p className="env-scrub-help">
          Cebab&apos;s subscription-only scrub strips <code>ANTHROPIC_API_KEY</code>,
          <code> ANTHROPIC_AUTH_TOKEN</code>, and provider-routing variables
          (Bedrock/Vertex/Foundry) from the SDK spawn so a stray shell export can&apos;t reroute
          through paid billing. A project&apos;s settings.json can still re-inject these — when it
          does, they appear here.
        </p>
      </div>
    );
  }

  // Group rows by scope so a heavily-injecting project's project layer is
  // visually distinct from a single user-tier leak.
  const byScope = new Map<EnvInjection['scope'], EnvInjection[]>();
  for (const inj of injections) {
    const arr = byScope.get(inj.scope) ?? [];
    arr.push(inj);
    byScope.set(inj.scope, arr);
  }
  for (const arr of byScope.values()) {
    arr.sort((a, b) => a.envKey.localeCompare(b.envKey));
  }
  const scopeOrder: EnvInjection['scope'][] = ['project', 'local', 'user'];

  return (
    <div className="env-scrub-inspector">
      {/* UI-B21: inline warn banner. Scoped to this view — NOT a page-level
       *  BannerStack push. */}
      <div className="env-scrub-banner" role="alert">
        <strong>{injections.length}</strong> credential-class env var
        {injections.length === 1 ? '' : 's'} would be injected into this session from{' '}
        <code>.claude/settings*.json</code>. Subscription-only scrub does NOT apply when
        settings.json re-declares these.
      </div>
      {scopeOrder.map((scope) => {
        const rows = byScope.get(scope);
        if (!rows || rows.length === 0) return null;
        return (
          <section key={scope} className={`env-scrub-scope env-scrub-scope-${scope}`}>
            <header className="env-scrub-scope-header">
              <span className={`env-injection-scope-chip ${SCOPE_CHIP_CLASS[scope]}`}>{scope}</span>
              <span className="env-scrub-scope-path">
                <code>{rows[0]!.scopePath}</code>
              </span>
              <span className="env-scrub-scope-count">
                {rows.length} key{rows.length === 1 ? '' : 's'}
              </span>
            </header>
            <ul
              className="env-injection-list"
              aria-label={`Detected credential-class env keys (${scope})`}
            >
              {rows.map((inj) => (
                <li key={`${inj.scope}:${inj.envKey}`} className="env-injection-row">
                  <code className="env-injection-key">{inj.envKey}</code>
                  <span className="env-injection-posture">{inj.posture}</span>
                  <span
                    className={`env-injection-set ${
                      inj.isSet ? 'env-injection-set-yes' : 'env-injection-set-no'
                    }`}
                    aria-label={inj.isSet ? 'env value currently set' : 'env value currently unset'}
                    title={
                      inj.isSet
                        ? 'process.env has a value for this key right now'
                        : 'process.env does not have a value for this key — settings.json declared it but the operator has not exported one'
                    }
                  >
                    {inj.isSet ? 'set' : 'unset'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
