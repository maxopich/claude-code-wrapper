import { describe, expect, test } from 'vitest';
// Vite's ?raw suffix returns the file contents as a string at build time
// (declared in vite-env.d.ts). No Node fs dependency — runs in jsdom.
import stylesCss from './styles.css?raw';
import { parseThemeBlocks, resolveColor, tokenBlockRanges } from './cssColor.js';

/**
 * Design-migration guard (redesign → prod, Phase 0).
 *
 * Two obligations this file locks in:
 *
 *  1. NO baked AI-purple. The redesign — and prod's own token doc
 *     (styles.css `:root` comment: "move away from AI purple") — bans
 *     violet/purple as an interactive/decorative hue. ~17 sites had a
 *     hard-coded `rgba(139, 92, 246, …)` that (a) violated that rule and
 *     (b) would NOT re-theme once the four `[data-theme]` gammas land,
 *     because a literal ignores the token cascade. Phase 0 rewrote each
 *     to `color-mix(in srgb, var(--accent) N%, transparent)` so the
 *     selection/active/focus highlights follow the per-theme accent.
 *     This test fails the build if a purple literal ever comes back.
 *
 *  2. Theme parity (added in Phase 1 below) — every `[data-theme]` gamma
 *     must fill the identical token-name contract, so no theme silently
 *     drops a token and falls back to an inherited (wrong-gamma) value.
 *     The parity assertion is inert until ≥2 theme blocks exist; it goes
 *     live the moment Phase 1 adds them, in the same file.
 *
 * Both obligations are about token NAMES; neither has ever looked at a
 * value, which is how `--fg-3` came to fail WCAG AA in all four gammas
 * under a green build (register U04). Value-level checks — contrast, ramp
 * ordering — live in `styleContrast.test.ts` and share this file's block
 * parser so the two cannot disagree about what the stylesheet declares.
 */

/** Strip `/* … *\/` comments so documentation prose that *names* a
 *  banned color (e.g. the "move away from AI purple" note) can't trip the
 *  literal scanners below. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Purple/violet in the forms it actually appeared (or could reappear):
// the exact rgba triple, plus the common Tailwind-ish violet hexes.
const PURPLE_RGB = /rgba?\(\s*139\s*,\s*92\s*,\s*246/i;
const PURPLE_HEX = /#(?:8b5cf6|a78bfa|7c3aed|6d28d9|c4b5fd|ddd6fe)\b/i;

describe('style tokens — no baked AI-purple', () => {
  const body = stripComments(stylesCss);

  test('no rgba(139, 92, 246, …) literal survives', () => {
    expect(body).not.toMatch(PURPLE_RGB);
  });

  test('no violet hex literal (#8b5cf6 & friends)', () => {
    expect(body).not.toMatch(PURPLE_HEX);
  });

  test('the de-purpled highlights now resolve through var(--accent)', () => {
    // Positive lock: the rewrite routed the old purple highlights through
    // the accent token via color-mix. If someone re-hardcodes a color
    // here, this disappears and the test fails — catching a silent
    // regression that the negative scanners above might miss.
    expect(body).toMatch(/color-mix\(in srgb, var\(--accent\)\s+\d/);
  });
});

/**
 * ── Theme parity (Phase 1 target) ─────────────────────────────────────
 * Parses every `[data-theme='…']` block and asserts they declare the
 * same set of custom-property names. Inert (vacuously true) until the
 * gammas land, so Phase 0 stays green; becomes a hard gate in Phase 1.
 */
const EXPECTED_THEMES = ['aurora', 'daylight', 'slate', 'phosphor'] as const;

/** Token NAMES per gamma. The block scan itself lives in `cssColor.ts`, which
 *  needs the same walk to read token *values* for `styleContrast.test.ts` —
 *  two copies of a parser is two things that can disagree about what the
 *  stylesheet says, and the parity claim and the contrast claim have to be
 *  talking about the same blocks. */
function themeTokenNames(css: string): Record<string, Set<string>> {
  return Object.fromEntries(
    Object.entries(parseThemeBlocks(css)).map(([name, tokens]) => [name, new Set(tokens.keys())]),
  );
}

describe('style tokens — theme parity', () => {
  const blocks = themeTokenNames(stripComments(stylesCss));
  const names = Object.keys(blocks);

  test('every declared gamma fills the identical token contract', () => {
    if (names.length < 2) return; // inert until Phase 1 adds the gammas
    const reference = blocks[names[0]!]!;
    for (const name of names.slice(1)) {
      const set = blocks[name]!;
      const missing = [...reference].filter((t) => !set.has(t));
      const extra = [...set].filter((t) => !reference.has(t));
      expect({ theme: name, missing, extra }).toEqual({ theme: name, missing: [], extra: [] });
    }
  });

  test('all four gammas are present once any theme block exists', () => {
    if (names.length === 0) return; // inert until Phase 1
    for (const t of EXPECTED_THEMES) expect(names).toContain(t);
  });
});

