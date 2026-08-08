import { describe, expect, test } from 'vitest';
import stylesCss from './styles.css?raw';
import appSource from './App.tsx?raw';
import { stripComments } from './sourceScan.js';
import { BUFFERED, EXACT, mqBelow, SHELL, ULTRAWIDE_CAP } from './breakpoints.js';

/**
 * Makes `breakpoints.ts` binding rather than advisory.
 *
 * Three sets of these numbers used to coexist (register U24): this module's
 * `sm/md/lg/xl` ladder, App.tsx's `1120`/`830` spelled inline, and eight
 * literals in `styles.css`. Nothing imported the module, the stylesheet header
 * pointed at it as "the JS counterpart", and the module's comment pointed back
 * at the header — two documents each naming the other as the source of truth
 * while the code branched at widths neither of them listed.
 *
 * A comment cannot fail a build, so these tests do it instead: the stylesheet
 * may not branch on a width the table omits, and the table may not list a
 * width nothing branches on. Both directions, because either alone leaves the
 * documentation free to drift in the other.
 *
 * CSS is scanned as text on purpose. `@media` cannot read a custom property,
 * so there is no way to *derive* the queries from the table — the only
 * enforcement available is to read both and compare.
 */

/** Every width the stylesheet branches on, as `min|max` → px. */
function mediaWidths(css: string): { kind: 'min' | 'max'; px: number }[] {
  return [...css.matchAll(/@media[^{]*?\((min|max)-width:\s*([0-9.]+)px\)/g)].map((m) => ({
    kind: m[1] as 'min' | 'max',
    px: Number(m[2]),
  }));
}

const CSS = stripComments(stylesCss);
const WIDTHS = mediaWidths(CSS);

/** What the table says the stylesheet is allowed to spell. */
const DOCUMENTED = new Set<string>([
  ...Object.values(BUFFERED).map((px) => `max:${mqBelow(px).match(/([0-9.]+)px/)![1]}`),
  ...Object.values(EXACT).map((px) => `max:${px}`),
  `min:${ULTRAWIDE_CAP}`,
]);

describe('breakpoints — the table and the stylesheet agree', () => {
  test('the scan actually found the media queries', () => {
    // Anti-vacuity: a regex that matched nothing would make both directions
    // below pass. A floor, not an exact count, so adding a query is not a
    // two-file edit unless the width itself is new.
    expect(WIDTHS.length).toBeGreaterThanOrEqual(11);
  });

  test('the stylesheet branches on no width the table omits', () => {
    const undocumented = WIDTHS.filter((w) => !DOCUMENTED.has(`${w.kind}:${w.px}`)).map(
      (w) => `${w.kind}-width: ${w.px}px`,
    );
    expect([...new Set(undocumented)]).toEqual([]);
  });

  test('the table lists no width the stylesheet ignores', () => {
    const used = new Set(WIDTHS.map((w) => `${w.kind}:${w.px}`));
    const unused = [...DOCUMENTED].filter((d) => !used.has(d));
    expect(unused).toEqual([]);
  });

  test('mqBelow spells the buffered widths the way the stylesheet does', () => {
    // The 0.02 buffer is the whole reason `mqBelow` exists; if it drifted, the
    // two directions above would still agree with each other and both be wrong.
    expect(mqBelow(BUFFERED.narrow)).toBe('(max-width: 599.98px)');
    expect(CSS).toContain(`@media ${mqBelow(BUFFERED.narrow)}`);
    expect(CSS).toContain(`@media ${mqBelow(BUFFERED.logsHideKind)}`);
  });
});

describe('breakpoints — the shell tiers are read, not respelled', () => {
  const app = stripComments(appSource);

  test('App.tsx classifies through SHELL', () => {
    expect(app).toContain("from './breakpoints'");
    expect(app).toContain('SHELL.wide');
    expect(app).toContain('SHELL.medium');
  });

  test('App.tsx does not spell the tier widths as literals', () => {
    // The defect this replaces: the numbers lived here and nowhere else, so
    // the documented table could say anything.
    expect(app).not.toContain(String(SHELL.wide));
    expect(app).not.toContain(String(SHELL.medium));
  });

  test('the shell tiers stay out of the stylesheet', () => {
    // They are measured on `.app`'s own box by a ResizeObserver, so a media
    // query on the viewport would be a different — and wrong — measurement.
    const shellInCss = WIDTHS.filter((w) => w.px === SHELL.wide || w.px === SHELL.medium);
    expect(shellInCss).toEqual([]);
  });
});
