import { describe, expect, test } from 'vitest';
import { stripComments } from './sourceScan';

/**
 * Vocabulary CI gate (PR-1, widened by register C23).
 *
 * The four-agent consultation flagged that Cebab's user-facing copy was mixing
 * "hop cap" / "max iterations" / "estimated cost" / "est $" — none of which are
 * accurate names for what the bus actually does (the term is **hop budget**,
 * the runtime is `hopBudget`, and there is no cost projection surface). These
 * strings appear nowhere today; this gate pins their absence so a future PR
 * cannot silently regress.
 *
 * C23 — WHY THE FILE LIST IS GONE. This scanned six hand-listed sources, under
 * a header instructing the next author to "add more files here if you grow the
 * surface". Nobody executes that instruction, so any new component with the
 * banned copy was simply not scanned and the gate passed anyway: false
 * assurance that a repo-wide rule was enforced repo-wide. It covered 6 of 143
 * non-test sources. It now globs the tree, the way `operatorCopy.test.ts`,
 * `ariaContracts.test.ts`, `clipboardConvergence.test.ts`, `widgetRoles.test.ts`
 * and four other web gates already do.
 *
 * The widening found nothing — zero hits across all 143 files, for all six
 * terms, before and after. That is expected (this gate has always been at zero)
 * and it is why every rule assertion below runs against SYNTHETIC sources: with
 * no live example, a test that only scans the real tree cannot tell a working
 * gate from a broken one. The real tree is covered by the COUNT assertions
 * instead — a glob that matches nothing looks exactly like a glob that works.
 *
 * `.ts` as well as `.tsx`: operator-facing copy is not only JSX.
 * `notifyFromServerMsg.ts` builds notification text, and `slashCommands.ts` and
 * `theme.ts` carry label strings.
 *
 * Comments are stripped first, which is a NARROWING and deliberate. The gate is
 * about user-facing copy, and a comment is not user-facing — while a comment
 * saying "this used to be called max iterations" is the single most likely
 * future false positive for a gate whose whole subject is renamed vocabulary.
 * `ariaContracts.test.ts` records the same trap biting for real: a comment
 * explaining a removed construct kept `widgetRoles.test.ts` red while it was
 * being written.
 */

// Build the literals out of fragments so this file does not trip the gate on
// its own contents. That is load-bearing, not decorative: the match below is a
// lowercase SUBSTRING test, so the assembled words would be found verbatim.
// (A previous version of this comment claimed the patterns were word-boundary
// regexes and the fragments were merely defensive. They never were.)
const HOP_CAP = `hop${' '}cap`;
const MAX_ITER = `max${' '}iteration`;
const ESTIMATED_COST = `estimated${' '}cost`;
const PER_TURN = `$${'/'}turn`;
const EST_DOLLAR_SHORT = `est${' '}$`;
const EST_COST_SHORT = `est${' '}cost`;

