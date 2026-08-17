import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { strippedLines } from '../test_support/strip_comments.js';

/**
 * Register S10: a safety-class `emit()` must not have its result thrown away.
 *
 * The dispatcher's contract (CLAUDE.md, spec §3 BE-1) is that a safety-class
 * event writes its `safety_audit` row BEFORE the WS notification ships, and
 * that **if the append throws, the caller refuses to proceed**. It signals
 * that by returning `{ ok: false, error: 'audit_write_failed' }` — a return
 * value, so a caller that ignores it has silently opted out of the contract.
 * That is what the max-turns cap-hit site did: a failed hash-chained append
 * for a safety event was completely silent, in the one subsystem whose whole
 * value is that it has no gaps.
 *
 * Fixing that one line would leave the next author free to re-introduce it,
 * so the rule is derived from the source instead of from a list somebody
 * maintains. Every `emitNotification(` call in `server/src` is classified by
 * reading its own `class:` field, and safety ones must hand the result
 * somewhere.
 *
 * WHAT THIS DOES NOT CHECK, stated so it isn't mistaken for more than it is:
 *
 *   - It does not verify the handling is *good* — only that the result is
 *     bound to a name that is then read, or returned to a caller. A caller
 *     that binds and ignores is a different (and far more visible) smell.
 *   - It does not follow a returned result into its caller. `return emit(…)`
 *     is accepted on the pass-through wrapper's own terms.
 *   - It reads text, not a syntax tree. The `class:` field must appear
 *     within `CLASS_WINDOW_LINES` of the call. A reformat that moves it
 *     further **fails** this test rather than skipping the call — see
 *     `unclassified` below. That is the anti-vacuity rule, and it is the
 *     reason this file can be trusted at all.
 *
 * COMMENTS ARE STRIPPED FIRST (Cebab-6sr). Until 2026-08-17 this scanned raw
 * lines, so a doc comment NAMING `emitNotification(` while explaining the rule
 * was counted as an unclassifiable call site and failed the gate. It happened
 * for real: a JSDoc block in `migration_integrity.ts` explaining why its emit
 * is inline was reported as `migration_integrity.ts:156`, and the fix at the
 * time was to reword the prose. That is backwards — it taught the next author
 * not to write about the rule near the code the rule governs, which is the
 * opposite of what this repo does everywhere else. Zero real comments were
 * miscounted when this was fixed; the cost was the prose that never got
 * written.
 *
 * The scan takes a CONTENT MAP rather than reading files itself, so the two
 * fixture cases below can feed it text directly. Without that seam the second
 * half of the rule — that a genuinely unclassifiable call still FAILS — could
 * only be asserted by trusting the tree, and "strip everything" would pass.
 */

const SERVER_SRC = fileURLToPath(new URL('../', import.meta.url));

/** How far past `emitNotification(` to look for the call's `class:` field. */
const CLASS_WINDOW_LINES = 12;
/** How far past the call to look for a read of the bound result. */
const USE_WINDOW_LINES = 40;

type CallSite = {
  file: string;
  line: number;
  cls: 'safety' | 'operational' | null;
  /** Bound name (`const x = emit(…)`), `'returned'`, or null when discarded. */
  handling: string | 'returned' | null;
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

/** Read every scanned file once, keyed by the path this gate reports. */
function readServerSources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of sourceFiles(SERVER_SRC)) {
    out[path.relative(SERVER_SRC, file)] = fs.readFileSync(file, 'utf8');
  }
  return out;
}

function scan(sources: Record<string, string>): CallSite[] {
  const sites: CallSite[] = [];
  for (const [file, source] of Object.entries(sources)) {
    // Split on \r?\n: without a .gitattributes these files are checked out
    // CRLF on Windows CI, and a lookup carrying an embedded \n finds nothing
    // there and nowhere else. Stripping happens after the split so the line
    // INDEX still matches the file a reader opens.
    const lines = strippedLines(source.split(/\r?\n/).join('\n'));
    lines.forEach((line, i) => {
      if (!line.includes('emitNotification(')) return;
      // The dispatcher's own re-export/alias lines are not call sites.
      if (/^\s*(import|export)\b/.test(line)) return;

      const window = lines.slice(i, i + CLASS_WINDOW_LINES).join('\n');
      const cls = /class:\s*'safety'/.test(window)
        ? 'safety'
        : /class:\s*'operational'/.test(window)
          ? 'operational'
          : null;

      // Tokenised rather than pattern-matched. A regex for this needs
      // adjacent variable-length runs (`\s+` beside an optional `await\s+`),
      // which eslint's `security/detect-unsafe-regex` rejects, and the
      // usage check below would need a `new RegExp` built from a captured
      // name (`detect-non-literal-regexp`). Reading the prefix is clearer
      // than appeasing either rule.
      const prefix = line.slice(0, line.indexOf('emitNotification(')).trim();
      const head = prefix.endsWith('await') ? prefix.slice(0, -'await'.length).trim() : prefix;

      let handling: CallSite['handling'] = null;
      if (head === 'return') {
        handling = 'returned';
      } else if (head.endsWith('=')) {
        const words = head.slice(0, -1).trim().split(/\s+/);
        const bound = words[words.length - 1];
        // Bound is only half the claim — assert the name is read afterwards.
        // Substring match, not word-boundary: a false ACCEPT would need a
        // second identifier ending in this same name and followed by `.ok`,
        // which is a stretch for a locally-scoped result variable.
        const after = lines.slice(i + 1, i + 1 + USE_WINDOW_LINES).join('\n');
        const read =
          !!bound &&
          (after.includes(`${bound}.ok`) ||
            after.includes(`${bound}.error`) ||
            after.includes(`${bound}.id`));
        handling = read ? bound : null;
      }
      sites.push({ file, line: i + 1, cls, handling });
    });
  }
  return sites;
}

