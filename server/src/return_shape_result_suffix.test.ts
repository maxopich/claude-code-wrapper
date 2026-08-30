/**
 * Cebab-x1n.8.24 (register N24): executor return-shape types use ONE suffix.
 *
 * A function that returns a small `{ … }` describing what it did names that
 * shape `SomethingResult` — the dominant idiom (`SearchResult`, `CopyResult`,
 * `AddWorkerResult`, `MigrationIntegrityResult`, …). Five return shapes used
 * `Outcome` instead, so autocomplete and grep needed two guesses for every
 * executor. They were renamed to `Result`; this guard keeps a sixth from
 * appearing, since the failure it watches for — someone reaching for the wrong
 * synonym on a new return shape — is textual and a grep is the right instrument.
 *
 * Two `*Outcome` types are ALLOWED and named below. They are not return-shape
 * wrappers: `RecoveryOutcome` is a domain status VALUE (`'reached_final' | …`,
 * the recovery-log column is literally `outcome`), and `TrustGateOutcome` is
 * the operator's DECISION union passed to a parked promise's `resolve`, not the
 * summary a gate function returns (that is `GateResult`). Renaming either to
 * `Result` would misdescribe it. A future genuine domain `*Outcome` is added
 * here deliberately — which is the point: the convention decision stays explicit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** `*Outcome` type/interface names that are NOT executor return shapes. */
const ALLOWED_OUTCOME_TYPES = ['RecoveryOutcome', 'TrustGateOutcome'];

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// `\b` after `Outcome` means `RecoveryOutcomeStatus` (a distinct `*Status` type)
// does not match — only names that END in `Outcome`. Global + multiline so a
// file declaring several is fully scanned.
const OUTCOME_DECL = /export\s+(?:type|interface)\s+([A-Za-z0-9_]*Outcome)\b/g;

function declaredOutcomeTypes(files: string[]): { name: string; file: string }[] {
  const found: { name: string; file: string }[] = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(OUTCOME_DECL)) {
      found.push({ name: m[1], file: path.relative(REPO, f) });
    }
  }
  return found;
}

describe('executor return shapes use the Result suffix, not Outcome', () => {
  const files = [
    ...sourcesUnder(path.join(REPO, 'server', 'src')),
    ...sourcesUnder(path.join(REPO, 'shared', 'src')),
    ...sourcesUnder(path.join(REPO, 'web', 'src')),
  ];

  test('the scan actually reads the tree it claims to', () => {
    // Anti-vacuity (the guard `projects_emit_site.test.ts` and
    // `mcp_status_single_definition.test.ts` both carry): a walk that reads
    // nothing reports zero offenders and passes, indistinguishable from clean.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith(path.join('server', 'src', 'repo', 'search.ts')))).toBe(
      true,
    );
  });

  test('the regex finds the two allowed domain outcomes (positive control)', () => {
    // Proves OUTCOME_DECL matches real declarations — without this a broken
    // regex would find zero offenders below and pass for the wrong reason.
    const names = new Set(declaredOutcomeTypes(files).map((d) => d.name));
    for (const allowed of ALLOWED_OUTCOME_TYPES) {
      expect(names.has(allowed)).toBe(true);
    }
  });

  test('no return-shape type keeps the Outcome suffix', () => {
    const offenders = declaredOutcomeTypes(files)
      .filter((d) => !ALLOWED_OUTCOME_TYPES.includes(d.name))
      .map((d) => `${d.name} (${d.file})`);
    expect(offenders).toEqual([]);
  });
});