/**
 * ── Token integrity ───────────────────────────────────────────────────
 *
 * Parity above asks whether the four gammas declare the *same* names. It
 * never asks whether a declared name is read, or whether a read name is
 * declared — so the stylesheet accumulated both halves of that gap and stayed
 * green through 18 releases (register U21/U22/U23):
 *
 *  - 48 `var()` references to four tokens no block declared. 20 of them had
 *    no fallback, so the browser dropped the declaration entirely: sixteen
 *    `color: var(--ink-dim)` rules meant to de-emphasise text rendered at
 *    full inherited ink instead.
 *  - 28 declarations (7 tokens × 4 gammas) that no rule read — including a
 *    background colour for the app header, hand-tuned four times.
 *  - 10 ordinary rules pasting one gamma's literal `rgba()` where the token
 *    existed, so those borders showed slate's hues in the other three.
 *
 * All three are the same defect: a declaration that looks like it takes part
 * in the theme system and does not. These tests close that gap in both
 * directions and at the value level.
 */

/**
 * Tokens legitimately absent from the stylesheet because React sets them as
 * inline styles on the element. Every entry is *proved* against the component
 * sources below — an unchecked allowlist is just a quieter place for the next
 * phantom token to live.
 */
const RUNTIME_SET = [
  '--agent-hue',
  '--identity-hue',
  '--badge-hue',
  '--tpl-trip-hue',
  '--tpl-trip-dur',
  '--tpl-modal-origin-x',
  '--tpl-modal-origin-y',
] as const;

const TSX_SOURCES = Object.entries(
  import.meta.glob('./**/*.tsx', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>,
)
  .filter(([file]) => !file.endsWith('.test.tsx'))
  .map(([, src]) => src)
  .join('\n');

/** Custom properties declared anywhere in the sheet. */
function declaredTokens(css: string): Set<string> {
  return new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]!));
}

/** Custom properties read via `var(…)`, mapped to whether any read is bare. */
function referencedTokens(css: string): Map<string, { total: number; bare: number }> {
  const out = new Map<string, { total: number; bare: number }>();
  for (const m of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*([,)])/g)) {
    const e = out.get(m[1]!) ?? { total: 0, bare: 0 };
    e.total++;
    if (m[2] === ')') e.bare++;
    out.set(m[1]!, e);
  }
  return out;
}

describe('style tokens — every var() resolves', () => {
  const body = stripComments(stylesCss);
  const declared = declaredTokens(body);
  const referenced = referencedTokens(body);

  test('the scan actually read the stylesheet', () => {
    // Anti-vacuity: a regex that silently matched nothing would make every
    // assertion below pass. Floors, not exact counts, so ordinary edits don't
    // churn this file.
    expect(declared.size).toBeGreaterThan(80);
    expect(referenced.size).toBeGreaterThan(80);
  });

  test('no rule reads a token that nothing declares', () => {
    const runtime = new Set<string>(RUNTIME_SET);
    const phantom = [...referenced.entries()]
      .filter(([name]) => !declared.has(name) && !runtime.has(name))
      .map(([name, { total, bare }]) => ({ name, reads: total, bareReads: bare }));
    expect(phantom).toEqual([]);
  });

  test('each runtime-set token is really set by a component', () => {
    // The allowlist above is the one place this gate can be lied to, so it is
    // checked rather than trusted: an entry that no component sets is dead
    // weight, and its absence from the stylesheet is then a real defect.
    const unproved = RUNTIME_SET.filter((t) => !TSX_SOURCES.includes(`'${t}'`));
    expect(unproved).toEqual([]);
    expect(TSX_SOURCES.length).toBeGreaterThan(10_000); // the glob resolved
  });
});

/**
 * Gamma tokens no `var()` reads, that are nonetheless read — by a sibling gate
 * or by TypeScript holding the same value. Checked below rather than trusted,
 * for the same reason `RUNTIME_SET` is.
 *
 * EMPTY, and it took a bug to get here. The one entry was `--panel-2`, added
 * when no CSS rule read it. PR #293 gave `.notif-inbox-chip[data-active]`
 * `background: var(--panel-2)`, so the exemption stopped being needed — and
 * nothing said so. The guard below verified that the cited READERS existed,
 * which they did, but never that the exemption was still NECESSARY. An
 * allowlist checked for validity and not for necessity accumulates entries
 * that quietly excuse nothing, and the next real defect hides among them. The
 * second test below closes that direction.
 */
