import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { stripComments } from './test_support/strip_comments.js';

/**
 * Cebab-y65z — the `systemPrompt:` writer set has exactly three members, and
 * the comments describing it must not re-assert the false absolute.
 *
 * The claim that makes writing to `Options.systemPrompt` safe (Cebab-ws0.15) is
 * QUALIFIED: an ORDINARY project turn sets no system prompt, so a note added
 * there fills a blank. Two production paths DO set a real value — the built-in
 * help assistant (`ASSISTANT_SYSTEM_PROMPT` in `assistant/identity.ts`) and the
 * MCP status note (`mcpStatusNoteSpec` in `runner/mcp_status_note.ts`) — and
 * both reach the spawn through the ternary in `ws/server.ts`.
 *
 * Four comments once asserted the absolute ("Cebab sets no system prompt
 * anywhere"); a later reader who greps finds several votes for a wrong answer.
 * This test pins the truth two ways: the writer SET (so a fourth writer cannot
 * land silently) and the CORRECTED comments (so none drifts back to the
 * absolute).
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

describe('the systemPrompt writer set', () => {
  test('exactly three files write a systemPrompt value, and claude.ts names them', () => {
    const files = scannedFiles(SERVER_SRC);

    // Anti-vacuity on the WALK: a walker that returns nothing would pass the
    // exact-set assertion below by finding no writers. Folded into this test (not
    // a standalone case) so it cannot read as a guard that never reddens.
    expect(files.length).toBeGreaterThan(80);

    const writers = files
      .filter((f) => WRITER.test(stripComments(fs.readFileSync(f, 'utf8'))))
      .map((f) => path.relative(SERVER_SRC, f))
      .sort();

    // Anti-vacuity on the SET, both directions: assert the count BEFORE comparing,
    // so an empty or broken scan fails loudly rather than an empty array happening
    // to equal an empty expectation. Add a fifth writer under `server/src` and
    // this reddens — the direction that stops the next writer landing silently.
    expect(writers.length).toBe(3);
    expect(writers).toEqual([
      path.join('assistant', 'identity.ts'),
      path.join('runner', 'mcp_status_note.ts'),
      path.join('ws', 'server.ts'),
    ]);

    // Criterion 1, tied to the set: `runner/claude.ts` (the file that documents
    // the field, deliberately excluded from the scan) must NAME the two real
    // writers, not restate the false absolute. The pre-fix JSDoc named neither,
    // so restoring it reddens this — coupling the set to the comment it explains.
    const claudeDoc = fs.readFileSync(path.join(SERVER_SRC, 'runner', 'claude.ts'), 'utf8');
    expect(claudeDoc).toContain('identity.ts');
    expect(claudeDoc).toContain('mcp_status_note.ts');
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
