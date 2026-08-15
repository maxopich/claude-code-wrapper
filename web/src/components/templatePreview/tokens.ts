/**
 * PR-4: Typography table for SVG text inside the template-preview diagram.
 *
 * `<text>` elements inside an SVG need a numeric `fontSize`, not a CSS
 * variable, so a JS table is the only place this geometry can live.
 *
 * There was a `--tpl-fs-*` mirror of these values in `styles.css` for the
 * HTML around the SVG. No rule ever referenced it, so the "kept in sync"
 * this comment used to promise was a sync between one live table and five
 * dead declarations; the CSS half is gone. Anything that needs these sizes
 * in CSS should declare the token beside its own rule.
 *
 * Px on purpose — SVG `<text>` needs a number, so this table is not rem-ified
 * even though the rest of the CSS type ramp is.
 *
 * WHAT USED TO BE HERE, AND WHY IT IS NOT (register N06). A second export,
 * `TPL_FS` (`name`/`nameCompact`/`role`/`hub`/`slug`), described itself as the
 * single source for the diagram's name and role sizes. Nothing ever imported
 * it, and it had drifted: it said `role: 11` and `hub: 13` where `layout.ts`
 * lives at `FS_ROLE = 10` and a hub label of 12. The register's suggested fix
 * was "import it in the layout module" — which would have silently restyled
 * the preview, because the table was the stale copy, not the layout. An unread
 * constant that is also wrong is worse than one that is merely unread: the
 * obvious repair to it is a regression. Deleted rather than corrected, because
 * `layout.ts` computes those sizes per density tier and there is no single
 * value for a table to hold.
 */

/**
 * Per-tier under-badge label font sizes for full-density ring tiers.
 * Compact density hides these labels — names live in `<title>` plus the panel
 * row when the badge tier itself can't carry text.
 *
 * Imported by `layout.ts`'s three ring layouts, which is what makes this a
 * source of truth rather than a fourth opinion. These values were verified
 * identical to the local constants they replaced, so wiring them in changed
 * no rendered output.
 */
export const TPL_FS_UNDER_BADGE = {
  ring: 11,
  twoRing: 10,
  concentric: 9,
} as const;
