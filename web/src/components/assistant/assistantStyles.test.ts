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
  return new Set([...css.matchAll(/\.(assistant-[a-z0-9-]+)/g)].map((m) => m[1]!));
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

  test('both notif-stack collision rules exist', () => {
    expect(stylesCss).toContain('.assistant-dock ~ .notif-stack');
    expect(stylesCss).toContain(".assistant-dock[data-open='true'] ~ .notif-stack");
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
