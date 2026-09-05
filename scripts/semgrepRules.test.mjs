/**
 * [security] Register X09 / C07 / X13 — the custom Semgrep rules must stay
 * capable of firing, and the places that COUNT them must agree with the file.
 *
 * The failure this exists to prevent, in full. `.semgrep/cebab-bus.yaml` once
 * carried a rule whose own comment called it the "highest-leverage" one. The
 * pure-SDK bus rewrite deleted the function it patterned on. The rule then
 * matched nothing, forever. Nothing failed — a rule that CANNOT fire and a
 * rule that found nothing produce the identical green check — so SECURITY.md
 * went on listing it as live CI coverage, and the workflow header drifted to
 * claiming four rules for a file that defined three.
 *
 * Two independent gates now cover that, and they fail in different places on
 * purpose:
 *
 *   1. `semgrep --test` (the semgrep workflow) runs the ruleid/ok annotations
 *      in `.semgrep/cebab-bus.ts` and proves each rule still matches its own
 *      fixture. That is the real liveness proof, but it only runs where
 *      semgrep is installed.
 *   2. THIS file, in the main suite on ubuntu and windows, with no semgrep
 *      dependency. It asserts the structure that gate 1 relies on — every
 *      rule has a fixture, every fixture names a real rule — plus the two
 *      prose counts. A rule added without a fixture is red here, before it
 *      ever reaches the workflow.
 *
 * Parsing is line-oriented rather than via a YAML library on purpose: `yaml`
 * is UNDECLARED here — it appears in no `package.json`, and resolves only
 * because npm happens to hoist it to the root as somebody else's transitive.
 * (Re-measured 2026-09-04: it does resolve from the repo root today, so the
 * older wording "unhoisted transitive" named the wrong mechanism. The
 * conclusion is if anything stronger — a dependency nothing declares can be
 * relocated or dropped by a lockfile change with no source edit, and no source
 * scan can see it coming.) Same choice, same reason, as
 * `scripts/workflowPermissions.test.mjs`, whose own `PARSING is line-oriented
 * by indentation, not a YAML library` note records the same undeclared-`js-yaml`
 * reasoning for the same file type.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Read a repo file as text with CRLF normalised away.
 *
 * `.gitattributes` pins LF on checkout, but a test that scans a file as text
 * should not assume its input: a contributor with a global
 * `core.autocrlf=true`, or a file arriving by some other route, still reads
 * with `\r` at every line end. This repo has lost a CI round-trip to that
 * three times. */
function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
}

const RULES_YAML = '.semgrep/cebab-bus.yaml';
const FIXTURE = '.semgrep/cebab-bus.ts';

/**
 * Rule ids declared in the config, in file order.
 *
 * Matches `  - id: <name>` at the two-space indent semgrep's `rules:` list
 * uses. Anchored to line start so the many `- id:` strings inside the header
 * prose and the dropped-rules footer cannot inflate the count.
 */
function declaredRuleIds(yaml) {
  return yaml
    .split('\n')
    .map((line) => /^ {2}- id:\s*(\S+)\s*$/.exec(line))
    .filter(Boolean)
    .map((m) => m[1]);
}

/** Rule ids asserted by a `ruleid` annotation in the fixture file. */
function fixtureRuleIds(ts) {
  return [...ts.matchAll(/^\s*\/\/\s*ruleid:\s*(\S+)\s*$/gm)].map((m) => m[1]);
}

/** Rule ids asserted by an `ok` annotation in the fixture file. */
function fixtureOkIds(ts) {
  return [...ts.matchAll(/^\s*\/\/\s*ok:\s*(\S+)\s*$/gm)].map((m) => m[1]);
}

/**
 * The prose form both docs use to count the rules.
 *
 * A literal, not a `new RegExp` built from `NUMBER_WORDS`: eslint's
 * `security/detect-non-literal-regexp` rejects the constructed form, and the
 * two must be kept in sync by eye anyway.
 */
const COUNT_CLAIM = /(zero|one|two|three|four|five|six) Cebab-specific custom rules/i;
/**
 * The OTHER phrasing, and the reason this gate needed a second pattern.
 *
 * `Cebab-m99x`: SECURITY.md said "three Cebab-specific custom rules" on one
 * line and "Those TWO Semgrep rules each carry a fixture" two lines later. The
 * file held both numbers, one of them wrong, and this gate stayed green —
 * because it matched the first phrasing and stopped. A gate that checks one
 * sentence in a file and ignores a contradicting one next to it is measuring
 * the sentence, not the claim.
 *
 * `g` because ALL of them are checked now, not the first.
 */
const COUNT_CLAIM_ALT = /(zero|one|two|three|four|five|six) Semgrep rules/gi;
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];

/** Extract a doc's spelled-out rule count as a number, or null if it no
 *  longer states one. */
function statedRuleCount(text) {
  const found = COUNT_CLAIM.exec(text);
  return found ? NUMBER_WORDS.indexOf(found[1].toLowerCase()) : null;
}

