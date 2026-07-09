/**
 * Cluster F Phase D5 (UI-D5): compact status chip surfacing the
 * always-on consultant-mode guardrail in an orchestrator-mode bus
 * session. Sits in `MultiAgentActivityBar` alongside the hop-budget,
 * mutations, router-drops, and participant-controls chips.
 *
 * The chip is **non-interactive** — it's a status reminder, not an
 * affordance. The detail/explanation lives in the paired
 * `<ConsultantModeBanner />` at the top of the surface; this chip is
 * the at-a-glance "yes, the guardrail is still in effect" signal that
 * stays visible while the operator scrolls the scrollback.
 *
 * **Caller-gated to orchestrator mode.** The chip does not check the
 * run's mode; the caller (MultiAgentActivityBar) wraps the mount in a
 * `run.mode === 'orchestrator'` conditional. Chain-mode runtime has no
 * consultant-mode prompt (`server/src/bus/runtime.ts`'s
 * `renderChainBriefing` lacks the constraint that `renderRosterPrompt`
 * and `renderWorkerBriefing` carry), so rendering the chip for
 * chain-mode runs would misrepresent the agent's actual posture.
 *
 * Geometry mirrors `ma-hop-budget-chip` / `ma-mutations-chip` so the
 * activity-bar lines up visually with the existing chip family.
 */
export function ConsultantModeChip({ executeMode = false }: { executeMode?: boolean } = {}) {
  if (executeMode) {
    return (
      <span
        className="ma-consultant-chip"
        aria-label="Execute mode: agents may change their own project"
        title={
          'Execute mode is active for this orchestrator session. Each worker may ' +
          'create, modify, or delete files within its own project folder to do the ' +
          'work — but must not touch files in any other directory. The constraint is ' +
          'advisory (the model interprets the prompt) and out-of-folder writes are ' +
          'flagged post-hoc; there is no server-side enforcement. See the banner at ' +
          'the top of the session for full detail.'
        }
      >
        <span aria-hidden="true">ⓘ</span>
        Execute
      </span>
    );
  }
  return (
    <span
      className="ma-consultant-chip"
      // No-color-only: the chip carries an explicit textual marker (the
      // word "Consultant" + a non-decorative ⓘ glyph), not just a hue,
      // so screen readers and reduced-motion users still perceive it.
      aria-label="Consultant mode: agents are read-only by default"
      title={
        'Consultant mode is active for this orchestrator session. Every agent ' +
        'reads, analyzes, and advises by default — workers must not modify, ' +
        'create, or delete files outside their own project folder unless your ' +
        'prompt explicitly directs that specific change. The constraint is ' +
        'advisory (the model interprets the prompt); there is no server-side ' +
        'enforcement. See the banner at the top of the session for full detail.'
      }
    >
      <span aria-hidden="true">ⓘ</span>
      Consultant
    </span>
  );
}
