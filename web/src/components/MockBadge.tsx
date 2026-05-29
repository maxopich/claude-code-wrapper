/**
 * Cluster G Phase 2a/2b (UI-A3): MOCK runtime badge.
 *
 * Surfaces the always-on `config.mock === true` posture so the operator
 * never confuses a fixture-replay session with a live model call. Per
 * `high/G-run-awareness.md` §5 the four canonical mounts are:
 *
 *   - **Sidebar header** (Phase 2a, `variant="sidebar"` — the default).
 *     Reads `settings.mockMode === true`. Canonical signal for the
 *     current process.
 *   - **ChatHeader** (Phase 2b, `variant="inline"`). Reads
 *     `session.mock === true`. Mirrors the sidebar when the operator is
 *     IN a mock-era session — even when the global runtime is now live.
 *   - **ProjectList session row** (Phase 2b, `variant="history"`). Reads
 *     `SessionSummary.mock === true`. Lower opacity because the row is
 *     a historical pointer, not a live-state announcement.
 *   - **MultiAgent surfaces** (Phase 2c — deferred). Will use
 *     `variant="inline"` against `MultiAgentRun.mock` once threaded.
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
 *     MOCK persists across the lifetime of the process / session;
 *     dismissing it would let the operator drift into thinking the run
 *     is live. The ux-agent's "non-dismissible" requirement is captured
 *     by simply not rendering a close button.
 *
 * **Mount predicate.** The caller is responsible for the gating boolean
 * (`settings.mockMode === true` for sidebar; `session.mock === true` for
 * inline; `SessionSummary.mock === true` for history). The badge is a
 * pure presentational component — strict equality is intentional, so
 * `undefined` (pre-G1 server, settings haven't arrived yet) renders
 * nothing.
 */

export type MockBadgeVariant = 'sidebar' | 'inline' | 'history';

export type MockBadgeProps = {
  /**
   * Which mount visual variant. Default `'sidebar'` (Phase 2a, full
   * geometry). `'inline'` shrinks to ChatHeader chip size; `'history'`
   * shrinks further and dims so the ProjectList row reads as a record,
   * not a live announcement.
   */
  variant?: MockBadgeVariant;
};

export function MockBadge({ variant = 'sidebar' }: MockBadgeProps = {}) {
  // Variant→class map lives here (not via template literal) so unused
  // class strings stay statically discoverable by tooling and the union
  // type is the single source of truth for what variants exist.
  const variantClass =
    variant === 'inline'
      ? 'mock-badge-inline'
      : variant === 'history'
        ? 'mock-badge-history'
        : '';
  const className = variantClass ? `mock-badge ${variantClass}` : 'mock-badge';
  return (
    <span
      className={className}
      role="status"
      aria-label={
        'Cebab is in MOCK mode — no real model calls. Responses come from replay fixtures.'
      }
      title={
        'Mock mode is active for this Cebab process. No live model calls are being ' +
        'made; responses come from replay fixtures. Set MOCK=0 in the environment ' +
        'and restart Cebab to leave mock mode.'
      }
      data-testid={`mock-badge-${variant}`}
    >
      MOCK
    </span>
  );
}