describe('[security] the scanner reads code, not the prose about it', () => {
  // Cebab-6sr. Both halves are required and they fail for opposite reasons: the
  // first would pass if the scanner strips nothing, the second if it strips
  // everything. Only a scanner that removes comments and keeps code passes both.

  test('a doc comment naming the dispatcher call is not a call site', () => {
    // Verbatim shape of the block that failed this gate for real, in
    // `migration_integrity.ts`. It has no `class:` field, so before the fix it
    // surfaced as an unclassifiable call and the gate went red on prose.
    const prose = [
      '/**',
      ' * The audit row is written by an inline emitNotification( call rather',
      ' * than an injected one, because the boot walk has no dispatcher yet.',
      ' */',
      'const x = 1;',
      '// A trailing note: emitNotification( is also named here.',
    ].join('\n');
    expect(scan({ 'probe.ts': prose })).toEqual([]);
  });

  test('a real unclassifiable call in the same file still fails', () => {
    // The positive control. Same prose, plus one genuine call with no `class:`
    // within the window — which must still be reported, at the line a reader
    // would open the file to. Without this case, deleting the whole file's
    // contents would be a passing "fix".
    const mixed = [
      '/**',
      ' * Prose naming emitNotification( that must be ignored.',
      ' */',
      'await emitNotification({ event: "x" });',
    ].join('\n');
    expect(scan({ 'probe.ts': mixed })).toEqual([
      { file: 'probe.ts', line: 4, cls: null, handling: null },
    ]);
  });

  test('classification and handling still work on stripped source', () => {
    // Proves the strip did not eat the `class:` field or the binding — the two
    // things every assertion below is derived from.
    const src = [
      '// a note about safety emits',
      "const res = await emitNotification({ class: 'safety' });",
      'if (!res.ok) throw new Error("audit_write_failed");',
    ].join('\n');
    expect(scan({ 'probe.ts': src })).toEqual([
      { file: 'probe.ts', line: 2, cls: 'safety', handling: 'res' },
    ]);
  });
});

describe('[security] every safety-class notification hands its result somewhere', () => {
  const sites = scan(readServerSources());

  test('the scan actually found the call sites (anti-vacuity floor)', () => {
    // If the extraction breaks — renamed alias, moved directory, a glob that
    // matches nothing — every assertion below passes over an empty list. The
    // floors are well under the real counts so ordinary churn doesn't trip
    // them, and well above zero so a broken scan cannot look clean.
    expect(sites.length).toBeGreaterThanOrEqual(15);
    expect(sites.filter((s) => s.cls === 'safety').length).toBeGreaterThanOrEqual(6);
    expect(sites.filter((s) => s.cls === 'operational').length).toBeGreaterThanOrEqual(6);
  });

  test('every call site is classifiable — an unreadable one fails, it is not skipped', () => {
    const unclassified = sites.filter((s) => s.cls === null);
    expect(
      unclassified.map((s) => `${s.file}:${s.line}`),
      `these emitNotification calls have no 'class:' within ${CLASS_WINDOW_LINES} lines, so this ` +
        `gate cannot tell whether they carry the safety contract. Move the field up, or widen ` +
        `CLASS_WINDOW_LINES — do not leave it unreadable.`,
    ).toEqual([]);
  });

  test('no safety-class call discards its result', () => {
    const discarded = sites.filter((s) => s.cls === 'safety' && s.handling === null);
    expect(
      discarded.map((s) => `${s.file}:${s.line}`),
      `a safety-class emit returns { ok: false, error: 'audit_write_failed' } when the ` +
        `hash-chained append throws. Discarding it makes that failure silent. Bind the result ` +
        `and check it, or return it to a caller that does.`,
    ).toEqual([]);
  });

  test('operational calls are free to discard — the gate is about the audit obligation', () => {
    // Documents the deliberate asymmetry, and doubles as proof that the
    // `handling === null` detector can produce a non-empty list at all. If
    // this ever comes back empty, the detector has stopped detecting and the
    // test above is passing for the wrong reason.
    const discardedOperational = sites.filter(
      (s) => s.cls === 'operational' && s.handling === null,
    );
    expect(discardedOperational.length).toBeGreaterThan(0);
  });
});
