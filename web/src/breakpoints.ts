/**
 * Viewport-width breakpoints. Keep in sync with the breakpoint header
 * at the top of `web/src/styles.css`.
 *
 * `mqBelow(k)` returns a `(max-width: ...)` string with a 0.02 px
 * buffer so the same boundary pixel can never satisfy both
 * `(max-width: 599.98px)` and `(min-width: 600px)`.
 */
export const BP = { sm: 600, md: 900, lg: 1200, xl: 1440 } as const;
export type BpKey = keyof typeof BP;
export const mqBelow = (k: BpKey): string => `(max-width: ${BP[k] - 0.02}px)`;
