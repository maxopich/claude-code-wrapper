/**
 * [security] The allowlist's own bookkeeping — `osv-scanner.toml` as DATA.
 *
 * `scripts/audit-gate.test.mjs` covers the script that reads this file. This
 * covers the file itself, and specifically the facts about it that are
 * maintained by hand, are load-bearing for two required security checks, and
 * have no other reader.
 *
 * THE ONE THAT ACTUALLY BITES is the cooldown coupling. Every entry is a
 * "wait, don't override" excuse whose expiry was computed from `.npmrc`'s
 * `min-release-age` — publish date plus N days. Raise N in `.npmrc` and every
 * eligibility date written into a reason becomes wrong, silently, in the
 * direction that hurts: an entry expires BEFORE its fix is installable, and
 * register C17 made that expiry a hard CI failure. The only exits from that
 * state are overriding the supply-chain control or re-dating an excuse under
 * deadline pressure — both the thing this file exists to prevent. Three files
 * hold the same number and `.github/dependabot.yml`'s own comment says it
 * "Mirrors `min-release-age` in .npmrc"; nothing checked that it did.
 *
 * The rest is the stale-prose class this repo keeps rediscovering — the
 * semgrep rule count in #298, the migration count in #299. A hand-written
 * count in a header is a claim, and an unchecked claim drifts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseIgnoreFile } from './audit-gate.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');

const TOML = read('osv-scanner.toml');
const ENTRIES = parseIgnoreFile(TOML);

// Literal regexes throughout: `security/detect-non-literal-regexp` forbids
// building these from variables, and a spelled-out alternation is what makes
// the count claim greppable by a human too.
// `entry remains` accepted alongside `entries remain` so a count of one can be
// written in English. Cosmetic only — the assertion below still compares the
// spelled-out number against the parsed entry count, unchanged.
const COUNT_CLAIM =
  /^#\s*(zero|one|two|three|four|five|six|seven|eight|nine|ten) entr(?:ies remain|y remains)/im;
const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];

/** `.npmrc`'s supply-chain cooldown, in days. Throws rather than defaulting. */
function npmrcCooldownDays() {
  const days = /^min-release-age\s*=\s*(\d+)\s*$/m.exec(read('.npmrc'))?.[1];
  if (days === undefined) throw new Error('.npmrc: no `min-release-age` setting found');
  return Number(days);
}

/**
 * Dependabot's cooldown for the NPM ecosystem specifically.
 *
 * A narrow block reader in the same spirit as `parseIgnoreFile`, and for the
 * same reason: `yaml` resolves only as an unhoisted transitive here, so
 * importing it works locally and breaks on a clean `npm ci` (see the note in
 * `scripts/semgrepRules.test.mjs`). Deliberately NOT "every default-days in
 * the file" — the github-actions ecosystem has its own, and coupling that to
 * an npm-only setting would be a fake constraint.
 */
function dependabotNpmCooldownDays() {
  const blocks = read('.github/dependabot.yml')
    .split(/^ {2}- package-ecosystem:/m)
    .slice(1);
  const npm = blocks.filter((block) => /^\s*['"]?npm['"]?\s*$/.test(block.split('\n')[0]));
  if (npm.length !== 1) {
    throw new Error(`dependabot.yml: expected exactly 1 npm ecosystem block, found ${npm.length}`);
  }
  const days = /^\s*default-days:\s*(\d+)\s*$/m.exec(npm[0])?.[1];
  if (days === undefined)
    throw new Error('dependabot.yml: npm block has no `cooldown.default-days`');
  return Number(days);
}

describe('[security] osv-scanner.toml bookkeeping', () => {
  it('states the number of entries it actually has', () => {
    const match = COUNT_CLAIM.exec(TOML);
    // Anti-vacuity: with no claim in the file there is nothing to compare and
    // the assertion below would pass over `undefined === undefined`.
    expect(match, 'osv-scanner.toml has no "<word> entries remain" line').not.toBeNull();
    expect(NUMBER_WORDS.indexOf(match[1].toLowerCase())).toBe(ENTRIES.length);
  });

  it('gives every entry a reason naming a FIXED VERSION', () => {
    // The retire workflow reads this: "bump past FIXED VERSION, delete the
    // entry". An excuse that does not say what would end it is an excuse
    // nobody can close, and neither gate can tell the difference.
    for (const entry of ENTRIES) {
      expect(entry.reason, `${entry.id} has no FIXED VERSION in its reason`).toMatch(
        /FIXED VERSION\s+\S+/,
      );
    }
  });

  it('has no duplicate advisory ids', () => {
    // The three hono siblings were added by copy-paste from each other. A
    // duplicated id is invisible to both gates — osv-scanner filters the same
    // advisory twice and the audit gate's `byId` map silently keeps the last.
    expect([...new Set(ENTRIES.map((e) => e.id))]).toHaveLength(ENTRIES.length);
  });

  it('the parser really parses — anti-vacuity, measured on a fixture', () => {
    // Every case above iterates ENTRIES, so a broken `parseIgnoreFile` would
    // satisfy them by having nothing to check.
    //
    // This used to assert `ENTRIES.length > 0` against the live file, which
    // conflated two different facts: "the parser works" and "the allowlist is
    // non-empty". Only the first is an invariant. An EMPTY allowlist is the
    // intended resting state — every entry is a temporary excuse — and it
    // arrived on 2026-08-11 when the last five holds were retired, at which
    // point the old floor failed on the success case and the only ways out
    // were deleting the guard or keeping a dead entry to feed it.
    //
    // So prove the machinery on input this test owns. The live file is then
    // free to be empty without disarming anything.
    const fixture = [
      '[[IgnoredVulns]]',
      'id = "GHSA-aaaa-bbbb-cccc"',
      'ignoreUntil = "2099-01-01T00:00:00Z"',
      'reason = "fixture — FIXED VERSION 9.9.9"',
      '',
      '[[IgnoredVulns]]',
      'id = "GHSA-dddd-eeee-ffff"',
      'ignoreUntil = "2099-01-01T00:00:00Z"',
      'reason = "fixture — FIXED VERSION 8.8.8"',
    ].join('\n');
    const parsed = parseIgnoreFile(fixture);
    expect(parsed.map((e) => e.id)).toEqual(['GHSA-aaaa-bbbb-cccc', 'GHSA-dddd-eeee-ffff']);
    expect(parsed[0].reason).toMatch(/FIXED VERSION 9\.9\.9/);
  });
});

describe('[security] the supply-chain cooldown is one number in three files', () => {
  it('.npmrc and dependabot.yml agree', () => {
    expect(dependabotNpmCooldownDays()).toBe(npmrcCooldownDays());
  });

  it('every cooldown figure written into osv-scanner.toml agrees with .npmrc', () => {
    const cited = [...TOML.matchAll(/min-release-age=(\d+)/g)].map((m) => Number(m[1]));
    // Anti-vacuity: the reasons cite the number in prose, so a rewording that
    // drops every mention would leave this asserting over an empty array.
    expect(cited.length, 'osv-scanner.toml cites no min-release-age figure').toBeGreaterThan(0);
    expect([...new Set(cited)]).toEqual([npmrcCooldownDays()]);
  });

  it('the readers find real values rather than defaulting — anti-vacuity', () => {
    // Both helpers throw on a miss rather than returning 0, so a typo in
    // either file is loud. Pin that they returned a plausible cooldown, not
    // whatever a silently-failed regex would produce.
    expect(npmrcCooldownDays()).toBeGreaterThan(0);
    expect(dependabotNpmCooldownDays()).toBeGreaterThan(0);
  });
});
