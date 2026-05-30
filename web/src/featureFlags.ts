/**
 * Single source of truth for in-development UI gates.
 *
 * Vite's `import.meta.env.DEV` is `true` under `npm run dev` (and under
 * Vitest, which runs the same dev pipeline) and `false` in production
 * builds. Gating a feature behind this flag means it ships in dev only:
 * it stays out of the release bundle the moment the constant is folded
 * to `false` at build time (Vite tree-shakes the dead branch).
 *
 * **Why this lives in its own file.** Picking a single place means future
 * dev-only gates land here too — instead of being spread across feature
 * modules where they'd be easy to ship by mistake. The pattern: each
 * gate is a named `const` typed `: boolean` (not a ternary or computed
 * expression) so call-sites read as plain feature names.
 *
 * Today's only gate: `ENABLE_CUSTOM_MODE_PICKER`. The four-agent
 * consultation surfaced that the multi-agent mode picker shouldn't yet
 * expose `'custom'` to operators — the topology isn't visualized
 * faithfully (PR-1 banner + PR-2 inline notice make that explicit), and
 * the renderer falls back to orchestrator. When the custom-mode work
 * matures, the picker can opt in by reading this flag; until then no
 * caller exists, and that is deliberate.
 */
export const ENABLE_CUSTOM_MODE_PICKER: boolean = import.meta.env.DEV;

/**
 * Cluster I Phase H3 UI (UI_Findings spec §6 / H3-5): gates the "Diff against
 * previous edit" affordance in the ArtifactsView content disclosure. OFF for
 * v1 — Cebab captures NO pre-mutation snapshot (spec §2 / OQ-I5), so a real
 * diff is impossible today. With it off the affordance renders DISABLED with an
 * explanatory tooltip; the v2 entry point is to set `VITE_ARTIFACT_DIFF_V2=1`
 * (or hardcode `true` here) once pre-image capture lands.
 *
 * Derived from an env read rather than a bare `false` ON PURPOSE: a literal
 * `const X = false` makes every `!X` / `X ? … : …` a provably-constant branch,
 * which CodeQL flags as `js/trivial-conditional` ("always evaluates to false").
 * Reading `import.meta.env` makes the value non-constant to that analysis (the
 * same reason `ENABLE_CUSTOM_MODE_PICKER` above reads `import.meta.env.DEV`),
 * while still resolving to `false` everywhere the var is unset — which is
 * everywhere in v1, including Vitest (`import.meta.env.VITE_ARTIFACT_DIFF_V2`
 * is `undefined` → `=== '1'` is `false`).
 */
export const FEATURE_ARTIFACT_DIFF_V2: boolean = import.meta.env.VITE_ARTIFACT_DIFF_V2 === '1';
