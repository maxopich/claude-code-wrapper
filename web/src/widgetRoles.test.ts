import { describe, expect, test } from 'vitest';

/**
 * A composite ARIA role is a promise about the keyboard (registers U17, U18,
 * U26, U30).
 *
 * `menu`, `listbox`, `grid`, `radiogroup` and friends are not labels — each one
 * tells assistive tech "this is a single widget; arrow keys move inside it,
 * Tab leaves it". Declare one without implementing that and you have made the
 * component *worse* than a plain list: the operator is told a model exists,
 * switches their screen reader into it, and finds nothing responds.
 *
 * Four of the five composite roles in this app were in exactly that state —
 * the participant menu (no focus-in, no arrows, no restore), the artifacts
 * table (`aria-selected` under a `role="table"` that has no selection model,
 * plus one tab stop per row), the search combobox (an index nobody was told
 * about), and the theme picker (four tab stops where a radio group promises
 * one). The fifth, `SlashCommandPalette`, was already correct and is what the
 * others were made to look like.
 *
 * So this gate holds the RULE rather than those five components: any file that
 * declares a composite role must also contain a keyboard model — either the
 * shared `nextIndex(` helper (roving focus) or `aria-activedescendant` (the
 * combobox form, where focus stays put and the active option is named).
 *
 * What it deliberately does NOT check: that the keyboard model is *correct*
 * (that is `widgetKeyboard.test.tsx`, which drives real DOM), or roles like
 * `list` / `region` / `dialog` that promise no arrow-key behaviour at all.
 * `ToolsList` sets `aria-activedescendant` on a `role="list"`, which is its own
 * (filed) bug — `list` is not in the set below, so this gate neither fails on
 * it nor launders it as an exemption.
 */

// Vite's ?raw + glob: every component source as literal text, test files
// dropped so a JSX fixture inside a spec can't register as a declaration.
const SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob('./components/**/*.tsx', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).filter(([file]) => !file.endsWith('.test.tsx')),
);

/**
 * Roles whose ARIA definition obliges arrow-key navigation within the widget.
 * Container roles only — the CHILD roles (`option`, `menuitem`, `radio`, `row`)
 * are not listed, because a child can legitimately appear in a file that does
 * not own the keyboard handling for its container.
 */
const COMPOSITE_ROLES = [
  'menu',
  'menubar',
  'listbox',
  'grid',
  'treegrid',
  'tree',
  'radiogroup',
  'tablist',
  'combobox',
  'toolbar',
];

/** The two acceptable answers, both already used in this codebase. */
const KEYBOARD_MODELS = ['nextIndex(', 'aria-activedescendant'];

/**
 * Files that may declare a composite role with no keyboard model, each with a
 * reason. **Empty, and asserted empty below.** Adding an entry is punching a
 * hole in the gate and has to be argued for in review — which is the point: the
 * theme picker was fixed in the same PR precisely so this list could ship
 * empty rather than starting life with a known-broken component inside it.
 */
const EXEMPT: Array<{ file: string; why: string }> = [];

/**
 * Source with its prose removed: block comments (including the braced JSX
 * form) and whole-line `//` comments.
 *
 * Both directions matter. A comment EXPLAINING a role that was removed would
 * otherwise be reported as a live declaration — which is exactly what happened
 * while writing this file, when a note saying why `LogToolbar` dropped its role
 * kept the gate red. And a comment MENTIONING `nextIndex(` would otherwise
 * launder a component that never calls it.
 *
 * Only whole-line `//` comments are stripped, never a trailing one: `//` also
 * appears inside string literals (`https://…`), and truncating a code line at
 * the first slash pair could silently delete a real declaration further along
 * it. Prose lives on its own lines here anyway.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('/*', i);
    if (open === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, open);
    const close = src.indexOf('*/', open + 2);
    if (close === -1) break; // unterminated block: drop the rest
    i = close + 2;
  }
  return out
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/** Every composite role literally declared in this source. */
function declaredRoles(src: string): string[] {
  const code = stripComments(src);
  const found: string[] = [];
  for (const role of COMPOSITE_ROLES) {
    // Matches `role="menu"` exactly — the quotes stop `menu` from also
    // matching inside `menubar` or `menuitem`.
    if (code.includes(`role="${role}"`)) found.push(role);
  }
  return found;
}

