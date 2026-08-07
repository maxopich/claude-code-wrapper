/**
 * A very small CSS colour engine — enough to measure the contrast of the
 * design tokens declared in `styles.css`, and no more.
 *
 * Why this exists. Two CI gates already read `styles.css`:
 * `styleTokens.test.ts` asserts every `[data-theme]` gamma declares the same
 * token *names*, and `templatePreview/cssGate.test.ts` asserts every `.tpl-*`
 * animation is motion-gated. Neither ever looks at a token's *value*, so the
 * palette was machine-checked for completeness and unchecked for whether a
 * human can read it — which is how `--fg-3` came to fail WCAG AA in all four
 * gammas (register U04) behind a green build.
 *
 * `styleContrast.test.ts` is the gate that closes that hole; this module is
 * the arithmetic it runs on. It is imported only by tests, so it is never
 * pulled into the app bundle — it lives in `src/` beside its own test
 * (`cssColor.test.ts`) because that is this workspace's convention for a
 * module + its spec (`theme.ts`, `format.ts`, `agentIdentity.ts`), and
 * because a measurement instrument that nothing verifies is worth nothing.
 * Its own test pins it to published WCAG reference pairs before any gate is
 * allowed to trust it.
 *
 * Scope: `#rgb`/`#rrggbb`/`#rrggbbaa`, `rgb()`/`rgba()`, `transparent`,
 * `var()` chains within one theme block, and `color-mix(in srgb, …)`. That
 * covers every colour form the four gammas actually declare. Anything else
 * throws by design — a silent `null` here would let the gate skip a pair and
 * still report success, which is precisely the failure mode it exists to
 * prevent.
 */

/** Straight (non-premultiplied) sRGB with alpha; channels are 0–255, alpha 0–1. */
export type Rgba = { r: number; g: number; b: number; a: number };

// ---------------------------------------------------------------- parsing

/** Split on commas that are not inside parentheses. `color-mix(in srgb,
 *  rgba(1, 2, 3, 0.5) 40%, #000)` has three top-level parts, not five. */
