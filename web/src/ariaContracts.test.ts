import { describe, expect, test } from 'vitest';
import { stripComments } from './sourceScan.js';

/**
 * Contracts between what a control *says* it is and what it *does*.
 *
 * Every rule here is one register finding generalised. They share a shape:
 * markup that announces something to assistive technology which the code then
 * does not deliver — a role with no keys, a state attribute that describes a
 * different kind of control, a heading that is really a button. None of these
 * break for a sighted mouse user, which is why all four survived to a 20th
 * release under a green build.
 *
 * The scans are textual and deliberately simple. `stripComments` runs first on
 * every one of them: a comment explaining why a construct was removed would
 * otherwise register as the construct itself (the bug that kept
 * `widgetRoles.test.ts` red while it was being written), and a comment
 * mentioning the thing a rule accepts as proof would launder a violation.
 */

const SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob('./**/*.tsx', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).filter(([file]) => !file.endsWith('.test.tsx')),
);

/**
 * The text inside every `<tag …>…</tag>` pair in `src`, for a tag that is
 * written literally (not a component). Nesting of the *same* tag is counted,
 * so an inner `</nav>` cannot close an outer one early.
 *
 * Crude on purpose: it does not parse JSX. It only has to be right about
 * whether one literal element sits inside another, which is what all three
 * containment rules below ask.
 */
function spansOf(src: string, tag: string): string[] {
  // One literal per tag name rather than a built pattern: `security/
  // detect-non-literal-regexp` forbids `new RegExp(<variable>)`, and the tags
  // this file asks about are a fixed, short list.
  const open = OPENERS[tag];
  if (!open) throw new Error(`no opener pattern for <${tag}>`);
  const close = `</${tag}>`;
  const out: string[] = [];
  for (let m = open.exec(src); m !== null; m = open.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (depth > 0) {
      const nextClose = src.indexOf(close, i);
      if (nextClose === -1) break; // self-closing or unbalanced; take what we have
      const inner = src.slice(i, nextClose).search(open);
      open.lastIndex = 0;
      if (inner !== -1) {
        depth++;
        i = i + inner + tag.length + 1;
      } else {
        depth--;
        i = nextClose + close.length;
      }
    }
    out.push(src.slice(m.index, i));
    open.lastIndex = i;
  }
  open.lastIndex = 0;
  return out;
}

/** Literal openers, keyed by tag — see the note in `spansOf`. */
const OPENERS: Record<string, RegExp> = {
  nav: /<nav(?=[\s/>])/g,
  button: /<button(?=[\s/>])/g,
};

/** The attributes of a single JSX element, from `<tag` to its closing `>`. */
function elementsWithAttr(src: string, attr: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(attr, from);
    if (at === -1) return out;
    // Walk back to the `<` that opens this element, and forward to the `>`
    // that closes the opening tag, ignoring `>` inside braces or quotes.
    const start = src.lastIndexOf('<', at);
    let i = at;
    let brace = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '{') brace++;
      else if (ch === '}') brace--;
      else if (ch === '>' && brace === 0) break;
      i++;
    }
    out.push(src.slice(start === -1 ? 0 : start, i + 1));
    from = at + attr.length;
  }
}

describe('[a11y] a current destination is not a pressed toggle (U36)', () => {
  const navSpans = Object.entries(SOURCES).flatMap(([file, src]) =>
    spansOf(stripComments(src), 'nav').map((span) => ({ file, span })),
  );

  test('the scan found real nav landmarks', () => {
    // Anti-vacuity: with no spans the rule below passes over nothing, which is
    // exactly the failure mode this whole file exists to catch one level down.
    expect(navSpans.length).toBeGreaterThan(0);
    expect(navSpans.some(({ span }) => span.includes('aria-label="Main view"'))).toBe(true);
  });

  test('the span scanner really closes at the matching tag', () => {
    // If `spansOf` ran to end-of-file, every rule using it would scan the whole
    // source and report unrelated code — the gate would then be un-passable
    // rather than wrong, but for the right reason only by accident. Proven on
    // fixtures, not on the app.
    const spans = spansOf('<nav a><b/></nav><button aria-pressed={x} />', 'nav');
    expect(spans).toHaveLength(1);
    expect(spans[0]).not.toContain('aria-pressed');

    // A nested same-tag element must not close the outer span early, or an
    // offender after the inner close would be invisible to the rule.
    const nested = spansOf('<nav x><nav y></nav><i aria-pressed/></nav>', 'nav');
    expect(nested).toHaveLength(1);
    expect(nested[0]).toContain('aria-pressed');

    // Two siblings are two spans, not one run-on.
    expect(spansOf('<nav a></nav><i aria-pressed/><nav b></nav>', 'nav')).toHaveLength(2);
    expect(spansOf('<nav a></nav><i aria-pressed/><nav b></nav>', 'nav').join('')).not.toContain(
      'aria-pressed',
    );
  });

  test('no aria-pressed inside a nav landmark', () => {
    // `aria-pressed` says "this toggle is currently down". A control that marks
    // which destination you are on is `aria-current` — the distinction
    // `ProjectList` already draws on a single button (pressed for select mode,
    // current for the active session).
    const offenders = navSpans
      .filter(({ span }) => span.includes('aria-pressed'))
      .map(({ file }) => file);
    expect([...new Set(offenders)]).toEqual([]);
  });
});