function hasKeyboardModel(src: string): boolean {
  const code = stripComments(src);
  return KEYBOARD_MODELS.some((marker) => code.includes(marker));
}

const DECLARING = Object.entries(SOURCES)
  .map(([file, src]) => ({ file, roles: declaredRoles(src), src }))
  .filter((f) => f.roles.length > 0);

describe('[a11y] a composite role comes with a keyboard model', () => {
  test('the scan found real declarations', () => {
    // Anti-vacuity: a broken glob or a mistyped role literal empties DECLARING
    // and every case below passes over nothing. Both counts only grow — a drop
    // means this gate stopped seeing components, not that the roles went away.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
    expect(DECLARING.length).toBeGreaterThanOrEqual(5);
    expect(DECLARING.flatMap((f) => f.roles).length).toBeGreaterThanOrEqual(6);
  });

  test('the matcher actually rejects something', () => {
    // The guard above proves the scan found files; this proves the PREDICATE
    // can fail. Without it a `hasKeyboardModel` that always returned true
    // would sail through every assertion in this file — the shape of bug that
    // reached CI once already (see project_gates_pass_vacuously).
    const broken = '<div role="menu" aria-label="x">\n  <button role="menuitem">a</button>\n</div>';
    expect(declaredRoles(broken)).toEqual(['menu']);
    expect(hasKeyboardModel(broken)).toBe(false);
    // ...and the positive control, so a matcher that always returns false
    // (which would make the line above pass too) is caught as well.
    expect(hasKeyboardModel(`${broken}\nconst i = nextIndex({ key, current, count });`)).toBe(true);
  });

  test('prose cannot create or launder a declaration', () => {
    // A comment saying a role was REMOVED must not read as a declaration...
    expect(declaredRoles('// this used to be role="menu"\n<div className="x" />')).toEqual([]);
    expect(declaredRoles('{/* was role="grid" once */}\n<table />')).toEqual([]);
    // ...and a comment MENTIONING the helper must not stand in for calling it.
    const laundered = '// TODO: wire nextIndex( here\n<div role="menu" />';
    expect(declaredRoles(laundered)).toEqual(['menu']);
    expect(hasKeyboardModel(laundered)).toBe(false);
  });

  test.each(DECLARING.map((f) => [`${f.file} (${f.roles.join(', ')})`, f] as const))(
    '%s implements arrow keys or names an active descendant',
    (_label, f) => {
      if (EXEMPT.some((e) => e.file === f.file)) return;
      expect(hasKeyboardModel(f.src)).toBe(true);
    },
  );

  test('the exemption list is empty', () => {
    expect(EXEMPT).toEqual([]);
  });
});

describe('[a11y] the five widgets are all still here', () => {
  // Not a substitute for the discovery above — a belt on top of it. If a
  // component is renamed or its role is dropped, that is a decision someone
  // should make on purpose, not something that quietly shrinks this gate's
  // coverage to nothing while it keeps reporting green.
  const EXPECTED: Array<[string, string]> = [
    ['./components/agentControl/ParticipantControlMenu.tsx', 'menu'],
    ['./components/ArtifactsView.tsx', 'grid'],
    ['./components/SessionSearchModal.tsx', 'combobox'],
    ['./components/SessionSearchModal.tsx', 'listbox'],
    ['./components/SlashCommandPalette.tsx', 'listbox'],
    ['./components/SettingsModal.tsx', 'radiogroup'],
  ];

  test.each(EXPECTED)('%s still declares role="%s"', (file, role) => {
    expect(SOURCES[file], `source not found: ${file}`).toBeDefined();
    expect(declaredRoles(SOURCES[file]!)).toContain(role);
  });
});
