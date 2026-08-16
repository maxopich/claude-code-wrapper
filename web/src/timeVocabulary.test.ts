import { describe, expect, test } from 'vitest';
import { stripComments } from './sourceScan';

/**
 * Relative time is rendered in exactly one place — register N14.
 *
 * WHAT WENT WRONG, so the gate's shape makes sense. Seven implementations of
 * "how long ago" existed across six files:
 *
 *   ProjectList.formatRelative          SessionSearchModal.formatRelative
 *   MultiAgentTab.formatAgo             MultiAgentTab.formatRelativeTime
 *   AuthExpiredBanner.formatRelativeMs  RecoveryLogInspector.formatRelativeMs
 *   AuthorityPanel — inline, no function at all
 *
 * They disagreed on all three axes the problem has. Three floored and three
 * rounded, so 90 seconds after an event the sidebar said `1m` while the
 * multi-agent tab said `2m ago` — same instant, same timestamp, one screen.
 * Sub-minute, three said `45s`, two said `just now`, one had no seconds band.
 * Three leaked negatives on clock skew; three clamped.
 *
 * Nothing anywhere claimed a reason for any of it. The one comment that DID
 * justify a copy — AuthExpiredBanner's "duplicated here so the banner remains
 * self-contained and the factory stays pure" — opened by saying it was the
 * same algorithm as MultiAgentTab's, which by then had two that disagreed with
 * each other.
 *
 * WHY THE RULE IS KEYED ON THE RENDERED LITERAL, not on function names. The
 * seventh site was `AuthorityPanel`'s inline `` `${slot.lastFetchedMode} ·
 * ${ageSec}s ago` `` — no function, no name, nothing for a name-based scan to
 * match. It is also the site nobody had counted, which is not a coincidence:
 * the version of this gate that would have been easier to write is exactly the
 * version that could not see the case that proves it necessary.
 *
 * So: the strings `' ago'` and `'just now'` may appear in `format.ts` and
 * nowhere else in the non-test client tree. A component that wants to render
 * relative time has to go through `timeAgo` / `timeAgoCompact` to say the word.
 *
 * COMMENTS ARE STRIPPED FIRST, via `stripComments` — the same narrowing
 * `operatorCopy.test.ts` and `vocabularyGate.test.ts` apply, for the reason
 * `ariaContracts.test.ts` records: a comment explaining a construct registers
 * as the construct. Measured here rather than assumed: `AuthorityContext.tsx`
 * and `muteStore.ts` both mention "ago" in prose, and a comment is not a
 * rendering.
 *
 * ANTI-VACUITY. Once the seven are gone this scan is at zero, and a scan of a
 * corrected tree passes whether or not it works — `project_gates_pass_vacuously`.
 * So the checker is fed the VERBATIM pre-correction lines as fixtures and must
 * flag them, and the corrected call sites as fixtures it must not.
 */

// Assembled from fragments so this file's own rules do not flag it, the way
// `vocabularyGate.test.ts` builds its needles. Load-bearing, not decorative:
// the match is a substring test, so the joined words would be found verbatim.
const AGO = ` ${'a'}go`;
const JUST_NOW = `just ${'n'}ow`;

/**
 * Each banned word must be matched WHERE A STRING ENDS — followed by a
 * backtick, apostrophe or double quote.
 *
 * A bare `' ago'` was the first draft and it over-fired immediately, on
 * `MultiAgentTab`'s own corrected call site: `const agoText = timeAgo(…)`
 * contains space-a-g-o. Caught by the `"ago" inside a larger word` control
 * below, not by review — which is the argument for writing the over-fire
 * controls before trusting the predicate. Every real rendering terminates a
 * string literal, so requiring the terminator costs nothing and excludes every
 * identifier that merely ends in those letters.
 */
const QUOTES = ['`', "'", '"'] as const;
const terminated = (word: string): string[] => QUOTES.map((q) => `${word}${q}`);

/** The one module allowed to say either word. */
const HOME = './format.ts';

/**
 * Files exempt from the scan, written out as a list rather than expressed as a
 * predicate — and asserted below to be exactly this list.
 *
 * The revert-check is why. An empty `hits` array is this gate's PASS condition,
 * so any bug that empties it is invisible: replacing the exemption filter with
 * one that discarded every file left all the tree scans green. A predicate
 * cannot be checked against itself; a list can. Same lesson as
 * `project_gates_pass_vacuously` — an assertion that loops a list cannot catch
 * the list being wrong, so write the names out.
 */
