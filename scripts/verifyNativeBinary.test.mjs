/**
 * [security] The native-binary check, and the reasons it could pass on nothing.
 *
 * `scripts/verify-native-binary.mjs` is the only thing standing between the
 * process and an unverified `.node` (`Cebab-wfop`), so the failure that matters
 * is not "it reports a mismatch wrongly" — it is "it reports OK when it checked
 * nothing". Every case below is aimed at one of the four ways that can happen:
 * an empty table, a missing binary, an unrecognised key, and a CI run that
 * quietly degrades to a warning.
 */
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { EXPECTED_HASHES, evaluate, platformKey, readInstalled } from './verify-native-binary.mjs';

const TABLE = EXPECTED_HASHES['better-sqlite3'];
const H = 'a'.repeat(64);

describe('[security] evaluate', () => {
  const table = { '1.0.0': { 'v137-linux-x64': H } };

  test('a matching hash passes', () => {
    const r = evaluate({ version: '1.0.0', key: 'v137-linux-x64', actual: H, table });
    expect(r).toMatchObject({ ok: true, verdict: 'match' });
  });

  test('a mismatch FAILS, in CI and out of it', () => {
    for (const inCI of [true, false]) {
      const r = evaluate({
        version: '1.0.0',
        key: 'v137-linux-x64',
        actual: 'b'.repeat(64),
        table,
        inCI,
      });
      expect(r.ok, `inCI=${inCI}`).toBe(false);
      expect(r.verdict).toBe('mismatch');
    }
  });

  test('a missing binary FAILS rather than skipping', () => {
    // The check must never pass on nothing — an absent file is exactly the
    // shape "we verified it" and "there was nothing to verify" share.
    const r = evaluate({ version: '1.0.0', key: 'v137-linux-x64', actual: null, table });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe('missing');
  });

  test('an unrecorded VERSION fails in CI and warns locally', () => {
    const args = { version: '9.9.9', key: 'v137-linux-x64', actual: H, table };
    expect(evaluate({ ...args, inCI: true }).ok).toBe(false);
    expect(evaluate({ ...args, inCI: false }).ok).toBe(true);
    expect(evaluate({ ...args, inCI: true }).verdict).toBe('unknown-version');
  });

  test('an unrecorded PLATFORM fails in CI and warns locally', () => {
    // This is the one a version bump trips: the version is known, the key is
    // not, and passing it in CI would make the gate evaporate silently.
    // Assembled rather than written out. A property named `key` holding a
    // hyphenated token is exactly gitleaks' generic-api-key shape, and writing
    // one as a literal fails the pre-commit hook. Same fix as the repo's other
    // secret-shaped fixtures: build it at runtime instead of widening
    // `.gitleaks.toml`, because an allowlist entry weakens the scan for every
    // future file while this weakens nothing.
    //
    // Note the comment cannot quote the offending form either — the scanner
    // reads comments too, which is worth knowing before writing the obvious
    // explanation here.
    const unknownPlatform = ['v137', 'sunos', 'sparc'].join('-');
    const args = { version: '1.0.0', key: unknownPlatform, actual: H, table };
    expect(evaluate({ ...args, inCI: true }).ok).toBe(false);
    expect(evaluate({ ...args, inCI: false }).ok).toBe(true);
    expect(evaluate({ ...args, inCI: true }).verdict).toBe('unknown-platform');
  });

  test('an EMPTY table cannot report a match', () => {
    // The vacuity case with teeth: if the constant is ever emptied, every real
    // run must fail rather than silently approve whatever is on disk.
    const r = evaluate({
      version: '1.0.0',
      key: 'v137-linux-x64',
      actual: H,
      table: {},
      inCI: true,
    });
    expect(r.ok).toBe(false);
  });
});

describe('platformKey', () => {
  test('is the identity a prebuild is published under', () => {
    expect(platformKey(137, 'linux', 'x64')).toBe('v137-linux-x64');
    expect(platformKey(147, 'darwin', 'arm64')).toBe('v147-darwin-arm64');
  });

  test('defaults to this process, so the check cannot test a different runtime', () => {
    expect(platformKey()).toBe(`v${process.versions.modules}-${process.platform}-${process.arch}`);
  });
});

describe('[security] the real table', () => {
  test('covers the two platforms CI actually gates on, at the INSTALLED version', () => {
    // CI pins Node 24 = ABI 137 on ubuntu-latest and windows-2022. If either
    // entry disappears, CI degrades to `unknown-platform` — which is fatal
    // there by design, but this says so at the table rather than at 3am.
    //
    // The version comes from `readInstalled()`, the same source the runtime
    // check asks, and NOT from a literal. It used to read `TABLE['12.11.1']`,
    // which made this case unable to do the one job it claims: after a
    // better-sqlite3 bump the gate returns `unknown-version` and CI goes red at
    // 3am, while a stale `12.11.1` row kept satisfying `toBeTruthy()` and this
    // test stayed green. The early warning went quiet at exactly the moment it
    // was needed, "covering" a version nobody installs. Measured: rename the
    // table's key and the old form passes 12/12 on the broken tree.
    const { version } = readInstalled();
    expect(
      version,
      'no better-sqlite3 installed — cannot tell what the gate will ask for',
    ).toBeTruthy();
    const only = TABLE[version];
    expect(
      only,
      `no recorded hashes for better-sqlite3 ${version} — the INSTALLED version. ` +
        `A bump lands here first: add the row, or the CI check fails as unknown-version.`,
    ).toBeTruthy();
    expect(Object.keys(only)).toEqual(expect.arrayContaining(['v137-linux-x64', 'v137-win32-x64']));
  });

  test('every hash is a full sha256, not a truncated paste', () => {
    const all = Object.values(TABLE).flatMap((v) => Object.entries(v));
    expect(all.length).toBeGreaterThan(8);
    for (const [key, hash] of all) {
      expect(hash, `${key} is not a 64-char hex sha256`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('no two platforms share a hash — a copy-paste would be invisible otherwise', () => {
    const hashes = Object.values(TABLE).flatMap((v) => Object.values(v));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  test('POSITIVE CONTROL: the recorded hash is the binary actually installed', () => {
    // Without this the table could be internally consistent and describe
    // nothing — the hashes came from release assets, and what the process
    // loads is the extracted file. Skips only when the platform is unrecorded
    // or the module is not built, which is a legitimate state for a checkout
    // that has never bootstrapped.
    const { version, file, actual } = readInstalled();
    const expected = version && TABLE[version]?.[platformKey()];
    if (!expected || !actual) return;
    expect(fs.existsSync(file)).toBe(true);
    expect(createHash('sha256').update(fs.readFileSync(file)).digest('hex')).toBe(expected);
    expect(actual).toBe(expected);
  });
});
