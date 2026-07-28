/**
 * Tests for the CI audit gate. The two halves worth pinning down are the
 * osv-scanner.toml reader (a narrow regex reader, so its failure modes
 * need to be loud) and the expiry branch — an `ignoreUntil` that has
 * lapsed must block, or writing a date down means nothing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { collectAdvisories, evaluate, parseIgnoreFile } from './audit-gate.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TOML = `
# leading comment
[[IgnoredVulns]]
id = "GHSA-aaaa-bbbb-cccc"
ignoreUntil = "2026-08-07T00:00:00Z"
reason = "held behind min-release-age"

[[IgnoredVulns]]
id = "GHSA-dddd-eeee-ffff"
ignoreUntil = "2026-10-28T00:00:00Z"
reason = "upstream bump pending"
`;

const audit = (vulnerabilities) => ({ vulnerabilities });

const advisory = (id, severity, pkg = 'somepkg') =>
  audit({
    [pkg]: {
      severity,
      via: [{ url: `https://github.com/advisories/${id}`, severity, title: 't', range: '<1' }],
    },
  });

describe('parseIgnoreFile', () => {
  it('reads every entry with its id and expiry', () => {
    const out = parseIgnoreFile(TOML);
    expect(out.map((e) => e.id)).toEqual(['GHSA-aaaa-bbbb-cccc', 'GHSA-dddd-eeee-ffff']);
    expect(out[0].expiry.toISOString()).toBe('2026-08-07T00:00:00.000Z');
  });

  it('returns nothing for a file with no entries', () => {
    expect(parseIgnoreFile('# just a comment\n')).toEqual([]);
  });

  it('throws rather than silently skipping an entry with no id', () => {
    expect(() => parseIgnoreFile('[[IgnoredVulns]]\nignoreUntil = "2026-01-01T00:00:00Z"\n')).toThrow(
      /has no `id`/,
    );
  });

  it('throws rather than silently skipping an entry with no ignoreUntil', () => {
    expect(() => parseIgnoreFile('[[IgnoredVulns]]\nid = "GHSA-x"\n')).toThrow(/has no `ignoreUntil`/);
  });

  it('throws on an unparseable date', () => {
    expect(() =>
      parseIgnoreFile('[[IgnoredVulns]]\nid = "GHSA-x"\nignoreUntil = "whenever"\n'),
    ).toThrow(/unparseable ignoreUntil/);
  });

  it('does not let a following table leak keys into the last entry', () => {
    const out = parseIgnoreFile(`${TOML}\n[SomethingElse]\nid = "GHSA-leak"\n`);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.id)).not.toContain('GHSA-leak');
  });

  it('parses the real osv-scanner.toml [security]', () => {
    const real = parseIgnoreFile(readFileSync(join(REPO_ROOT, 'osv-scanner.toml'), 'utf8'));
    for (const entry of real) {
      expect(entry.id).toMatch(/^GHSA-/);
      expect(Number.isNaN(entry.expiry.getTime())).toBe(false);
    }
  });
});

describe('collectAdvisories', () => {
  it('emits one row per advisory object', () => {
    const out = collectAdvisories(advisory('GHSA-aaaa-bbbb-cccc', 'high', 'brace-expansion'));
    expect(out).toEqual([
      expect.objectContaining({ id: 'GHSA-aaaa-bbbb-cccc', pkg: 'brace-expansion', severity: 'high' }),
    ]);
  });

  it('skips string `via` entries (vulnerable-only-via-a-dependency)', () => {
    const out = collectAdvisories(
      audit({ parent: { severity: 'high', range: '<1', via: ['child'] } }),
    );
    expect(out).toEqual([]);
  });

  it('handles an empty report', () => {
    expect(collectAdvisories({})).toEqual([]);
  });
});

describe('evaluate', () => {
  const ignores = parseIgnoreFile(TOML);
  const before = new Date('2026-07-28T00:00:00Z');
  const after = new Date('2026-09-01T00:00:00Z');

  it('blocks an unexcused high', () => {
    const r = evaluate(collectAdvisories(advisory('GHSA-9999', 'high')), ignores, before);
    expect(r.ok).toBe(false);
    expect(r.blocked.map((a) => a.id)).toEqual(['GHSA-9999']);
  });

  it('blocks an unexcused critical', () => {
    const r = evaluate(collectAdvisories(advisory('GHSA-9999', 'critical')), ignores, before);
    expect(r.ok).toBe(false);
  });

  it('passes an excused high while the date holds', () => {
    const r = evaluate(collectAdvisories(advisory('GHSA-aaaa-bbbb-cccc', 'high')), ignores, before);
    expect(r.ok).toBe(true);
    expect(r.excused.map((a) => a.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('blocks the same advisory once ignoreUntil has passed [security]', () => {
    const r = evaluate(collectAdvisories(advisory('GHSA-aaaa-bbbb-cccc', 'high')), ignores, after);
    expect(r.ok).toBe(false);
    expect(r.expired.map((a) => a.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
    expect(r.blocked).toEqual([]);
  });

  it('ignores moderate and low regardless of the allowlist', () => {
    const r = evaluate(
      collectAdvisories(advisory('GHSA-moderate-only', 'moderate')),
      ignores,
      before,
    );
    expect(r.ok).toBe(true);
    expect(r.blocked).toEqual([]);
  });

  it('reports an unused ignore without failing the run', () => {
    const r = evaluate([], ignores, before);
    expect(r.ok).toBe(true);
    expect(r.unused.map((e) => e.id)).toEqual(['GHSA-aaaa-bbbb-cccc', 'GHSA-dddd-eeee-ffff']);
  });

  it('does not call an ignore unused when it covers a non-blocking advisory', () => {
    // GHSA-dddd covers a moderate: below this gate's threshold, but OSV
    // still blocks on it, so the entry must not be flagged for retirement.
    const r = evaluate(
      collectAdvisories(advisory('GHSA-dddd-eeee-ffff', 'moderate')),
      ignores,
      before,
    );
    expect(r.ok).toBe(true);
    expect(r.unused.map((e) => e.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('passes cleanly on an empty report', () => {
    expect(evaluate([], [], before).ok).toBe(true);
  });
});