/**
 * EVERY count-shaped claim about the rules in a document, in order.
 *
 * Returns numbers, so a caller asserts they all agree with reality rather than
 * that the first one does. An empty array means the document states no count —
 * which the callers treat as its own failure, since a doc that stopped counting
 * is how a wrong count becomes invisible.
 */
function allStatedRuleCounts(text) {
  const out = [];
  const first = COUNT_CLAIM.exec(text);
  if (first) out.push(NUMBER_WORDS.indexOf(first[1].toLowerCase()));
  for (const m of text.matchAll(COUNT_CLAIM_ALT)) {
    out.push(NUMBER_WORDS.indexOf(m[1].toLowerCase()));
  }
  return out;
}

describe('[security] semgrep custom rules — liveness and counts', () => {
  const yaml = read(RULES_YAML);
  const fixture = read(FIXTURE);
  const ruleIds = declaredRuleIds(yaml);

  test('the config parses to a non-empty rule list', () => {
    // Anti-vacuity. Every assertion below is a set comparison against
    // `ruleIds`; if the indent or the `- id:` spelling ever changes, that
    // list silently empties and each of those comparisons passes on nothing.
    expect(ruleIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ruleIds).size).toBe(ruleIds.length); // no duplicate ids
    for (const id of ruleIds) expect(id).toMatch(/^cebab-[a-zA-Z0-9-]+$/);
  });

  test('every declared rule has a fixture asserting it still fires', () => {
    // The gate. A rule whose target is deleted stops matching its fixture and
    // fails `semgrep --test`; a rule with NO fixture cannot fail at all, which
    // is how the dead one survived.
    const asserted = new Set(fixtureRuleIds(fixture));
    expect(asserted.size).toBeGreaterThan(0);
    for (const id of ruleIds) {
      expect(asserted, `${FIXTURE} has no "ruleid" annotation for ${id}`).toContain(id);
    }
  });

  test('every declared rule has a fixture pinning the compliant shape too', () => {
    // Without an `ok` case a rule that matched EVERYTHING would still pass its
    // liveness check. `cebab-ws-server-no-verifyClient` is exactly the shape
    // where that matters: its whole job is the `pattern-not`.
    const ok = new Set(fixtureOkIds(fixture));
    for (const id of ruleIds) {
      expect(ok, `${FIXTURE} has no "ok" annotation for ${id}`).toContain(id);
    }
  });

  test('no fixture annotation names a rule that does not exist', () => {
    // Orphan annotations fail `semgrep --test` with a rule-id mismatch, which
    // reads as a rules problem rather than a stale-fixture one. Catch it here
    // with the clearer message.
    const declared = new Set(ruleIds);
    for (const id of [...fixtureRuleIds(fixture), ...fixtureOkIds(fixture)]) {
      expect(declared, `${FIXTURE} annotates unknown rule ${id}`).toContain(id);
    }
  });

  test('SECURITY.md states the real number of custom rules', () => {
    // It said "three ... (F1 silent-bug, F4 verifyClient, F2 spawn-non-literal)"
    // while one of the three could not fire — overstating CI coverage in the
    // file people read to judge whether running this is safe.
    const stated = statedRuleCount(read('SECURITY.md'));
    expect(stated, 'SECURITY.md no longer states a custom-rule count').not.toBeNull();
    expect(stated).toBe(ruleIds.length);
  });

  test('EVERY count SECURITY.md states agrees — not just the first one', () => {
    // `Cebab-m99x`. The file said "three Cebab-specific custom rules" and, two
    // lines below, "Those TWO Semgrep rules each carry a fixture". Both numbers
    // sat in one file, one of them wrong, and the test above stayed green
    // because it matched the first phrasing and stopped reading.
    const counts = allStatedRuleCounts(read('SECURITY.md'));
    expect(counts.length, 'SECURITY.md states no rule count at all').toBeGreaterThan(0);
    for (const n of counts) expect(n).toBe(ruleIds.length);
  });

  test('the semgrep workflow header states the real number of custom rules', () => {
    // This one drifted to "four" against a file defining three, which is how
    // the dead rule stayed invisible: the count no one could reconcile.
    const stated = statedRuleCount(read('.github/workflows/semgrep.yml'));
    expect(stated, 'semgrep.yml no longer states a custom-rule count').not.toBeNull();
    expect(stated).toBe(ruleIds.length);
  });

  test('the workflow runs the fixture suite, from the directory that pairs them', () => {
    // `semgrep --test` finds no rule/test pairs unless .semgrep is the cwd,
    // and prints "No unit tests found" and exits 0 when it finds none — so
    // both the working-directory and the output guard are load-bearing.
    //
    // Comments are stripped before matching. The first version of this test
    // asserted against the raw file and passed after the `--exclude` flag was
    // deleted, because the comment explaining the flag still mentioned it —
    // caught by revert-checking this very case.
    const wf = read('.github/workflows/semgrep.yml')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(wf).toContain('working-directory: .semgrep');
    expect(wf).toMatch(/semgrep --test/);
    expect(wf).toContain('All tests passed');
    // And the main scan must skip the fixtures, which are deliberate violations.
    expect(wf).toContain('--exclude=.semgrep');
  });
});
