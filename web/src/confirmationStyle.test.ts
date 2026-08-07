import { describe, expect, test } from 'vitest';
import { stripComments } from './sourceScan';

/**
 * One rule for asking "are you sure?" (registers U16, U29).
 *
 * The app had ten consequential actions gated four different ways: four native
 * `window.confirm` dialogs, two in-app typed gates done properly, two more that
 * printed the required token inside the field asking you to type it, and two
 * actions with no gate at all — one of them in the same row slot as a gated
 * one. Fixing ten call sites fixes ten call sites; these two rules are what
 * stop the eleventh.
 *
 * Both scans strip comments first, so the U-numbered notes left at the fix
 * sites (several of which quote the old `window.confirm` by name) can explain
 * themselves without turning the gate red — the failure mode that made
 * `widgetRoles.test.ts` fail on its own prose two PRs ago.
 */

const SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob(['./**/*.ts', './**/*.tsx'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).filter(([file]) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx')),
);

/** SCREAMING_CASE identifiers this codebase uses for "the string the operator
 *  must type": `RAW_ACK_PHRASE`, `BULK_DELETE_TOKEN`, `ACKNOWLEDGMENT_TRIGGER`. */
const TOKEN_NAMES = /\b([A-Z][A-Z0-9_]*(?:TOKEN|PHRASE|ACK|TRIGGER)[A-Z0-9_]*)\b/g;

/**
 * Token identifiers this source interpolates into a `placeholder`. Plain
 * string containment rather than a built regex — the dynamic-RegExp lint rule
 * is right that composing patterns from scanned text is a bad habit, and the
 * two JSX spellings are a closed set anyway.
 */
function echoedTokens(code: string): string[] {
  const found: string[] = [];
  for (const t of new Set(Array.from(code.matchAll(TOKEN_NAMES), (m) => m[1]!))) {
    if (code.includes(`placeholder={${t}}`) || code.includes(`placeholder={\`\${${t}}`)) {
      found.push(t);
    }
  }
  return found.sort();
}

describe('confirmation style', () => {
  // Anti-vacuity: a glob that matched nothing would report both rules clean.
  test('the scan reads the app', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(60);
  });

  /**
   * A native dialog is the one surface in this app the theme cannot reach. It
   * also cannot be styled, cannot carry markup naming the thing being acted
   * on, blocks the event loop, and cannot be driven in a test without stubbing
   * a global — which is why none of the four had a test.
   *
   * `ConfirmGateModal` + `useConfirmGate` are the replacement.
   */
  test('no window.confirm anywhere in web/src', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([, src]) => /\bwindow\.confirm\s*\(|(?<![.\w])confirm\s*\(/.test(stripComments(src)))
      .map(([file]) => file)
      .sort();
    expect(offenders, 'use useConfirmGate() — a native dialog ignores the theme').toEqual([]);
  });

  /**
   * U29, generalised. A typed gate's friction is *deliberate typing*, not
   * secrecy — naming the token in a `<label>` is correct, and every well-built
   * gate in this app does it. Echoing it in the `placeholder` is a different
   * thing: the answer ends up greyed out inside the field, under the caret,
   * where a glance cannot separate it from a real value.
   *
   * Two sites did this. Only one was filed; the raw-search gate over session
   * content was found by looking.
   *
   * The rule is mechanical: a `placeholder=` whose value is the same
   * identifier the file uses as its required token. It cannot catch a token
   * spelled as a literal in both places, which is why the two component tests
   * assert `placeholder === null` directly as well.
   */
  test('no confirmation input echoes its required token as a placeholder', () => {
    const offenders = Object.entries(SOURCES).flatMap(([file, src]) =>
      echoedTokens(stripComments(src)).map((t) => `${file}: placeholder={${t}}`),
    );
    expect(
      offenders,
      'name the token in a <label>, never inside the input the operator must type it into',
    ).toEqual([]);
  });

  // The detector is the load-bearing half of the rule above — if it matched
  // nothing, the rule would pass on a codebase full of the defect. Pin it
  // against the exact shape both real sites had, and against a placeholder
  // that is ordinary hint text, so it neither misses nor over-fires.
  test('the placeholder rule matches the shape the two real sites had', () => {
    expect(
      echoedTokens(
        [
          `const RAW_ACK_PHRASE = 'I understand';`,
          `<input value={x} placeholder={RAW_ACK_PHRASE} />`,
        ].join('\n'),
      ),
    ).toEqual(['RAW_ACK_PHRASE']);

    expect(
      echoedTokens([`const BULK_TOKEN = 'delete';`, 'const x = `${BULK_TOKEN}`;'].join('\n')),
    ).toEqual([]);

    expect(
      echoedTokens(
        [`const RAW_ACK_PHRASE = 'x';`, `<input placeholder="e.g. CI deploy" />`].join('\n'),
      ),
    ).toEqual([]);
  });
});
