/**
 * PR-4: Typography mirror for SVG text inside the template-preview
 * diagram.
 *
 * `<text>` elements inside an SVG need numeric `fontSize`, not a CSS
 * variable, so this table is the single source for that geometry.
 *
 * There was a `--tpl-fs-*` mirror of these values in `styles.css` for the
 * HTML around the SVG. No rule ever referenced it, so the "kept in sync"
 * this comment used to promise was a sync between one live table and five
 * dead declarations; the CSS half is gone. Anything that needs these sizes
 * in CSS should declare the token beside its own rule.
 *
 * Values intentionally match the pre-PR-4 magic numbers scattered
 * through `layout.ts` — this is a refactor seam, not a typography
 * change. Compact + full density both pull from this table; the
 * choice of which token to read is the responsibility of the caller.
 *
 * Px on purpose — SVG `<text>` needs numeric `fontSize`, so this table is
 * not rem-ified even though the rest of the CSS type ramp is.
 *
 *  - `name`         standard name size at orch row / chain wrap (12)
 *  - `nameCompact`  slightly larger name at chain row tier (13)
 *  - `role`         role text under names (11; compact only)
 *  - `hub`          "orchestrator" label in the hub chip (13)
 *  - `slug`         "cebab" slug under the hub label (11)
 *  - `under`        under-badge labels in full density (per-tier:
 *                   ring=11, twoRing=10, concentric=9 — exposed as a
 *                   tuple for callers that want a specific tier)
 */
export const TPL_FS = {
  name: 12,
  nameCompact: 13,
  role: 11,
  hub: 13,
  slug: 11,
} as const;

/** Per-tier under-badge label font sizes for full-density ring tiers.
 *  Compact density still hides these labels — names live in <title>
 *  + the panel row only when the badge tier itself can't carry text. */
export const TPL_FS_UNDER_BADGE = {
  ring: 11,
  twoRing: 10,
  concentric: 9,
} as const;
