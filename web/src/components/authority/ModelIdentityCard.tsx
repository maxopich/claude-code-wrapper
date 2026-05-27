import type { ProjectAuthority } from '@cebab/shared/protocol';

// Cluster B Phase 6b (UI-B44 / agentic-reviewer §11.4): "who am I and what's
// my auth posture" card at the top of the AuthorityPanel.
//
// The four fields are the operator's at-a-glance answer to "what model is
// this, and does my Anthropic token leak through?":
//   - model            — exact SDK-reported model id (sonnet-4-5, opus-4, etc.)
//   - apiKeySource     — 'none' (subscription via OAuth) vs anything else
//                        (= a token is in play, which Cebab specifically
//                        scrubs in subscriptionOnlyEnv but can leak through
//                        a trusted-project `env:` injection — see Phase 5
//                        env gate). Highlighted amber when NOT 'none'.
//   - permissionMode   — 'default' / 'acceptEdits' / 'bypassPermissions' /
//                        'plan' — the runtime auth posture the SDK loaded
//                        with. Bypass is the danger signal (auto-approves
//                        Bash + everything); we tint it red.
//   - cwd              — the project root the runner ran in. Useful for
//                        the operator to confirm Cebab pointed the SDK at
//                        the right tree (e.g. when a chain participant
//                        lives in a worker tree distinct from its origin).
//
// Spec also names `extended-thinking-state when on wire` — the SDK doesn't
// expose it in `session_started` today; Phase 8/v1.1 will piggyback if
// the field surfaces. Until then we omit the row rather than render
// 'unknown' noise.
//
// BE-B12 [security] friend: NEVER renders env values. apiKeySource is the
// only auth-adjacent field, and it's already a public posture name — not a
// secret. A screenshot of this card leaks nothing useful to an attacker.

const PERM_MODE_LABEL: Record<string, string> = {
  default: 'default',
  acceptEdits: 'auto-allow edits',
  bypassPermissions: 'bypass — auto-allow ALL',
  plan: 'plan',
};

function permPostureClass(mode?: string): string {
  if (mode === 'bypassPermissions') return 'model-identity-perm-danger';
  if (mode === 'acceptEdits') return 'model-identity-perm-warn';
  return 'model-identity-perm-default';
}

function apiKeySourcePostureClass(src?: string): string {
  if (!src || src === 'none') return 'model-identity-key-ok';
  return 'model-identity-key-warn';
}

function apiKeySourceLabel(src?: string): string {
  if (!src || src === 'none') return 'OAuth subscription (no key on wire)';
  return src;
}

export function ModelIdentityCard(props: { authority: ProjectAuthority }) {
  const { authority } = props;
  const model = authority.model ?? '(unknown — init not received yet)';
  const apiKeySource = authority.apiKeySource;
  const permissionMode = authority.permissionMode;
  const cwd = authority.cwd;
  const sources = authority.settingSourcesUsed;

  return (
    <dl className="model-identity-card">
      <div className="model-identity-row">
        <dt>Model</dt>
        <dd>
          <code className="model-identity-model">{model}</code>
        </dd>
      </div>
      <div className="model-identity-row">
        <dt>API key source</dt>
        <dd className={apiKeySourcePostureClass(apiKeySource)}>
          {apiKeySourceLabel(apiKeySource)}
        </dd>
      </div>
      <div className="model-identity-row">
        <dt>Permission mode</dt>
        <dd className={permPostureClass(permissionMode)}>
          <code>{permissionMode ?? '(unset)'}</code>
          {permissionMode && PERM_MODE_LABEL[permissionMode] && (
            <span className="model-identity-perm-hint"> — {PERM_MODE_LABEL[permissionMode]}</span>
          )}
        </dd>
      </div>
      <div className="model-identity-row">
        <dt>Working directory</dt>
        <dd>
          {cwd ? (
            <code className="model-identity-cwd">{cwd}</code>
          ) : (
            <span className="model-identity-muted">(not reported)</span>
          )}
        </dd>
      </div>
      <div className="model-identity-row">
        <dt>Setting sources loaded</dt>
        <dd>
          {sources.length === 0 ? (
            <span className="model-identity-muted">(none)</span>
          ) : (
            sources.map((s, i) => (
              <span key={s} className="model-identity-source-chip">
                {s}
                {i < sources.length - 1 && ' '}
              </span>
            ))
          )}
        </dd>
      </div>
    </dl>
  );
}
