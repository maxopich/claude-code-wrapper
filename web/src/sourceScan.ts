/**
 * Shared primitives for the source-scanning gates (`widgetRoles.test.ts`,
 * `operatorCopy.test.ts`, `clipboardConvergence.test.ts`). Each of those reads
 * component sources as literal text via Vite's `?raw` glob and asserts a rule
 * over them; all of them need the same first step, and that step has a bug
 * history worth having in exactly one place.
 *
 * Not a test file — it ships in `src/` so several specs can import it, but
 * nothing in the app imports it, so it costs nothing at runtime.
 */

/**
 * Source with its prose removed: block comments (including the braced JSX
 * form) and `//` line comments.
 *
 * Both directions matter. A comment EXPLAINING a construct that was removed
 * would otherwise be reported as a live declaration — which is exactly what
 * happened while writing `widgetRoles.test.ts`, where a note saying why
 * `LogToolbar` dropped its role kept the gate red. And a comment MENTIONING
 * the thing a gate accepts as proof would launder a component that never does
 * it. This file's own U-numbered comments would trip the copy scan for the
 * same reason if it did not run first.
 *
 * ONE LEFT-TO-RIGHT PASS, and that is the whole point (Cebab-1px). This used to
 * remove block comments in one pass and filter whole-line `//` in a second,
 * block first — so a `/*` occurring INSIDE a line comment was read as a block
 * opener. `SlashCommandsList.tsx:16` names the glob `.claude/commands/` +
 * `*.md` in a `//` comment; nothing closed the phantom block, the old code took
 * its `unterminated block: drop the rest` branch, and the remaining lines were
 * all `//` and got filtered. **stripComments returned the empty string for a
 * 60-line component**, and the seven gates that call it first saw nothing at
 * all in that file. A scan measuring nothing reports a clean file. Deciding
 * `//` versus `/*` by which comes FIRST on the line needs a single pass; no
 * amount of regex fixes a two-pass order.
 *
 * Trailing `//` is now stripped too, guarded by `://` so a URL in a string does
 * not truncate the code after it. The old "whole-line only" rule was a proxy
 * for that guard and cost more than it saved.
 *
 * Comment lines are BLANKED, not deleted, so line numbering survives. The old
 * `.filter()` shifted every line after a comment, which is a silent off-by-N in
 * any message that names a line.
 *
 * Not a parser: string literals are not tracked, so a `/*` inside a string is
 * treated as an opener. That is a miss in the safe direction for every caller
 * here — they scan for declarations and JSX text, and a swallowed string
 * literal cannot manufacture either.
 *
 * Kept in sync with `scripts/lib/strip_comments.mjs` and
 * `server/src/test_support/strip_comments.ts` by
 * `scripts/stripCommentsConformance.test.mjs`, which asserts all three return
 * identical output. Three copies exist because `web/tsconfig.json` sets
 * `types: []` and `server/tsconfig.json` sets `rootDir: src` — see the `.mjs`
 * header for the measured errors.
 */
export function stripComments(src: string): string {
  let inBlock = false;
  return src
    .split('\n')
    .map((raw) => {
      let line = raw;
      let out = '';
      for (;;) {
        if (inBlock) {
          const close = line.indexOf('*/');
          if (close === -1) return out;
          line = line.slice(close + 2);
          inBlock = false;
          continue;
        }
        const block = line.indexOf('/*');
        // `://` is a URL, not a comment. `search` matches the character before
        // the pair, so re-locate the pair itself from there.
        const guard = line.search(/(^|[^:])\/\//);
        const lineCmt = guard === -1 ? -1 : line.indexOf('//', guard);
        if (block === -1 && lineCmt === -1) return out + line;
        if (lineCmt !== -1 && (block === -1 || lineCmt < block)) {
          return out + line.slice(0, lineCmt);
        }
        out += line.slice(0, block);
        line = line.slice(block + 2);
        inBlock = true;
      }
    })
    .join('\n');
}

/**
 * The literal text a reader would see, extracted from JSX: everything between
 * a `>` and the next `<`, with `{…}` expressions dropped.
 *
 * Deliberately crude, and the crudeness is safe in one direction. Interpolated
 * values are invisible to it, so a phase number arriving through a variable
 * would slip past — that is a miss, not a false alarm. What it will not do is
 * flag a prop value, an import path or an identifier as operator-facing copy,
 * which is what makes a "no repository paths in the UI" rule usable at all:
 * `import … from './shortcutRegistry'` must not read as a sentence shown to
 * anyone.
 *
 * Run `stripComments` first, or JSX `{/* … *\/}` blocks arrive here as text.
 */
export function jsxTextNodes(src: string): string[] {
  const out: string[] = [];
  const re = />([^<>]+)</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const raw = m[1] ?? '';
    // Drop `{expr}` interpolations — their contents are code, not copy.
    const text = raw.replace(/\{[^{}]*\}/g, ' ').trim();
    if (text.length > 0) out.push(text);
  }
  return out;
}