const READ_WITHOUT_VAR: Record<string, { why: string; provenBy: readonly string[] }> = {};

describe('style tokens — every theme token is read', () => {
  const body = stripComments(stylesCss);
  const referenced = referencedTokens(body);
  const blocks = parseThemeBlocks(body);

  test('no gamma declares a token that no rule reads', () => {
    const declaredInGammas = new Set(Object.values(blocks).flatMap((t) => [...t.keys()]));
    expect(declaredInGammas.size).toBeGreaterThan(40); // the parse resolved
    const unread = [...declaredInGammas]
      .filter((t) => !referenced.has(t) && !(t in READ_WITHOUT_VAR))
      .sort();
    expect(unread).toEqual([]);
  });

  test('no exemption outlives its reason', () => {
    // The direction that was missing. `--panel-2` sat here for months after a
    // rule started reading it: still a real token, still read by the files it
    // named, and no longer needing an exemption at all. The list is the one
    // place this gate can be lied to, so an entry that excuses nothing has to
    // fail rather than accumulate.
    const unnecessary = Object.keys(READ_WITHOUT_VAR).filter((t) => referenced.has(t));
    expect(
      unnecessary,
      'a rule now reads these with var(); delete the exemption rather than leaving it to rot',
    ).toEqual([]);
    // Anti-vacuity: `referenced` is the input to both this and the test above,
    // so an empty parse would make both pass over nothing.
    expect(referenced.size).toBeGreaterThan(40);
  });

  test('each var()-less exemption really is read by what it claims', () => {
    const sources = import.meta.glob('./*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    for (const [token, { provenBy }] of Object.entries(READ_WITHOUT_VAR)) {
      for (const file of provenBy) {
        expect(sources[file], `exemption cites a file that does not exist: ${file}`).toBeDefined();
        // `--panel-2` names the token; `theme.ts` holds its hex, so accept
        // either — what is being proved is that the file is a real reader.
        const declaredHexes = [...Object.values(blocks)].map((t) => t.get(token));
        const reads =
          sources[file]!.includes(token) ||
          declaredHexes.some((h) => h && sources[file]!.includes(h));
        expect({ token, file, reads }).toEqual({ token, file, reads: true });
      }
    }
  });
});

/**
 * Semantic hues only. The surface ramp is deliberately excluded: `#ffffff`
 * and friends appear legitimately in shadows, overlays and gradients, and
 * flagging those would make the gate noise. These six are the ones whose
 * per-gamma difference is the entire point of having four gammas.
 */
const SEMANTIC_HUES = ['--accent', '--ok', '--warn', '--err', '--coral'] as const;

describe('style tokens — no gamma colour is pasted into an ordinary rule', () => {
  const body = stripComments(stylesCss);
  const blocks = parseThemeBlocks(body);

  /** `body` with every `:root` / `[data-theme]` declaration block blanked out,
   *  so only ordinary rules remain. Same walk the parity parse uses. */
  const ordinaryRules = (() => {
    let out = body;
    for (const { start, end } of tokenBlockRanges(body)) {
      out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
    }
    return out;
  })();

  test('the mask left ordinary rules behind and removed the definitions', () => {
    // Two-sided anti-vacuity. If the mask blanked the whole file the scan
    // below would pass vacuously; if it blanked nothing, every definition
    // would be reported and the gate would be unusable. Both are checked
    // against a value known to live in exactly one theme block.
    expect(ordinaryRules).toContain('.msg.permission');
    expect(ordinaryRules).not.toContain('--warn-border:');
    expect(body).toContain('--warn-border:');
  });

  test.each(EXPECTED_THEMES)('%s: its hues appear only in its own block', (theme) => {
    const tokens = blocks[theme];
    expect(tokens, `theme block missing: ${theme}`).toBeDefined();
    // Whitespace-free copy so the two spellings can be found by containment.
    // A dynamic `new RegExp` here would trip `security/detect-non-literal-regexp`
    // — and containment is enough for a numeric triple.
    const compact = ordinaryRules.replace(/\s+/g, '').toLowerCase();
    const found: { token: string; literal: string }[] = [];
    for (const token of SEMANTIC_HUES) {
      if (!tokens!.has(token)) continue;
      const { r, g, b } = resolveColor(tokens!, token);
      // Both spellings a hand-pasted value takes: the hex it was copied from
      // and the rgb()/rgba() the copier expanded it to.
      const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
      const triple = `${r},${g},${b}`;
      if (compact.includes(hex)) found.push({ token, literal: hex });
      if (compact.includes(`rgb(${triple}`) || compact.includes(`rgba(${triple}`)) {
        found.push({ token, literal: `rgb(${triple})` });
      }
    }
    expect({ theme, found }).toEqual({ theme, found: [] });
  });
});
