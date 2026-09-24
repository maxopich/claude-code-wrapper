import { describe, expect, test } from 'vitest';
// Vite's ?raw suffix returns the file contents as a string at build time
// (declared in vite-env.d.ts). No Node fs dependency — runs in jsdom, the way
// styleTokens.test.ts reads the stylesheet + component sources.
import stylesCss from '../../styles.css?raw';
import appTsx from '../../App.tsx?raw';
import { parseThemeBlocks, tokenBlockRanges } from '../../cssColor.js';

/**
 * Cebab-i6fl (slice 3 of the Cebab-dyb help-assistant design): the widget is
 * styled as a floating support-widget dock, clear of the Send button and the
 * notification toasts. Its classes had no rules in styles.css (that gap is
 * Cebab-e29 — the first assertion below is RED on main today). This file locks
 * in the look and the two collision invariants so a later edit can't silently
 * drop them.
 *
 * All obligations are about NAMES and STRUCTURE, never values — colour/contrast
 * for the shared tokens is already gated by styleContrast.test.ts.
 */

// The assistant component sources (excluding this and other test files), the
// way styleTokens.test.ts globs the tsx tree.
const ASSISTANT_TSX = Object.entries(
  import.meta.glob('./*.tsx', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>,
).filter(([file]) => !file.endsWith('.test.tsx'));

const ASSISTANT_SRC = ASSISTANT_TSX.map(([, src]) => src).join('\n');

/** Every `assistant-*` token used inside a `className="…"` attribute across the
 *  assistant components. Deliberately scoped to className attributes so string
 *  constants like `'assistant-pending'` (a session id) are not mistaken for
 *  classes. */
function classNamesUsed(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/className="([^"]*)"/g)) {
    for (const cls of m[1]!.split(/\s+/)) {
      if (cls.startsWith('assistant-')) out.add(cls);
    }
  }
  return out;
}

/** Every `.assistant-*` class that appears as (part of) a selector in the
 *  stylesheet. The full token is captured, so `.assistant-dock` and
 *  `.assistant-dock-trigger` are distinct entries — a rule for the longer name
 *  does not vacuously satisfy the shorter one. */
function ruledClasses(css: string): Set<string> {
  // Comments stripped first: a class named only in a comment has no rule.
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return new Set([...noComments.matchAll(/\.(assistant-[a-z0-9-]+)/g)].map((m) => m[1]!));
}

const NEW_TOKENS = [
  '--assistant-dock-z',
  '--assistant-fab-size',
  '--assistant-panel-w',
  '--assistant-panel-max-h',
] as const;

function firstRootBody(css: string): string {
  const range = tokenBlockRanges(css).find((r) => r.name === ':root');
  if (!range) throw new Error('no :root block found');
  return css.slice(range.start, range.end);
}

/** Flat top-level rules as `{ selector, body }`, comments stripped. The
 *  stylesheet's rules are flat by requirement (see the styles.css banner and
 *  templatePreview/cssGate.test.ts), so this minimal-brace walk — the same one
 *  cssGate uses — correctly skips `@media` wrappers and picks up their inner
 *  rules. */
function flatRules(css: string): Array<{ selector: string; body: string }> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Array<{ selector: string; body: string }> = [];
  for (const m of noComments.matchAll(/([^{}][^{}]*?)\{([^{}]*?)\}/g)) {
    out.push({ selector: m[1]!.trim(), body: m[2]! });
  }
  return out;
}

/** Rules in SOURCE ORDER, each tagged with the `@media` prelude it sits in
 *  (null at top level). Comments are blanked, not removed, so offsets keep
 *  source order. The stylesheet is flat apart from at-rule wrappers, so one
 *  level of container is enough. A comment that NAMES a selector is not a rule
 *  — the text search this replaces was satisfied by comments (PR #696 review). */
function rulesInOrder(
  css: string,
): Array<{ selector: string; body: string; media: string | null; at: number }> {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));
  const CONTAINER = /^@(media|supports|layer|keyframes|container)\b/;
  const out: Array<{ selector: string; body: string; media: string | null; at: number }> = [];
  let media: string | null = null;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      const prelude = src.slice(start, i).trim();
      if (CONTAINER.test(prelude)) {
        media = prelude;
        start = i + 1;
        continue;
      }
      const close = src.indexOf('}', i);
      out.push({ selector: prelude, body: src.slice(i + 1, close), media, at: i });
      i = close;
      start = close + 1;
    } else if (ch === '}') {
      media = null;
      start = i + 1;
    }
  }
  return out;
}

const PHONE = /max-width:\s*599\.98px/;
const OPEN_NOTIF = ".assistant-dock[data-open='true'] ~ .notif-stack";
const OPEN_POPOVER = ".assistant-dock[data-open='true'] .assistant-dock-popover";

