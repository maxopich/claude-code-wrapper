import type { ProjectAuthority } from '@cebab/shared/protocol';

// Cluster B Phase 6b (UI-B44 / agentic-reviewer §11.4): "who am I and what's
// my auth posture" card at the top of the AuthorityPanel.
//
// The four fields are the operator's at-a-glance answer to "what model is
// this, and does my Anthropic token leak through?":
//   - model            — exact SDK-reported model id (sonnet-4-5, opus-4, etc.)
//   - apiKeySource     — a NAMED source means an API key is in use; 'none'
//                        means no API KEY is, which is consistent with the
//                        subscription, with a bearer token, and with a
//                        third-party backend alike (Cebab-ujth — this line
//                        used to read "'none' (subscription via OAuth)", and
//                        the card said so out loud). Cebab scrubs the
//                        credential names in subscriptionOnlyEnv but cannot
//                        reach a settings-file `env:` injection — see Phase 5
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

/**
 * Cebab-ujth: `'none'` IS NOT EVIDENCE OF A SUBSCRIPTION.
 *
 * This row used to render `'none'` as `OAuth subscription (no key on wire)`,
 * tinted ok. That reads as an affirmative answer to the one question the row
 * exists for — am I running on my subscription, or is a credential on the wire
 * — and it is an answer the field cannot give. The SDK's own type doc says so:
 *
 *   'none' (no API key in use - e.g. claude.ai OAuth login, a bearer token, or
 *   a third-party cloud provider)
 *
 * So a bearer token (`ANTHROPIC_AUTH_TOKEN`), a setup token
 * (`CLAUDE_CODE_OAUTH_TOKEN`) and every third-party backend (Bedrock / Vertex /
 * Foundry, selected by a `CLAUDE_CODE_USE_*` switch) all report `'none'` as
 * well — because none of them is an API KEY. The row asserted "subscription"
 * in precisely the cases where it was not one.
 *
 * That is reachable by an edit to a file the operator is likely to be editing:
 * a `~/.claude/settings.json` `env` block applies to every project regardless
 * of Trust, and Cebab cannot scrub a file (`Cebab-rgkt`).
 *
 * The row now reports what was measured and stops there. Distinguishing the
 * three cases needs the resolved auth channel, which `system/init` does not
 * carry; inferring it from the absence of a key is what produced the wrong
 * answer.
 */
function apiKeySourcePostureClass(src?: string): string {
  if (!src) return 'model-identity-muted';
  // A named key source means a credential IS in use, whatever it is.
  if (src === 'none') return 'model-identity-key-neutral';
  return 'model-identity-key-warn';
}

function apiKeySourceLabel(src?: string): string {
  if (!src) return '(unknown — init not received yet)';
  if (src === 'none')
    return 'no API key reported (subscription, bearer token or third-party backend — not distinguished)';
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
