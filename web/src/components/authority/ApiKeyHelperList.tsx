import type { ApiKeyHelperView } from '@cebab/shared/protocol';

// Cebab-6fax.23 [security]: one row per `apiKeyHelper` command the resolver
// found in a LOADED `.claude/settings*.json` layer.
//
// Why this sits beside the hook and env-injection rows: an `apiKeyHelper`
// makes the CLI resolve an API key by RUNNING a command, and that key
// overrides the OAuth subscription on every run — the same exposure as a
// credential-class `env:` injection, but through a settings key. The catch the
// operator most needs to see is that a helper at USER scope
// (`~/.claude/settings.json`) loads regardless of the project Trust toggle, so
// unlike the project's own hooks it is not gated and there is no TOFU brake.
//
// SURFACE-ONLY by decision. Cebab cannot strip a setting the way
// `subscriptionOnlyEnv()` strips an env var — it is a file the operator owns
// and Cebab writes nothing into operator config. So this names the helper; it
// does not disable it. The `command` shown is configuration (verbatim, like a
// HookView's command), never the resolved key — Cebab never runs it.

const SCOPE_CHIP_CLASS: Record<ApiKeyHelperView['scope'], string> = {
  user: 'hook-scope-user',
  project: 'hook-scope-project',
  local: 'hook-scope-local',
};

export function ApiKeyHelperList(props: { helpers: ApiKeyHelperView[] }) {
  const { helpers } = props;

  if (helpers.length === 0) {
    return (
      <div className="apikey-helper-empty">
        No <code>apiKeyHelper</code> declared in this project&apos;s loaded settings.json layers.
        When one is present the CLI resolves an API key by running it, which overrides the OAuth
        subscription — it would appear here.
      </div>
    );
  }

  return (
    <div className="apikey-helper-list">
      <div className="apikey-helper-banner" role="alert">
        <strong>{helpers.length}</strong> <code>apiKeyHelper</code>
        {helpers.length === 1 ? '' : 's'} declared. Runs on this project may authenticate as the key
        the helper prints rather than your Claude subscription. A user-scope helper loads even when
        Trust is off; Cebab surfaces it but cannot strip it from your settings.
      </div>
      <ul className="apikey-helper-rows" aria-label="Declared apiKeyHelper commands">
        {helpers.map((h, i) => (
          <li
            key={`${h.scope}:${h.scopePath}:${h.command}:${i}`}
            className={`apikey-helper-row apikey-helper-row-${h.scope}`}
          >
            <header className="apikey-helper-row-header">
              <span className={`hook-scope-chip ${SCOPE_CHIP_CLASS[h.scope]}`}>{h.scope}</span>
              <span className="apikey-helper-path">
                <code>{h.scopePath}</code>
              </span>
            </header>
            <dl className="apikey-helper-facts">
              <div className="apikey-helper-fact">
                <dt>Command</dt>
                <dd>
                  <code className="apikey-helper-command">{h.command}</code>
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
