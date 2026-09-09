import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { stripComments } from './test_support/strip_comments.js';

/**
 * [security] `Cebab-6fax.46` — the audit chain is read before anything writes
 * to it.
 *
 * `main()`'s boot sequence ran `runDataPermsBootCheck()` first, and that call
 * can emit a `data_perms.insecure` safety notification — which APPENDS a row to
 * the hash chain. So on a boot where the data directory is insecure AND the
 * chain has been tampered with, Cebab extended the chain it had not yet
 * examined. `runMigrationIntegrityBootCheck` emits too, from further down.
 *
 * The blast radius is smaller than it was: since `Cebab-6fax.13`/`.15` an
 * append no longer clears a re-seat or a mirror loss, so the append does not
 * BLESS anything any more. The ordering is still wrong on its own terms — a
 * verifier that writes first is measuring a state it helped create — and it
 * costs one moved statement.
 *
 * WHY A SOURCE TEST. `main()` runs on import and is not reachable from a unit
 * test — the same reason `data_perms_boot.ts` and `migration_integrity_boot.ts`
 * exist as extracted, testable calls in the first place. The property is the
 * ORDER of three statements, which is exactly what this can read.
 */

const INDEX_TS = fileURLToPath(new URL('./index.ts', import.meta.url));

/** Position of a call in `index.ts`, comments stripped. -1 when absent. */
export function callAt(source: string, call: string): number {
  return stripComments(source).indexOf(call);
}

describe('[security] boot reads the audit chain before it writes to it', () => {
  const source = fs.readFileSync(INDEX_TS, 'utf8');

  test('all three calls are present — anti-vacuity', () => {
    // Two `-1`s compare as equal and would satisfy an ordering assertion
    // forever (`project_gates_pass_vacuously`).
    for (const call of [
      'verifyChain()',
      'runDataPermsBootCheck()',
      'runMigrationIntegrityBootCheck(',
    ]) {
      expect(callAt(source, call), `${call} not found in index.ts`).toBeGreaterThan(-1);
    }
  });

  test('verifyChain runs before every boot check that can emit', () => {
    const verify = callAt(source, 'verifyChain()');
    expect(
      callAt(source, 'runDataPermsBootCheck()'),
      'runDataPermsBootCheck can emit a safety notification, which appends to ' +
        'the hash chain. It must not run before the chain is verified.',
    ).toBeGreaterThan(verify);
    expect(callAt(source, 'runMigrationIntegrityBootCheck(')).toBeGreaterThan(verify);
  });

  test('the predicate would catch the pre-fix order', () => {
    // The other direction, on a fixture rather than on the tree.
    const before = ['runDataPermsBootCheck();', 'const r = verifyChain();'].join('\n');
    expect(callAt(before, 'runDataPermsBootCheck()')).toBeLessThan(callAt(before, 'verifyChain()'));
  });
});
