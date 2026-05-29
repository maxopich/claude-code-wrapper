/**
 * Cluster G Phase 2a (UI-A3): MOCK runtime badge.
 *
 * Surfaces the always-on `config.mock === true` posture so the operator
 * never confuses a fixture-replay session with a live model call. Per
 * `high/G-run-awareness.md` §5 the canonical mount lives in the sidebar
 * header (immediately right of the brand mark + word); per-session
 * mirror chips in `TopRunBar` / `MultiAgentActivityBar` / session list
 * rows are deferred to Phase 2b, when the per-session `mock` flag is
 * threaded through to the wire views.
 *
 * **Visual contract (per ux-agent + agentic-reviewer validation).**
 *   - **Red diagonal-stripe pattern** (`repeating-linear-gradient` of
 *     `--err` + `--err-soft`) — agentic-reviewer flagged that using
 *     `--coral` for MOCK would collide with the agent-0 hue in the
 *     palette; the failure mode is the *dangerous* direction (operator
 *     misreads "this is agent 0" as "this is mock"). A pattern is a
 *     dimension neither hue nor letterform can fake.
 *   - **Always carries the literal text "MOCK"** so screen readers,
 *     reduced-motion users, and colorblind operators all perceive the
 *     state without depending on the pattern.
 *   - **`aria-label` + `title` are explicit** — the badge is
 *     non-interactive (no click target) but is a status surface; SR
 *     users should hear the full posture, not just "MOCK".
 *   - **No dismiss affordance.** The whole point of the badge is that
 *     MOCK persists across the lifetime of the process; dismissing it
 *     would let the operator drift into thinking the run is live. The
 *     ux-agent's "non-dismissible" requirement is captured by simply
 *     not rendering a close button.
 *
 * **Mount predicate.** The caller is responsible for gating on
 * `settings.mockMode === true`. The badge does NOT read the store; it's
 * a pure presentational component. Strict equality is intentional —
 * `undefined` (pre-G1 server, settings haven't arrived yet) renders
 * nothing.
 */
export function MockBadge() {
  return (
    <span
      className="mock-badge"
      role="status"
      aria-label={
        'Cebab is in MOCK mode — no real model calls. Responses come from replay fixtures.'
      }
      title={
        'Mock mode is active for this Cebab process. No live model calls are being ' +
        'made; responses come from replay fixtures. Set MOCK=0 in the environment ' +
        'and restart Cebab to leave mock mode.'
      }
      data-testid="mock-badge-sidebar"
    >
      MOCK
    </span>
  );
}
