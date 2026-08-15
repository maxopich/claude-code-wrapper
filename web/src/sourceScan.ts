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
 * form) and whole-line `//` comments.
 *
 * Both directions matter. A comment EXPLAINING a construct that was removed
 * would otherwise be reported as a live declaration — which is exactly what
 * happened while writing `widgetRoles.test.ts`, where a note saying why
 * `LogToolbar` dropped its role kept the gate red. And a comment MENTIONING
 * the thing a gate accepts as proof would launder a component that never does
 * it. This file's own U-numbered comments would trip the copy scan for the
 * same reason if it did not run first.
 *
 * Only whole-line `//` comments are stripped, never a trailing one: `//` also
 * appears inside string literals (`https://…`), and truncating a code line at
 * the first slash pair could silently delete a real declaration further along
 * it. Prose lives on its own lines in this codebase anyway.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('/*', i);
    if (open === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, open);
    const close = src.indexOf('*/', open + 2);
    if (close === -1) break; // unterminated block: drop the rest
    i = close + 2;
  }
  return out
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
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
