/**
 * Cluster E Phase 2 (B4) — ModelChip.
 *
 * Displays the SDK-reported model identifier for a session so the
 * operator can tell which model produced a response. Cluster B's audit
 * surfaces (AuthorityPanel + ModelIdentityCard) already exposed this in
 * the deep-inspect view; the chip moves the data to the always-visible
 * chat header so the operator doesn't have to open a panel to know
 * "what's the model right now?"
 *
 * Geometry: reuses `.ma-hop-budget-chip` token vocabulary (`--bg-5`
 * background, `--line-2` border, `--fg-2` text, --r-md radius) per
 * ui-agent §6. No new tokens.
 *
 * **Fallback copy**: when `model` is undefined (no `session_started` has
 * landed yet, or an old payload omits the field), we render
 * `model: default` rather than blank — per B4-3 acceptance: "Renders
 * model: default when unknown; never blank." This keeps the chip
 * present in every session header (no layout shift when the SDK init
 * arrives) and gives the operator a visible signal that the value
 * hasn't been resolved yet.
 *
 * **Hover tooltip**: the full model identifier (e.g.
 * `claude-sonnet-4-5-20250929`) renders in the `title` attribute. The
 * spec calls for additional provider + version + max_tokens metadata
 * (§5 B4); those are wired in a follow-up once the protocol surfaces
 * them next to `session_started.model`. Today's wire only carries the
 * bare model id string.
 *
 * **Multi-agent**: not mounted, and that is the correct state — but it
 * took a detour. This slice (#159) recorded what a `TopRunBar` chip needs:
 * "a separate slice (E2.x) will extend the **protocol** + reducer + mount",
 * because nothing on the wire forwards a bus participant's model. E2.x
 * (#160) then shipped the reducer and the mount and skipped the protocol,
 * wiring the chip to `session_started` — which `translate()` produces only
 * for single-agent turns, so the bus never emits one. The chip therefore
 * read `model: default` on every multi-agent run for its whole life, under
 * a tooltip telling the operator to wait for a message that could not
 * arrive. Register W13 unmounted it and removed the aggregation.
 *
 * The original sentence stands: a bus chip needs a model signal on the
 * wire FIRST. Filed separately; the seam is `bus/runner.ts`'s per-agent
 * `onMessage`, which already sees the SDK `init` that carries the model.
 *
 * **Anomaly surface (B4-5)**: warn icon + tooltip when the resolved
 * model differs from the operator-selected model. Today Cebab does NOT
 * track a per-session "selected" record (OQ-E5) — this is a v1.x
 * addition; the chip surface is forward-compatible (accepts an
 * optional `selectedModel` prop and renders a warn affordance when
 * present and divergent).
 */

export type ModelChipProps = {
  /** The SDK-reported model id from `session_started.model`. */
  model?: string;
  /**
   * Optional: the model the operator picked at session-start (OQ-E5
   * not yet wired; v1.x). When present and differs from `model`, the
   * chip renders a warn icon + tooltip.
   */
  selectedModel?: string;
  /**
   * Optional extra context for the hover tooltip (provider, version date).
   *
   * Register W13 note for whoever runs the next dead-code sweep: this prop's
   * only production caller was the `TopRunBar` chip's "participants reported
   * different models" tooltip, removed with that mount. It is exercised by
   * tests and kept for the documented purpose above — caller-less is not the
   * same as unused, and `selectedModel` below is caller-less by design too.
   */
  tooltipExtra?: string;
};

/**
 * Render a short label from the SDK's full model id. Trims the
 * `claude-` prefix and the trailing dated suffix:
 *   `claude-sonnet-4-5-20250929` → `sonnet 4-5`
 *   `claude-opus-4-1`            → `opus 4-1`
 *   `claude-haiku-4-5-20251001`  → `haiku 4-5`
 * Anything else (already-short alias, unknown shape) passes through
 * verbatim so the operator sees what the SDK actually reports.
 *
 * There used to be an explicit `if (model === 'various') return 'various'`
 * here, guarding the multi-agent summary sentinel against the `claude-*`
 * trimming. Register W13 removed it with the summary that produced it — and
 * it was a no-op regardless: `'various'` has no `claude-` prefix, no dated
 * suffix and no dash, so every branch below already returns it unchanged.
 * The test pins that passthrough, so the guarantee survives the guard.
 */
export function shortModelLabel(model: string | undefined): string {
  if (!model || model.length === 0) return 'default';
  // Drop `claude-` prefix if present.
  const stripped = model.startsWith('claude-') ? model.slice('claude-'.length) : model;
  // Drop trailing `-YYYYMMDD` (8 digits).
  const withoutDate = stripped.replace(/-\d{8}$/, '');
  // Convert remaining dashes inside the family portion to spaces for
  // readability: `sonnet-4-5` → `sonnet 4-5`. We only split the first
  // dash so the family stays one word and the version portion keeps
  // its dashes (sonnet 4-5 reads as "sonnet four-five").
  const firstDash = withoutDate.indexOf('-');
  if (firstDash === -1) return withoutDate;
  return `${withoutDate.slice(0, firstDash)} ${withoutDate.slice(firstDash + 1)}`;
}

/**
 * `Cebab-ut7` — summarize a multi-agent run's per-participant models into a
 * single label for the `TopRunBar` ModelChip. Keyed by bus agent name (the
 * map `MultiAgentRun.modelsByAgent` holds); the keys are irrelevant to the
 * summary — only the set of values matters.
 *
 * Returns:
 *   - the common model string if every entry matches (and at least one is present)
 *   - the literal `'various'` if multiple distinct values are present
 *   - `undefined` if the map is empty or holds only empty strings (no
 *     `system/init` has been harvested yet — the chip then shows "default")
 *
 * Register W13 removed the predecessor of this function along with the dead
 * `session_started`-fed map it summarized; its cases were correct about
 * everything except whether the input arrived. It arrives now on
 * `agent_activity.model`, so the function and its contract come back
 * unchanged — the source is what changed.
 */
export function summarizeBusModel(
  modelsByAgent: Record<string, string> | undefined,
): string | undefined {
  if (!modelsByAgent) return undefined;
  const values = Object.values(modelsByAgent).filter((v) => v.length > 0);
  if (values.length === 0) return undefined;
  const distinct = new Set(values);
  if (distinct.size === 1) return values[0];
  return 'various';
}

export function ModelChip({ model, selectedModel, tooltipExtra }: ModelChipProps) {
  const label = shortModelLabel(model);
  const hasAnomaly = !!selectedModel && !!model && selectedModel !== model;
  const tooltipParts: string[] = [];
  if (model) {
    tooltipParts.push(`Model: ${model}`);
  } else {
    tooltipParts.push('Model: not yet reported (waiting on session_started)');
  }
  if (hasAnomaly) {
    tooltipParts.push(`Selected: ${selectedModel} — running: ${model}`);
  }
  if (tooltipExtra) tooltipParts.push(tooltipExtra);

  return (
    <span
      className={`model-chip${hasAnomaly ? ' is-warn' : ''}`}
      title={tooltipParts.join('\n')}
      aria-label={
        hasAnomaly
          ? `Model: ${model}, but operator selected ${selectedModel}`
          : `Model: ${model ?? 'default'}`
      }
    >
      {hasAnomaly && (
        <span className="model-chip-warn-icon" aria-hidden="true">
          ⚠
        </span>
      )}
      <span className="model-chip-prefix">model:</span>{' '}
      <span className="model-chip-name">{label}</span>
    </span>
  );
}
