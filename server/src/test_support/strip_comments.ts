/**
 * Blank out comments while preserving line numbering, for the server-side
 * source-derived gates (`bounded_reads.test.ts`, `safety_emit_result.test.ts`).
 *
 * This is a deliberate third copy of `scripts/lib/strip_comments.mjs`, and the
 * reason is a build boundary rather than a preference: `server/tsconfig.json`
 * sets `rootDir: src` with no `allowJs`, so importing the `.mjs` from a server
 * test fails `npm run typecheck` with
 *
 *     error TS7016: Could not find a declaration file for module
 *     '../../scripts/lib/strip_comments.mjs' … implicitly has an 'any' type.
 *
 * Measured, not assumed. `scripts/stripCommentsConformance.test.mjs` feeds this
 * copy and the other two the same fixture table and asserts identical output,
 * so the copies cannot drift silently — see that file and the `.mjs` original
 * for the full history of the bug this shape avoids (Cebab-1px: resolving `/*`
 * before `//` lets a glob inside a line comment open a block that never closes,
 * and the scan then measures an empty file).
 */

/** Same line count, comments replaced by nothing. */
export function stripComments(source: string): string {
  let inBlock = false;
  return source
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

/** The same thing as an array, for callers that index by line. */
export function strippedLines(source: string): string[] {
  return stripComments(source).split('\n');
}
