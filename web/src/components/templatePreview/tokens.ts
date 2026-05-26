/**
 * PR-4: Typography mirror for SVG text inside the template-preview
 * diagram.
 *
 * `<text>` elements inside an SVG need numeric `fontSize`, not a CSS
 * variable. The corresponding `:root` `--tpl-fs-*` tokens in
 * `styles.css` are kept in sync with the values here so HTML
 * counterparts (panel rows, modal subtitle, etc.) read from the same
 * scale.
 *
 * Values intentionally match the pre-PR-4 magic numbers scattered
 * through `layout.ts` — this is a refactor seam, not a typography
 * change. Compact + full density both pull from this table; the
 * choice of which token to read is the responsibility of the caller.
 *
 * Px on purpose — mirrored 1:1 by the `--tpl-fs-*` CSS variables in
 * `styles.css`. SVG `<text>` needs numeric `fontSize`, so neither
 * side is rem-ified even though the rest of the CSS type ramp is.
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
