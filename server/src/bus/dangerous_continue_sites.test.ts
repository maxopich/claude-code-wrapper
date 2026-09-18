import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { stripComments } from '../test_support/strip_comments.js';

/**
 * `Cebab-vie.29` — every place that burns the dangerous-command approval grant
 * must have recorded the approval first.
 *
 * There are TWO such places, `orchestrator.ts` and `chain.ts`, and this exact
 * pair has drifted before: the chain copy of the execute-mode grant was added a
 * release later and kept a fail-open `try/catch` the orchestrator had already
 * outgrown (`Cebab-vie.21`). A third site would be added by someone who copied
 * one of them.
 *
 * WHY A SOURCE SCAN RATHER THAN A BEHAVIOURAL TEST. Driving
 * `continueThroughMutation` end-to-end needs a live session with a paused
 * dangerous mutation, and the existing chain harness mocks that method outright
 * — so the wiring is exactly the kind of seam that stays green while being
 * wrong. This is the house pattern for that (`ws/bus_cap_sites.test.ts`), and
 * it asks only the one thing a copy-paste gets wrong: did this site audit
 * before it released?
 *
 * It deliberately does NOT check that the audit is correct, or that its result
 * is honoured — the module's own tests cover the first, and the second is
 * visible in the three lines this scan points at.
 */

const FILES = ['orchestrator.ts', 'chain.ts'].map((f) => ({
  name: f,
  source: fs.readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8'),
}));

/** How far ABOVE a release call its audit may sit. */
const WINDOW_LINES = 25;

/** Line numbers (1-based) of every `releasePauseForMutation(` CALL — not the import. */
export function releaseSites(source: string): number[] {
  return stripComments(source)
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes('releasePauseForMutation('))
    .map(({ n }) => n);
}

/** The subset of `releaseSites` with no `auditDangerousContinue(` above them. */
export function unauditedSites(source: string): number[] {
  const lines = stripComments(source).split('\n');
  return releaseSites(source).filter((n) => {
    const from = Math.max(0, n - 1 - WINDOW_LINES);
    return !lines.slice(from, n - 1).some((l) => l.includes('auditDangerousContinue('));
  });
}

describe('every dangerous-continue site audits before it releases', () => {
  test('ANTI-VACUITY: the scan found the sites it is meant to be checking', () => {
    // Without this floor, renaming `releasePauseForMutation` turns every
    // assertion below into "[] equals []" — a gate that measures nothing while
    // reporting a clean pass.
    for (const { name, source } of FILES) {
      expect(releaseSites(source).length, `${name} has no release site`).toBeGreaterThan(0);
    }
    const total = FILES.reduce((n, f) => n + releaseSites(f.source).length, 0);
    expect(total).toBe(2);
  });

  test('[security] no site burns the grant without recording the approval', () => {
    for (const { name, source } of FILES) {
      expect(unauditedSites(source), `${name}: unaudited release site(s)`).toEqual([]);
    }
  });

  test('and each site refuses to release when the record was not written', () => {
    // The audit is useless if its answer is ignored. One line, at both sites.
    for (const { name, source } of FILES) {
      const stripped = stripComments(source);
      expect(stripped.includes('if (!continueAudit.recorded) return;'), `${name}`).toBe(true);
    }
  });
});