const EXEMPT: readonly string[] = [HOME];

/**
 * Extracted rather than written inline in the scan below, so it can be fed
 * inputs. A predicate living inside the assertion it guards is only checkable
 * against itself: the revert-check replaced the inline filter with one that
 * discarded every file, and every scan stayed green while examining nothing.
 *
 * Honest limit, stated because a silent one is how a gate rots: this makes the
 * PREDICATE checkable, not the call site. Someone who rewrites the `.filter(…)`
 * expression itself rather than this function is still outside what these tests
 * can see. The pairing that narrows it is the `home module does render the
 * vocabulary` case below — a scan that has stopped finding anything fails there.
 */
function isExempt(file: string): boolean {
  return EXEMPT.includes(file);
}

const BANNED: ReadonlyArray<readonly [readonly string[], string]> = [
  [terminated(AGO), '" ago"'],
  [terminated(JUST_NOW), '"just now"'],
];

/** Every non-test source in the client tree, as literal text. */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob(['./**/*.ts', './**/*.tsx'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).filter(([file]) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx')),
);

/**
 * Files whose code — comments removed — contains `needle`.
 *
 * Takes its sources as an argument rather than closing over `SOURCES`, so the
 * rule can be exercised on inputs that actually contain the banned strings.
 * The real tree contains none once N14 lands, so scanning it proves only that
 * the tree is clean, never that the gate would notice if it were not.
 */
function filesRendering(sources: Record<string, string>, needles: readonly string[]): string[] {
  const hits: string[] = [];
  for (const [name, content] of Object.entries(sources)) {
    const code = stripComments(content);
    if (needles.some((n) => code.includes(n))) hits.push(name);
  }
  return hits.sort();
}

describe('relative time is rendered in one place — the client tree', () => {
  for (const [needles, label] of BANNED) {
    test(`${label} appears only in ${HOME}`, () => {
      const hits = filesRendering(SOURCES, needles).filter((f) => !isExempt(f));
      expect(
        hits,
        `${label} is rendered outside ${HOME}, in: ${hits.join(', ') || '(none)'}. ` +
          'Relative time has one implementation — `timeAgo` for prose ' +
          '("3m ago"), `timeAgoCompact` for dense rows ("3m"). Seven local ' +
          'copies disagreed on rounding, on the seconds band, and on clock ' +
          'skew (register N14); a new one would too.',
      ).toEqual([]);
    });
  }

  test('exactly one file is exempt, and it is format.ts', () => {
    // Written out rather than looped: an assertion that iterates EXEMPT cannot
    // catch EXEMPT being the wrong list.
    expect(EXEMPT).toEqual(['./format.ts']);
  });

  test('isExempt exempts the home module and nothing else', () => {
    // Both directions. An empty `hits` array is this gate's PASS condition, so
    // a predicate that exempted everything would leave every scan green while
    // checking nothing — measured in the revert-check, not hypothesised.
    expect(isExempt(HOME)).toBe(true);
    for (const f of [
      './components/MultiAgentTab.tsx',
      './components/authority/AuthorityPanel.tsx',
      './components/banners/AuthExpiredBanner.tsx',
    ]) {
      expect(isExempt(f), `${f} must not be exempt`).toBe(false);
    }
  });

  test('the home module does render the vocabulary, so the rule has a subject', () => {
    // Guards the other direction: if `format.ts` stopped saying " ago" the
    // scans above would pass on a tree where nothing renders relative time at
    // all, and the exemption would be protecting an empty file.
    expect(filesRendering(SOURCES, terminated(AGO))).toContain(HOME);
  });

  test('the glob reaches the whole tree, not a hand-picked corner', () => {
    // A scan that matches nothing looks exactly like one that works.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(120);
  });

  test('it reaches every file this rule took a formatter out of', () => {
    // Named, not counted: a count cannot catch the set being the wrong set.
    // These six held the seven implementations.
    for (const f of [
      './components/ProjectList.tsx',
      './components/SessionSearchModal.tsx',
      './components/MultiAgentTab.tsx',
      './components/banners/AuthExpiredBanner.tsx',
      './components/recoveryLog/RecoveryLogInspector.tsx',
      './components/authority/AuthorityPanel.tsx',
    ]) {
      expect(Object.keys(SOURCES), `${f} is not in the scanned set`).toContain(f);
    }
  });

  test('specs are excluded from the scan', () => {
    // Tests assert on rendered output (`expect(text).toContain('30s ago')`),
    // so scanning them would report every one of those as a violation.
    expect(Object.keys(SOURCES).filter((f) => f.includes('.test.'))).toEqual([]);
  });
});

/**
 * The rule itself, on sources that DO contain the banned strings.
 *
 * The tree is clean after N14, so nothing above can distinguish a working gate
 * from one that never matches.
 */
describe('relative time is rendered in one place — the rule, on synthetic sources', () => {
  test('catches a local formatter returning a template literal', () => {
    // Verbatim from `MultiAgentTab.tsx` before N14.
    const src = 'function formatRelativeTime(ts: number) {\n  return `${sec}s' + AGO + '`;\n}';
    expect(filesRendering({ 'a.tsx': src }, terminated(AGO))).toEqual(['a.tsx']);
  });

  test('catches the inline form, which a name-based rule would miss', () => {
    // Verbatim from `AuthorityPanel.tsx` before N14 — no function to name.
    const src = 'return `${slot.lastFetchedMode} · ${ageSec}s' + AGO + '`;';
    expect(filesRendering({ 'b.tsx': src }, terminated(AGO))).toEqual(['b.tsx']);
    // And the case for the rule's shape: a scan keyed on a `format*`
    // declaration finds nothing here, because there is no declaration.
    expect(/function\s+format[A-Z]/.test(src)).toBe(false);
  });

  test('catches the sub-minute literal', () => {
    const src = `if (min < 1) return '${JUST_NOW}';`;
    expect(filesRendering({ 'c.tsx': src }, terminated(JUST_NOW))).toEqual(['c.tsx']);
  });

  test('reports every offending file, not just the first', () => {
    // A checker that stopped at the first hit would let one copy be fixed per
    // CI round and look green in between — which is how seven accumulated.
    const src = 'return `${d}d' + AGO + '`;';
    expect(
      filesRendering({ 'd.tsx': src, 'e.tsx': src, 'f.tsx': 'const ok = 1;' }, terminated(AGO)),
    ).toEqual(['d.tsx', 'e.tsx']);
  });

  // ---- controls: each way the rule could over-fire ----

  test('CONTROL: a call site that renders through the helper is not flagged', () => {
    // The corrected form. If the rule were keyed on the concept rather than
    // the literal it would flag this, and the fix would be unshippable.
    const src = "import { timeAgo } from '../format';\nconst t = timeAgo(row.ts);";
    for (const [needles] of BANNED) expect(filesRendering({ 'g.tsx': src }, needles)).toEqual([]);
  });

  test('CONTROL: the words inside comments are tolerated', () => {
    // Measured, not hypothetical: `AuthorityContext.tsx` says "Live probe N
    // seconds ago" and `muteStore.ts` says `render "muted 2h ago"`, both in
    // prose, both of which this gate must leave alone.
    const src = [
      `/* the manage-mutes UI renders "muted 2h${AGO}" */`,
      `// ("Cached from last session" vs "Live probe N seconds${AGO}").`,
      `// under a minute this used to say '${JUST_NOW}'`,
      'const t = timeAgo(row.ts);',
    ].join('\n');
    for (const [needles] of BANNED) expect(filesRendering({ 'h.tsx': src }, needles)).toEqual([]);
  });

  test('...but the same words OUTSIDE a comment in that file still are', () => {
    // The other half of the narrowing. Without it, "comments are tolerated"
    // would also pass against a gate that had stopped matching anything.
    const src = [
      `/* renamed by N14: this used to say "muted 2h${AGO}" */`,
      'return `${hr}h' + AGO + '`;',
    ].join('\n');
    expect(filesRendering({ 'i.tsx': src }, terminated(AGO))).toEqual(['i.tsx']);
  });

  test('CONTROL: "ago" inside a larger word is not a rendering', () => {
    // The needle carries its leading space for this reason. Without it,
    // any identifier ending in those three letters would trip the gate.
    const src = 'const agoText = timeAgo(ts);\nconst lagoon = 1;';
    expect(filesRendering({ 'j.tsx': src }, terminated(AGO))).toEqual([]);
  });
});
