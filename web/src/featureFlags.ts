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