export function splitTopLevel(input: string, separator = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === separator && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

/** A token-declaring block, as an inner-text range: `css.slice(start, end)`. */
export type BlockRange = { name: string; start: number; end: number };

/**
 * Every block that *declares* tokens — `:root { … }` and each
 * `[data-theme='NAME'] { … }` — as inner-text ranges, in source order.
 *
 * One walk, exported, because three gates need to agree about where a block
 * begins: parity reads the names, contrast reads the values, and the literal
 * scan in `styleTokens.test.ts` needs the complement — everything *outside*
 * these ranges is an ordinary rule, where a gamma's raw `rgba()` is a defect
 * rather than a definition. A second copy of this walk would be a second
 * opinion about which text is a declaration.
 *
 * The blocks are flat by requirement (see the banner comment in `styles.css`,
 * and `templatePreview/cssGate.test.ts`'s flat-rule regex), so a
 * balanced-brace scan from each opener is sufficient.
 */
export function tokenBlockRanges(css: string): BlockRange[] {
  const out: BlockRange[] = [];
  const openRe = /(?::root|\[data-theme=['"]([a-z]+)['"]\])\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(css)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      const ch = css[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    out.push({ name: m[1] ?? ':root', start, end: i - 1 });
  }
  return out;
}

/**
 * Extract every `[data-theme='NAME'] { … }` block as an ordered map of
 * custom property → raw declared value. `:root` is excluded: it is the
 * gamma-less default, and the parity contract is between gammas.
 *
 * A later declaration of the same token wins, matching the cascade.
 */
export function parseThemeBlocks(css: string): Record<string, Map<string, string>> {
  const out: Record<string, Map<string, string>> = {};
  for (const { name, start, end } of tokenBlockRanges(css)) {
    if (name === ':root') continue;
    const tokens = new Map<string, string>();
    for (const d of blankComments(css.slice(start, end)).matchAll(
      /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi,
    )) {
      tokens.set(d[1]!, d[2]!.trim());
    }
    out[name] = tokens;
  }
  return out;
}

/**
 * Comment bodies replaced by spaces, so offsets and line numbers survive.
 *
 * Load-bearing, not hygiene. The declaration matcher above is case-insensitive
 * and unanchored, so a comment writing `--X-ink: var(--X)` as prose matched as
 * a declaration and then ran `[^;]+` forward to the *next real semicolon* —
 * swallowing the genuine `--ok: …` that followed it and making the gamma look
 * as though it never declared the token. That is a documentation comment
 * silently deleting a colour from a contrast gate's view of the palette.
 */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Substitute `var(--token)` / `var(--token, fallback)` using `tokens`, until
 * no `var()` remains. Throws on an unresolvable token with no fallback: the
 * gate must not silently measure a colour the browser would never paint.
 */
export function resolveVar(tokens: Map<string, string>, value: string, depth = 0): string {
  if (depth > 32) throw new Error(`var() resolution did not terminate: ${value}`);
  const open = value.indexOf('var(');
  if (open === -1) return value;
  // Find this var()'s matching close paren so a nested var() in the fallback
  // is carried along rather than cut in half.
  let i = open + 4;
  let parens = 1;
  while (i < value.length && parens > 0) {
    if (value[i] === '(') parens++;
    else if (value[i] === ')') parens--;
    i++;
  }
  const inner = value.slice(open + 4, i - 1);
  const [name, ...rest] = splitTopLevel(inner);
  const fallback = rest.join(',').trim();
  const declared = tokens.get(name!.trim());
  const replacement = declared ?? fallback;
  if (replacement === '' || replacement === undefined) {
    throw new Error(`unresolvable ${name} with no fallback`);
  }
  return resolveVar(tokens, value.slice(0, open) + replacement + value.slice(i), depth + 1);
}

function parseHex(hex: string): Rgba {
  const h = hex.slice(1);
  const expand = (s: string): number => parseInt(s.length === 1 ? s + s : s, 16);
  if (h.length === 3 || h.length === 4) {
    return {
      r: expand(h[0]!),
      g: expand(h[1]!),
      b: expand(h[2]!),
      a: h.length === 4 ? expand(h[3]!) / 255 : 1,
    };
  }
  if (h.length === 6 || h.length === 8) {
    return {
      r: expand(h.slice(0, 2)),
      g: expand(h.slice(2, 4)),
      b: expand(h.slice(4, 6)),
      a: h.length === 8 ? expand(h.slice(6, 8)) / 255 : 1,
    };
  }
  throw new Error(`unsupported hex colour: ${hex}`);
}

/**
 * Mix two colours per CSS Color 5 `color-mix(in srgb, …)`.
 *
 * The premultiplication step is the whole reason this is not a lerp. The
 * gammas declare `--err-soft: color-mix(in srgb, var(--err) 12%, transparent)`.
 * Naive channel interpolation gives `0.12 × err` — a near-black at 12% alpha.
 * The spec premultiplies, mixes, then un-premultiplies, which yields *err at
 * 12% alpha*: a pale tint of the hue, not a dark one. That difference is the
 * entire finding in register U07, so getting it wrong would hide the bug.
 */
function mixSrgb(a: Rgba, pa: number, b: Rgba, pb: number): Rgba {
  const total = pa + pb;
  if (total === 0) throw new Error('color-mix percentages sum to zero');
  const wa = pa / total;
  const wb = pb / total;
  const alpha = a.a * wa + b.a * wb;
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (ka: number, kb: number): number => (ka * a.a * wa + kb * b.a * wb) / alpha;
  return { r: ch(a.r, b.r), g: ch(a.g, b.g), b: ch(a.b, b.b), a: alpha };
}

/** Pull a trailing `NN%` off a `color-mix` argument, returning the colour
 *  text and the percentage (or null when omitted). */
function splitPercentage(arg: string): { color: string; pct: number | null } {
  const m = /\s([\d.]+)%$/.exec(arg);
  if (!m) return { color: arg.trim(), pct: null };
  return { color: arg.slice(0, m.index).trim(), pct: parseFloat(m[1]!) };
}

/**
 * Parse any colour value the gammas declare, after `var()` resolution.
 * Throws rather than returning null — see the module header.
 */
export function parseColor(value: string): Rgba {
  const v = value.trim();
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (v.startsWith('#')) return parseHex(v);

  const rgbMatch = /^rgba?\(([^)]*)\)$/i.exec(v);
  if (rgbMatch) {
    // Both the legacy comma form and the modern space form appear in this
    // stylesheet; normalise the slash-alpha separator to a comma first.
    const parts = splitTopLevel(rgbMatch[1]!.replace('/', ','))
      .flatMap((p) => (p.includes(' ') ? p.split(/\s+/) : [p]))
      .filter((p) => p !== '');
    const n = (s: string): number =>
      s.endsWith('%') ? (parseFloat(s) / 100) * 255 : parseFloat(s);
    return {
      r: n(parts[0]!),
      g: n(parts[1]!),
      b: n(parts[2]!),
      a: parts[3] === undefined ? 1 : parseFloat(parts[3]),
    };
  }

  const mixMatch = /^color-mix\((.*)\)$/is.exec(v);
  if (mixMatch) {
    const args = splitTopLevel(mixMatch[1]!);
    const space = args[0]!.trim();
    if (space !== 'in srgb') throw new Error(`unsupported color-mix space: ${space}`);
    if (args.length !== 3) throw new Error(`unsupported color-mix arity: ${v}`);
    const first = splitPercentage(args[1]!);
    const second = splitPercentage(args[2]!);
    // Per spec, one omitted percentage is `100 - other`; both omitted is 50/50.
    const pa = first.pct ?? (second.pct === null ? 50 : 100 - second.pct);
    const pb = second.pct ?? 100 - pa;
    return mixSrgb(parseColor(first.color), pa, parseColor(second.color), pb);
  }

  throw new Error(`unsupported colour value: ${value}`);
}

/** Resolve a token's declared value all the way to a colour, within one theme. */
export function resolveColor(tokens: Map<string, string>, token: string): Rgba {
  const declared = tokens.get(token);
  if (declared === undefined) throw new Error(`theme does not declare ${token}`);
  return parseColor(resolveVar(tokens, declared));
}

// ---------------------------------------------------------------- contrast

/** Source-over composite of a translucent colour onto an opaque backdrop. */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  if (bg.a !== 1) throw new Error('backdrop must be opaque');
  if (fg.a === 1) return fg;
  const ch = (f: number, b: number): number => f * fg.a + b * (1 - fg.a);
  return { r: ch(fg.r, bg.r), g: ch(fg.g, bg.g), b: ch(fg.b, bg.b), a: 1 };
}

/** WCAG 2.x relative luminance. Channels are 0–255; alpha is ignored, so
 *  composite() first if the colour is translucent. */
export function relativeLuminance({ r, g, b }: Rgba): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * WCAG 2.x contrast ratio, 1–21. A translucent foreground is composited onto
 * the backdrop first — the browser paints what is behind it, and so must we.
 */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const lf = relativeLuminance(composite(fg, bg));
  const lb = relativeLuminance(bg);
  const [hi, lo] = lf > lb ? [lf, lb] : [lb, lf];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG 1.4.3 AA floor for normal-size text. The muted token's loudest use is
 *  `.session-meta` at 10px, far under the 18.66px/24px large-text threshold,
 *  so no gamma gets to claim the 3:1 allowance. */
export const AA_NORMAL_TEXT = 4.5;
