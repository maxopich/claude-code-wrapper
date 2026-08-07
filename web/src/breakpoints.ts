/**
 * Every width the app branches on, in one table.
 *
 * There were three sets of these numbers and no relationship between them:
 * this module's `sm/md/lg/xl` ladder, App.tsx's `1120`/`830` shell tiers
 * spelled inline, and eight literals in `styles.css`. The stylesheet header
 * named this file as "the JS counterpart"; this file's comment named that
 * header as the thing to keep in sync with — two documents pointing at each
 * other while the code obeyed neither. Nothing imported this module at all,
 * and of its four declared breakpoints the stylesheet branched on two.
 *
 * `breakpoints.test.ts` now fails the build if `styles.css` branches on a
 * width that is not listed here, or if a width listed here is branched on by
 * nothing. That test is what makes this file a source of truth rather than a
 * second opinion.
 */

/**
 * Shell layout tiers. Measured by a ResizeObserver on `.app`'s own box, not on
 * the viewport, so the ultra-wide page cap below is respected — which is why
 * these never appear in a media query. Read by App.tsx.
 */
export const SHELL = { wide: 1120, medium: 830 } as const;

/**
 * Widths spelled through `mqBelow`, i.e. with the 0.02 px buffer.
 *
 * `narrow` is the app-wide cut — modal surfaces, the template-modal overlay
 * and the notification stack all restack below it. The three `logs*` entries
 * are `.logs-row-summary`'s own progressive collapse, dropping one column per
 * step, and are named for the column each one drops.
 */
export const BUFFERED = {
  narrow: 600,
  logsHideTimestamp: 700,
  logsHideAgent: 800,
  logsHideKind: 900,
} as const;

/**
 * One-off widths spelled exactly, with no buffer.
 *
 * The split from `BUFFERED` is descriptive, not prescriptive: these three
 * predate the buffer convention and none of them has a `min-width` partner
 * that a shared boundary pixel could double-satisfy, so nothing is broken
 * today. Converging them onto the ladder would move layout at widths no test
 * covers, so it is deliberately not done here.
 */
export const EXACT = {
  allowDenyStack: 640,
  templatePanelStack: 720,
  templateModalStack: 768,
} as const;

/** The stylesheet's only `min-width`: the ultra-wide page cap on `.app`. */
export const ULTRAWIDE_CAP = 3840;

/**
 * `(max-width: …)` for a boundary in `BUFFERED`. The 0.02 px buffer keeps the
 * boundary pixel itself from satisfying both `(max-width: 599.98px)` and
 * `(min-width: 600px)`.
 */
export const mqBelow = (px: number): string => `(max-width: ${px - 0.02}px)`;
