/**
 * Blank out comments while preserving line numbering — the first step every
 * source-derived gate in this repo needs, and the one with a bug history.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE OTHER TWO COPIES. There are three homes
 * for this function and the split is forced by the build, not by taste:
 *
 *   - `web/src/sourceScan.ts` — `web/tsconfig.json` sets `types: []`, enforced
 *     by `web/src/nodeTypeIsolation.test.ts`.
 *   - `server/src/test_support/strip_comments.ts` — `server/tsconfig.json` sets
 *     `rootDir: src` with no `allowJs`, so importing this file from a server
 *     test fails typecheck with `TS7016: Could not find a declaration file`.
 *     Measured, not assumed.
 *   - this one, for `scripts/*.test.mjs`.
 *
 * Copies are only safe if divergence FAILS, so
 * `scripts/stripCommentsConformance.test.mjs` feeds all three the same fixture
 * table and asserts identical output. Fix a bug here and the other two go red
 * until they carry it too. That is the part a comment cannot enforce.
 *
 * THE BUG THIS SHAPE EXISTS TO AVOID (Cebab-1px). Every previous copy resolved
 * block comments in one pass and line comments in another, block first. So a
 * `/*` occurring INSIDE a `//` comment — an ordinary glob like
 * `.claude/commands/` + `*.md`, a regex, a path — was read as a block opener.
 * With no `*` + `/` after it, `web/src/sourceScan.ts` returned everything
 * before it and `bounded_reads.test.ts` blanked every line after it.
 * `SlashCommandsList.tsx` stripped to the EMPTY STRING, and the seven gates
 * that run this first saw nothing at all in it — a scan that measures nothing
 * reports a clean file (`project_gates_pass_vacuously`).
 *
 * The fix is not a longer regex. It is deciding `//` versus `/*` by WHICH
 * COMES FIRST on the line, which needs one left-to-right pass, not two.
 *
 * WHAT IT STILL DOES NOT DO, stated so it is not mistaken for a parser: string
 * literals are not tracked, so `const s = '/* not a comment *' + '/'` would be
 * stripped. That is a miss in the safe direction for every caller here — they
 * scan for declarations and call sites, and a swallowed string literal cannot
 * manufacture one. `://` is excluded from the line-comment rule so a URL in a
 * string does not truncate the code after it.
 *
 * Lines are BLANKED, never deleted, so a caller can report `i + 1` as a real
 * file line. An earlier `.filter()` in the web copy shifted every line after a
 * comment, which is a silent off-by-N in any message naming a line number.
 *
 * @param {string} src
 * @returns {string} same line count, comments replaced by nothing
 */
export function stripComments(src) {
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
        // `://` is a URL, not a comment. `search` finds the character before
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
export function strippedLines(src) {
  return stripComments(src).split('\n');
}