const BANNED: ReadonlyArray<readonly [string, string]> = [
  [HOP_CAP, '"hop cap"'],
  [MAX_ITER, '"max iteration(s)"'],
  [ESTIMATED_COST, '"estimated cost"'],
  [PER_TURN, '"$/turn"'],
  [EST_DOLLAR_SHORT, '"est $"'],
  [EST_COST_SHORT, '"est cost"'],
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
 * Files containing `needle` outside of comments.
 *
 * Takes its sources as an argument rather than closing over `SOURCES` so the
 * rule can be exercised on inputs that actually contain the banned copy. The
 * real tree contains none, so scanning it proves only that the tree is clean —
 * never that the gate would notice if it were not.
 */
function filesContaining(sources: Record<string, string>, needle: string): string[] {
  const hits: string[] = [];
  for (const [name, content] of Object.entries(sources)) {
    if (stripComments(content).toLowerCase().includes(needle.toLowerCase())) hits.push(name);
  }
  return hits.sort();
}

describe('vocabulary gate — the client tree', () => {
  for (const [needle, label] of BANNED) {
    test(`${label} appears in zero scanned source files`, () => {
      const hits = filesContaining(SOURCES, needle);
      expect(
        hits,
        `expected zero hits for ${label}; found in: ${hits.join(', ') || '(none)'}`,
      ).toEqual([]);
    });
  }

  /**
   * C23's own gate. Every assertion above is "found nothing", which an empty
   * source map satisfies for free — so the scan's REACH is asserted separately
   * from its verdict. Reverting the glob to the old six-file list fails here
   * and nowhere else.
   */
  test('the glob reaches the whole tree, not a hand-picked corner', () => {
    // The old hand list was 6. The tree is ~143 non-test sources and only ever
    // grows; a floor well above the list but below today's count survives
    // ordinary churn while still catching a collapse back to a handful.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(120);
  });

  test('the scan includes .ts, not only .tsx', () => {
    // Dropping './**/*.ts' from the glob still passes the count above on the
    // ~100 .tsx files alone, so the file-type coverage needs its own assertion.
    const tsOnly = Object.keys(SOURCES).filter((f) => f.endsWith('.ts'));
    expect(tsOnly.length).toBeGreaterThan(20);
    expect(Object.keys(SOURCES)).toContain('./components/notifications/notifyFromServerMsg.ts');
  });

  test('it reaches files the old six-file list never covered', () => {
    // Named rather than counted: a count cannot catch the list being the wrong
    // list. None of these was scanned before C23.
    for (const f of [
      './components/InputBox.tsx',
      './components/sessionLog/LogsModal.tsx',
      './components/authRefresh/AuthRefreshModal.tsx',
      './slashCommands.ts',
    ]) {
      expect(Object.keys(SOURCES), `${f} is not in the scanned set`).toContain(f);
    }
  });

  test('specs are excluded from the scan', () => {
    // Otherwise this file's own fragments — and every spec quoting the banned
    // copy to test against it — would be reported as violations.
    expect(Object.keys(SOURCES).filter((f) => f.includes('.test.'))).toEqual([]);
  });
});

/**
 * The rule itself, on sources that DO contain the banned copy.
 *
 * The tree is clean, so nothing above can distinguish a working gate from one
 * that never matches. These feed `filesContaining` directly.
 */
describe('vocabulary gate — the rule, on synthetic sources', () => {
  test('catches banned copy in JSX text', () => {
    const src = `export const X = () => <p>The ${HOP_CAP} for this run is 40.</p>;`;
    expect(filesContaining({ 'a.tsx': src }, HOP_CAP)).toEqual(['a.tsx']);
  });

  test('catches banned copy in an attribute, which JSX-text scanning would miss', () => {
    const src = `export const X = () => <button title="${ESTIMATED_COST}: $0.40">Go</button>;`;
    expect(filesContaining({ 'b.tsx': src }, ESTIMATED_COST)).toEqual(['b.tsx']);
  });

  test('catches banned copy in a plain .ts string constant', () => {
    const src = `export const LABEL = 'Set the ${MAX_ITER} limit';`;
    expect(filesContaining({ 'c.ts': src }, MAX_ITER)).toEqual(['c.ts']);
  });

  test('catches it regardless of case', () => {
    const src = `export const L = '${HOP_CAP.toUpperCase()}';`;
    expect(filesContaining({ 'd.ts': src }, HOP_CAP)).toEqual(['d.ts']);
  });

  test('reports every offending file, not just the first', () => {
    const src = `const s = '${PER_TURN}';`;
    expect(
      filesContaining({ 'e.ts': src, 'f.ts': src, 'g.ts': 'const ok = 1;' }, PER_TURN),
    ).toEqual(['e.ts', 'f.ts']);
  });

  // ---- controls: each way the rule could over-fire ----

  test('CONTROL: a clean file is not flagged', () => {
    const src = `export const X = () => <p>Nothing to see.</p>;`;
    for (const [needle] of BANNED) expect(filesContaining({ 'h.tsx': src }, needle)).toEqual([]);
  });

  test('CONTROL: the CORRECT vocabulary does not trip the rule', () => {
    // "hop budget" is the term this gate exists to protect. If the banned
    // needle were loosened to "hop", this is the case that would catch it.
    const src = `export const X = () => <p>Hop budget: 40 hops remaining.</p>;`;
    for (const [needle] of BANNED) expect(filesContaining({ 'i.tsx': src }, needle)).toEqual([]);
  });

  test('CONTROL: banned copy inside comments is tolerated', () => {
    const src = [
      `/* Renamed in PR-1: this used to say ${MAX_ITER}s. */`,
      `// ${ESTIMATED_COST} was never a real surface.`,
      `export const X = () => <p>Hop budget: 40.</p>;`,
    ].join('\n');
    expect(filesContaining({ 'j.tsx': src }, MAX_ITER)).toEqual([]);
    expect(filesContaining({ 'j.tsx': src }, ESTIMATED_COST)).toEqual([]);
  });

  test('...but the same term OUTSIDE a comment in that file still is', () => {
    // The other half of the narrowing. Without this, "comments are tolerated"
    // would also pass against a gate that had stopped matching anything.
    const src = [
      `/* Renamed in PR-1: this used to say ${MAX_ITER}s. */`,
      `export const X = () => <p>${MAX_ITER}s: 40</p>;`,
    ].join('\n');
    expect(filesContaining({ 'k.tsx': src }, MAX_ITER)).toEqual(['k.tsx']);
  });
});