describe('[a11y] a heading is not a control (U37)', () => {
  // Literals, not a built pattern — `security/detect-non-literal-regexp`
  // forbids `new RegExp(<variable>)`, and there are exactly six headings.
  const HEADINGS: Array<[string, RegExp]> = [
    ['h1', /<h1[\s/>]/],
    ['h2', /<h2[\s/>]/],
    ['h3', /<h3[\s/>]/],
    ['h4', /<h4[\s/>]/],
    ['h5', /<h5[\s/>]/],
    ['h6', /<h6[\s/>]/],
  ];

  test('the scan found real buttons', () => {
    const total = Object.values(SOURCES).reduce(
      (n, src) => n + spansOf(stripComments(src), 'button').length,
      0,
    );
    expect(total).toBeGreaterThan(50);
  });

  test('no heading element inside a button', () => {
    // Heading navigation is how a screen-reader user skims a page. A heading
    // that is really a control sends them into the middle of a widget, and the
    // button's accessible name swallows whatever else the heading contains.
    // The APG accordion nests these the other way round: heading wraps button.
    const offenders: string[] = [];
    for (const [file, src] of Object.entries(SOURCES)) {
      for (const span of spansOf(stripComments(src), 'button')) {
        for (const [name, pattern] of HEADINGS) {
          if (pattern.test(span)) offenders.push(`${file}: <${name}>`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // The scanner must be capable of seeing one, or the empty list above means
    // nothing. Proven on a fixture rather than on the app.
    const bad = spansOf('<button x><h3>Title</h3></button>', 'button');
    expect(HEADINGS.some(([, p]) => p.test(bad[0] ?? ''))).toBe(true);
  });
});

describe('[a11y] a separator that can be dragged can be keyed (U38)', () => {
  const separators = Object.entries(SOURCES).flatMap(([file, src]) =>
    elementsWithAttr(stripComments(src), 'role="separator"').map((el) => ({ file, el })),
  );

  test('the scan found the separator', () => {
    expect(separators.length).toBeGreaterThan(0);
    expect(separators.some(({ file }) => file.includes('GrowTextarea'))).toBe(true);
  });

  test('a pointer-draggable separator is focusable and handles keys', () => {
    // The failure this replaces: `role="separator"` + `aria-label` announced a
    // control to a screen reader, and the only way to operate it was a mouse
    // drag. Announcing a control you cannot reach is worse than not announcing
    // it — the operator goes looking for something that is not there.
    const broken = separators
      .filter(({ el }) => el.includes('onPointerDown'))
      .filter(({ el }) => !el.includes('tabIndex') || !el.includes('onKeyDown'))
      .map(({ file }) => file);
    expect(broken).toEqual([]);
  });

  test('a focusable separator reports its value', () => {
    // `aria-valuenow` is required on a focusable separator; without it the
    // splitter announces no position and arrow keys give no feedback.
    const silent = separators
      .filter(({ el }) => el.includes('tabIndex'))
      .filter(({ el }) => !el.includes('aria-valuenow'))
      .map(({ file }) => file);
    expect(silent).toEqual([]);
  });
});

/**
 * Composite roles, copied from `widgetRoles.test.ts` rather than re-derived —
 * the two files have to agree about what "composite" means or one of them is
 * enforcing a different rule than it claims.
 */
const COMPOSITE_ROLES = [
  'menu',
  'menubar',
  'listbox',
  'grid',
  'treegrid',
  'tree',
  'radiogroup',
  'tablist',
  'combobox',
  'toolbar',
  // Also legal hosts for aria-activedescendant, though not arrow-key widgets
  // in their own right.
  'textbox',
  'searchbox',
  'application',
];

/**
 * Elements whose *implicit* role already supports `aria-activedescendant`, so
 * an explicit `role=` would be redundant — and adding one to satisfy a scanner
 * is the ARIA anti-pattern of re-declaring what the element already is.
 *
 * `SlashCommandPalette` is exactly this case: the filter `<input type="text">`
 * is implicitly a textbox and points at its listbox's rows. The first version
 * of this gate reported it, which was the gate being wrong rather than the
 * markup.
 */
function hasImplicitTextboxRole(el: string): boolean {
  if (/^<textarea[\s/>]/.test(el)) return true;
  if (!/^<input[\s/>]/.test(el)) return false;
  const type = /type="([a-z]+)"/.exec(el)?.[1];
  return type === undefined || type === 'text' || type === 'search';
}

describe('[a11y] aria-activedescendant needs a role that supports it (.41)', () => {
  const holders = Object.entries(SOURCES).flatMap(([file, src]) =>
    elementsWithAttr(stripComments(src), 'aria-activedescendant').map((el) => ({ file, el })),
  );

  test('the scan found real usages', () => {
    expect(holders.length).toBeGreaterThan(0);
  });

  test('every aria-activedescendant sits on a role that supports it', () => {
    // `role="list"` has no active-descendant model, so the ids resolve and the
    // browser exposes nothing: the arrow-key highlight moved and assistive tech
    // stayed silent. Same class of failure as U18, one container role over.
    const orphans = holders
      .filter(
        ({ el }) =>
          !COMPOSITE_ROLES.some((r) => el.includes(`role="${r}"`)) && !hasImplicitTextboxRole(el),
      )
      .map(({ file, el }) => `${file}: ${/role="([a-z]+)"/.exec(el)?.[1] ?? 'no role'}`);
    expect(orphans).toEqual([]);
  });

  test('the implicit-role escape hatch is narrow', () => {
    // It must not be a blanket "any element without a role is fine" — that
    // would have accepted the `role="list"` container this rule exists for.
    expect(hasImplicitTextboxRole('<input type="text" aria-activedescendant={x}')).toBe(true);
    expect(hasImplicitTextboxRole('<div role="list" aria-activedescendant={x}')).toBe(false);
    expect(hasImplicitTextboxRole('<div aria-activedescendant={x}')).toBe(false);
    expect(hasImplicitTextboxRole('<input type="checkbox" aria-activedescendant={x}')).toBe(false);
  });
});

/**
 * Components allowed to read an arrow key directly. Each entry is checked
 * against the source below, so a stale exemption fails instead of quietly
 * widening the hole.
 */
const ARROW_EXEMPT: Array<{ file: string; why: string; proof: string }> = [
  {
    file: './components/GrowTextarea.tsx',
    why: 'its arrows resize a splitter — a continuous value, not movement through a list, so `nextIndex` has nothing to offer it',
    proof: 'role="separator"',
  },
];

describe('[a11y] arrow-key movement goes through one helper (.40)', () => {
  const handRolled = Object.entries(SOURCES)
    .filter(([, src]) => /['"]Arrow(Up|Down|Left|Right)['"]/.test(stripComments(src)))
    .map(([file]) => file);

  test('the scan found arrow handling somewhere', () => {
    expect(handRolled.length).toBeGreaterThan(0);
  });

  test('no component compares an arrow key outside the helper', () => {
    // Five surfaces in this app declare a composite role, and each hand-rolled
    // its own ladder — one wrapped, one clamped, one added Home/End. The rule
    // now lives in `listNavigation.ts` with one test file, and the difference
    // between the policies is an argument rather than a rediscovery.
    const offenders = handRolled.filter((f) => !ARROW_EXEMPT.some((e) => e.file === f));
    expect(offenders).toEqual([]);
  });

  test('each exemption still exists and is still what it claims', () => {
    for (const { file, proof } of ARROW_EXEMPT) {
      const src = SOURCES[file];
      expect(src, `exemption names a file that does not exist: ${file}`).toBeDefined();
      expect(stripComments(src!)).toContain(proof);
      // And it must still actually read an arrow key — an exemption for a
      // component that stopped doing so is a licence nobody is using.
      expect(/['"]Arrow(Up|Down|Left|Right)['"]/.test(stripComments(src!))).toBe(true);
    }
  });
});