describe('assistant widget styles (Cebab-i6fl / Cebab-e29)', () => {
  test('the scan actually read the sources', () => {
    // Anti-vacuity: a broken glob or path would make every assertion pass over
    // nothing.
    expect(ASSISTANT_SRC.length).toBeGreaterThan(2_000);
    expect(stylesCss.length).toBeGreaterThan(10_000);
    expect(appTsx.length).toBeGreaterThan(10_000);
  });

  test('every assistant-* className used in a component has at least one rule', () => {
    const used = classNamesUsed(ASSISTANT_SRC);
    const ruled = ruledClasses(stylesCss);
    // Anti-vacuity: the components really do use assistant-* classes.
    expect(used.size).toBeGreaterThanOrEqual(10);
    const unruled = [...used].filter((c) => !ruled.has(c)).sort();
    expect(unruled).toEqual([]);
  });

  test('the four geometry tokens are declared in the first :root block', () => {
    const root = firstRootBody(stylesCss);
    for (const t of NEW_TOKENS) {
      expect(root, `${t} must be declared in the first :root block`).toContain(`${t}:`);
    }
  });

  test('none of the four geometry tokens leaks into a [data-theme] gamma', () => {
    const gammas = parseThemeBlocks(stylesCss);
    // Anti-vacuity: the gamma parse actually resolved blocks.
    expect(Object.keys(gammas).length).toBeGreaterThanOrEqual(2);
    for (const [name, tokens] of Object.entries(gammas)) {
      for (const t of NEW_TOKENS) {
        expect(tokens.has(t), `${t} must not appear in [data-theme='${name}']`).toBe(false);
      }
    }
  });

  test('--assistant-dock-z is below --notif-stack-z, so toasts stack over the trigger', () => {
    const root = firstRootBody(stylesCss);
    const dockZ = /--assistant-dock-z:\s*(\d+)/.exec(root);
    const notifZ = /--notif-stack-z:\s*(\d+)/.exec(root);
    expect(dockZ, '--assistant-dock-z declared').not.toBeNull();
    expect(notifZ, '--notif-stack-z declared').not.toBeNull();
    expect(Number(dockZ![1])).toBeLessThan(Number(notifZ![1]));
  });

  test('no assistant-* rule carries a hex colour literal (colours come from tokens)', () => {
    const HEX = /#[0-9a-fA-F]{3,8}\b/;
    const offenders = flatRules(stylesCss)
      .filter((r) => r.selector.includes('assistant-') && HEX.test(r.body))
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
    // Anti-vacuity: the walk saw the assistant rules at all.
    expect(flatRules(stylesCss).some((r) => r.selector.includes('assistant-'))).toBe(true);
  });

  test('the rule walk sees top-level and @media rules (anti-vacuity)', () => {
    const rules = rulesInOrder(stylesCss);
    expect(rules.length).toBeGreaterThan(500);
    expect(rules.some((r) => r.media === null)).toBe(true);
    expect(rules.some((r) => r.media !== null && PHONE.test(r.media))).toBe(true);
  });

  test('both desktop collision rules are real top-level rules that set what they claim', () => {
    const top = rulesInOrder(stylesCss).filter((r) => r.media === null);
    const lift = top.find((r) => r.selector === '.assistant-dock ~ .notif-stack');
    expect(lift, 'a top-level .assistant-dock ~ .notif-stack rule').toBeDefined();
    expect(lift!.body).toMatch(/(^|[\s;])bottom\s*:/);
    const beside = top.find((r) => r.selector === OPEN_NOTIF);
    expect(beside, `a top-level ${OPEN_NOTIF} rule`).toBeDefined();
    expect(beside!.body).toMatch(/(^|[\s;])right\s*:/);
  });

  test('on a phone the open panel clears the composer and the toasts move to the top, AFTER the desktop rule', () => {
    // Same specificity as the desktop rule, so source order decides: placed
    // before it, the desktop rule won and the toasts were 0px wide on phones.
    const rules = rulesInOrder(stylesCss);
    const desktop = rules.find((r) => r.media === null && r.selector === OPEN_NOTIF)!;
    const phoneNotif = rules.filter(
      (r) => r.media !== null && PHONE.test(r.media) && r.selector === OPEN_NOTIF,
    );
    expect(phoneNotif.length, `a phone ${OPEN_NOTIF} rule`).toBeGreaterThan(0);
    for (const r of phoneNotif) {
      expect(r.at, 'the phone rule must come after the desktop rule').toBeGreaterThan(desktop.at);
      expect(r.body).toMatch(/(^|[\s;])top\s*:/);
    }
    const phonePopover = rules.find(
      (r) => r.media !== null && PHONE.test(r.media) && r.selector === OPEN_POPOVER,
    );
    expect(phonePopover, `a phone ${OPEN_POPOVER} rule`).toBeDefined();
    // position: fixed measures from the screen; without this the sheet covers Send.
    expect(phonePopover!.body).toMatch(/(^|[\s;])bottom\s*:[^;]*--composer-clearance/);
  });

  test('the help button keeps its accent colour under the pointer', () => {
    const hover = rulesInOrder(stylesCss).find(
      (r) => r.media === null && r.selector === '.assistant-dock-trigger:hover',
    );
    expect(hover, 'a .assistant-dock-trigger:hover rule').toBeDefined();
    expect(hover!.body).toMatch(/background\s*:\s*var\(--accent\)/);
  });

  test('the .assistant-dock rule clears whatever composer is on screen', () => {
    const dock = flatRules(stylesCss).find((r) => r.selector === '.assistant-dock');
    expect(dock, 'a bare .assistant-dock rule exists').toBeDefined();
    expect(dock!.body).toContain('var(--composer-clearance');
  });

  test('App.tsx renders <AssistantDock/> before <NotificationStack/> (DOM order is load-bearing)', () => {
    const dockAt = appTsx.indexOf('<AssistantDock');
    const notifAt = appTsx.indexOf('<NotificationStack');
    expect(dockAt).toBeGreaterThanOrEqual(0);
    expect(notifAt).toBeGreaterThanOrEqual(0);
    expect(dockAt).toBeLessThan(notifAt);
  });

  test('no assistant component publishes its own composer clearance', () => {
    // Only one useComposerClearance caller may be mounted at a time; the help
    // composer must read --composer-clearance, never publish it.
    expect(ASSISTANT_SRC).not.toContain('useComposerClearance');
  });
});
