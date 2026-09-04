/**
 * [security] Register C08 — the guard that stops the fixture-review gate from
 * reporting success when the labeller that feeds it failed.
 *
 * `Fixture review gate` blocks a PR while `awaiting-fixture-review` is on it,
 * and the maintainer removes that label after checking the recorded SDK turns
 * for real OAuth artifacts and API keys (gitleaks does not see them in JSONL
 * prose). That used to say "a CODEOWNER"; `.github/CODEOWNERS` was dropped with
 * the repo-workflow automation in #520, and since `require_code_owner_reviews`
 * was already false it was naming a mechanism that had never gated anything.
 * The gate reads label state from the API only. So if `apply-labels` FAILS the
 * label is never applied, the API shows nothing, and the gate prints
 * "Gate clear." — a fixtures PR merges unreviewed. `if: always()` is what let
 * the gate run at all in that state.
 *
 * The fix is a guard STEP, not a job condition: the gate is a required check,
 * so a skipped job leaves it never reporting and the PR wedged (register C18).
 *
 * This is a text scan, not a YAML parse, on purpose — `yaml` resolves here only
 * as an unhoisted transitive of another package, and a gate should not rest on
 * that. Comments are stripped BEFORE anything is matched, and the strip is
 * asserted: a case-insensitive scan reading prose as structure is exactly what
 * broke `parseThemeBlocks` in PR #293.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WORKFLOW = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.github',
  'workflows',
  'pr-label.yml',
);

/**
 * Drop `#` comments, keeping line numbering so indentation still lines up.
 *
 * CRLF is normalised FIRST, and the reason has changed since this was written.
 * It said "the repo has no `.gitattributes`, so a Windows checkout hands this
 * file back with `\r\n`". There IS one now, and its first rule is
 * `* text=auto eol=lf` — added precisely because CRLF checkouts were breaking
 * text-scanning tests.
 *
 * The normalisation stays, because `.gitattributes` binds what git writes and
 * not what a contributor's editor, a patch tool, or a `core.autocrlf=true`
 * global leaves behind. A test that scans a file as text should not assume its
 * input. Verified by converting the workflow to CRLF locally: five of these six
 * tests fail without it — a Windows-only red on a file nobody would suspect.
 */
export function stripComments(yaml) {
  return yaml
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      // Named `commentAt`, not `hash`: eslint's
      // `security/detect-possible-timing-attacks` matches the IDENTIFIER name
      // and flags any `===` against one called `hash`.
      const commentAt = line.indexOf('#');
      if (commentAt === -1) return line;
      // Only a comment when the `#` is at line start or preceded by space —
      // otherwise it is inside a value (an anchor, a fragment, a colour).
      const before = line.slice(0, commentAt);
      if (commentAt > 0 && !before.endsWith(' ')) return line;
      return before.trimEnd();
    })
    .join('\n');
}

/** The lines of one top-level job block, by its two-space-indented key. */
export function jobBlock(yaml, jobKey) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `  ${jobKey}:`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

const raw = fs.readFileSync(WORKFLOW, 'utf8');
const yaml = stripComments(raw);

describe('[security] pr-label.yml — the fixture gate fails closed', () => {
  it('the comment strip actually removed something', () => {
    // Anti-vacuity: if the strip silently no-opped, every assertion below could
    // be satisfied by prose in a comment rather than by real workflow keys.
    expect(raw).toMatch(/^\s*#/m);
    expect(yaml.length).toBeLessThan(raw.length);
    expect(yaml).not.toMatch(/^\s*#/m);
  });

  it('the gate job block is found', () => {
    // Anti-vacuity for the block-scoped assertions: a renamed job would make
    // them vacuously true against an empty string.
    const block = jobBlock(yaml, 'fixture-review-gate');
    expect(block).not.toBeNull();
    expect(block.length).toBeGreaterThan(100);
  });

  it('the gate still depends on the labeller', () => {
    const block = jobBlock(yaml, 'fixture-review-gate');
    expect(block).toMatch(/needs:\s*\[apply-labels\]/);
  });

  it('the gate job still runs unconditionally, so the required check reports', () => {
    // Not decoration. Moving the labeller check onto the JOB would make it skip
    // instead of fail, and a required check that never reports blocks the PR
    // with no way to clear it.
    const block = jobBlock(yaml, 'fixture-review-gate');
    expect(block).toMatch(/^\s{4}if:\s*always\(\)\s*$/m);
  });

  it('a step blocks when the labeller neither succeeded nor was skipped', () => {
    const block = jobBlock(yaml, 'fixture-review-gate');
    const guard = block
      .split(/^ {6}- /m)
      .find((step) => /if:.*needs\.apply-labels\.result/.test(step));
    expect(guard).toBeDefined();
    // Both arms matter: dropping `!= 'skipped'` breaks the CODEOWNER path
    // (apply-labels is skipped on labeled/unlabeled), and dropping
    // `!= 'success'` restores the original hole.
    expect(guard).toMatch(/needs\.apply-labels\.result\s*!=\s*'success'/);
    expect(guard).toMatch(/needs\.apply-labels\.result\s*!=\s*'skipped'/);
    expect(guard).toMatch(/exit 1/);
  });

  it('the label check itself still blocks on the label', () => {
    const block = jobBlock(yaml, 'fixture-review-gate');
    expect(block).toMatch(/awaiting-fixture-review/);
    expect(block).toMatch(/exit 1/);
  });
});
