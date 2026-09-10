import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { stripComments } from './test_support/strip_comments.js';

/**
 * Cebab-y65z, rewritten for `Cebab-6s27` — who may REPLACE an agent's system
 * prompt, and who may only add to it.
 *
 * The original invariant was "exactly three files write a systemPrompt", which
 * mattered because writing there was believed additive: an ordinary turn had no
 * system prompt, so a note filled a blank. That premise stopped holding, and the
 * distinction the set was tracking turned out to be the wrong one — the risk was
 * never HOW MANY files write, it was that ANY of them replaces.
 *
 * So the field split. `systemPrompt` is now a complete replacement and
 * `systemPromptAppend` is additive by construction, reaching the SDK as the
 * `append` of `{ type: 'preset', preset: 'claude_code' }`. This file pins the
 * REPLACEMENT set, because that is the one where a new member is dangerous;
 * an append writer can only ever add a paragraph.
 *
 * The comment cases below are unchanged in spirit: four comments once asserted
 * the absolute "Cebab sets no system prompt anywhere", and a reader who greps
 * must not find votes for a wrong answer.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.resolve(HERE);

/**
 * Every non-test, non-smoke `.ts` under `server/src`, EXCLUDING
 * `runner/claude.ts` (its JSDoc documents the field and is the one file whose
 * prose deliberately discusses every writer).
 *
 * A directory walk, NOT `git ls-files`: the existing source gates walk (see
 * `ws/projects_emit_site.test.ts`), and spawning git inside vitest costs a
 * process on three CI runners.
 */
function scannedFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...scannedFiles(full));
      continue;
    }
    const name = entry.name;
    if (!name.endsWith('.ts')) continue;
    if (name.endsWith('.test.ts')) continue;
    if (name.includes('smoke')) continue;
    if (path.relative(SERVER_SRC, full) === path.join('runner', 'claude.ts')) continue;
    out.push(full);
  }
  return out;
}

/**
 * Comments are stripped (via the shared `test_support/strip_comments`, the one
 * copy the conformance gate pins) so a `systemPrompt:` mentioned in prose — as
 * claude.ts's JSDoc does — is not counted as a writer.
 *
 * A line that writes (or spreads) a `systemPrompt` value onto an options object.
 */
const WRITER = /^\s*(\.\.\.)?\s*systemPrompt:\s*\S/m;
/** The additive field. Safe by construction, but tracked so the two sets can be
 *  told apart — and so a reader can see that the note MOVED rather than went. */
const APPENDER = /^\s*(\.\.\.)?\s*systemPromptAppend:\s*\S/m;

function matching(files: string[], re: RegExp): string[] {
  return files
    .filter((f) => re.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(SERVER_SRC, f))
    .sort();
}

describe('the systemPrompt writer set', () => {
  test('exactly two files REPLACE a system prompt, and claude.ts names the seam', () => {
    const files = scannedFiles(SERVER_SRC);

    // Anti-vacuity on the WALK: a walker that returns nothing would pass the
    // exact-set assertion below by finding no writers. Folded into this test (not
    // a standalone case) so it cannot read as a guard that never reddens.
    expect(files.length).toBeGreaterThan(80);

    // Anti-vacuity on the SET, both directions: assert the count BEFORE comparing,
    // so an empty or broken scan fails loudly rather than an empty array happening
    // to equal an empty expectation. Add a third replacement writer under
    // `server/src` and this reddens — the direction that matters, because a
    // replacement silently discards Claude Code's whole prompt.
    const writers = matching(files, WRITER);
    expect(writers.length).toBe(2);
    expect(writers).toEqual([
      // The help assistant's own identity: a different product that deliberately
      // does not want Claude Code's instructions.
      path.join('assistant', 'identity.ts'),
      // The ternary that hands the assistant posture to the spawn. Ordinary
      // turns take the other arm and pass no replacement at all.
      path.join('ws', 'server.ts'),
    ]);

    // `runner/mcp_status_note.ts` is deliberately NOT in that list any more, and
    // asserting where it went is the point: it used to replace the prompt and now
    // appends. A change that moved it back would redden the set above; this makes
    // the reason legible instead of leaving a bare count change.
    expect(matching(files, APPENDER)).toEqual([path.join('runner', 'mcp_status_note.ts')]);

    // Tied to the set: `runner/claude.ts` (the file that documents both fields,
    // deliberately excluded from the scan) must NAME the replacement writer and
    // point at the additive alternative, rather than restating the old absolute.
    const claudeDoc = fs.readFileSync(path.join(SERVER_SRC, 'runner', 'claude.ts'), 'utf8');
    expect(claudeDoc).toContain('identity.ts');
    expect(claudeDoc).toContain('systemPromptAppend');
  });
});

describe('no comment re-asserts that Cebab sets no system prompt anywhere', () => {
  // Whitespace-and-asterisk runs collapse to one space so a phrase that wraps
  // across comment lines is still found; lower-cased so casing cannot dodge it.
  const norm = (rel: string): string =>
    fs
      .readFileSync(path.join(SERVER_SRC, rel), 'utf8')
      .toLowerCase()
      .replace(/[\s*]+/g, ' ');

  // One statically-named test per file (not a loop over a table): restore that
  // file's comment to its false form and exactly this case reddens. Named
  // explicitly so the revert-check can enumerate them — a loop with a
  // template-literal test name is invisible to a static scan and reads as a
  // gate that protects nothing.

  test('runner/claude.ts does not restate the false absolute', () => {
    expect(norm(path.join('runner', 'claude.ts'))).not.toContain('no system prompt anywhere');
  });

  test('assistant/identity.ts does not restate the false absolute', () => {
    expect(norm(path.join('assistant', 'identity.ts'))).not.toContain(
      'sets no system prompt on any other turn',
    );
  });

  test('system_prompt_smoke.ts does not restate the false absolute', () => {
    const text = norm('system_prompt_smoke.ts');
    expect(text).not.toContain('what every cebab turn ships');
    expect(text).not.toContain('what cebab ships');
  });
});
