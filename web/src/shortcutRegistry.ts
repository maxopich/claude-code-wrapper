/**
 * Cluster E Phase 4 (H1) — single source of truth for cross-cutting
 * keyboard shortcuts.
 *
 * The registry serves two roles:
 *   1. **Documentation surface** for `KeyboardShortcutsModal` (the
 *      `?`-opened cheatsheet). Adding a binding here auto-renders in
 *      the cheatsheet without modal edits.
 *   2. **Binding fixture** consumed by `useKeyboardShortcuts` when
 *      App.tsx wants to actively register a global handler for a
 *      specific shortcut (e.g. `?` itself, `Cmd/Ctrl+.` for Stop).
 *
 * **Not in the registry**: component-scoped bindings whose entire
 * lifecycle is owned by one component (e.g. `useModalKeys`'s Esc-to-
 * close, the GrowTextarea's Enter-to-submit, the ProjectList's session-
 * rename Enter/Esc). Those keep their local handlers AND get a
 * documentation row here (entries with `documentationOnly: true`)
 * so the cheatsheet stays comprehensive without duplicating logic.
 *
 * **Mac vs PC**: the spec is single-binding-per-shortcut, but the
 * macOS Command vs PC Ctrl convention is universal — we show "Cmd"
 * on Mac and "Ctrl" elsewhere in the cheatsheet (the keymatch is
 * `e.metaKey || e.ctrlKey` regardless). Section ordering is alpha
 * within the cheatsheet (sections sorted by name; rows within stable).
 */

/**
 * Cheatsheet section. The cheatsheet groups rows by `section`; new
 * sections appear automatically as registry entries grow.
 */
export type ShortcutSection =
  | 'Session'
  | 'Composer'
  | 'Notifications'
  | 'Authority'
  | 'Multi-agent'
  | 'Help';

/**
 * Shortcut descriptor. `keyMatch` returns true when the keydown
 * matches; `description` is the cheatsheet caption; `keyDisplay` is
 * the chip text rendered as `<kbd>`. The registry stores the
 * description + display + section regardless of whether the handler
 * is wired here or in a sibling component.
 */
export type ShortcutDescriptor = {
  /** Stable id for tests + dispatch tracking. */
  id: string;
  /** Cheatsheet section the row appears under. */
  section: ShortcutSection;
  /** Human-friendly key label(s) for the chip. e.g. ["?"], ["Cmd/Ctrl", "."] */
  keyDisplay: string[];
  /** One-line action description. */
  description: string;
  /**
   * Pure predicate over a KeyboardEvent. `useKeyboardShortcuts`
   * calls this when a global handler is wired; the cheatsheet
   * ignores it. Single-key shortcuts and `Cmd/Ctrl+X` are the
   * common cases.
   */
  keyMatch: (e: KeyboardEvent) => boolean;
  /**
   * True iff the registry row is for documentation only — the actual
   * handler lives in a sibling component (e.g. slash palette's `/`
   * trigger in InputBox, modal Esc dismissal in useModalKeys). The
   * cheatsheet still renders it so operators have one place to look.
   */
  documentationOnly: boolean;
  /**
   * Optional gating predicate. When provided, the global handler
   * (registered by useKeyboardShortcuts) is only dispatched if `when`
   * returns true. Lets the caller skip the binding while a higher-
   * precedence overlay (modal, palette) is on top.
   *
   * NOT applied to documentation-only rows — those have no handler
   * to gate.
   */
  when?: () => boolean;
};

/**
 * The v1 cross-cutting shortcuts surface (spec §5 H1 +
 * §7 ux-agent adoption notes). Cluster-specific bindings (notifications
 * dock, authority panel, multi-agent emergency-remove) ship in those
 * clusters' own slices; the rows are placeholders documented here so
 * the cheatsheet shape is stable from day one — flip
 * `documentationOnly: false` when the actual handler lands and add a
 * matching `useKeyboardShortcuts` registration in App.tsx.
 */
export const SHORTCUTS: ReadonlyArray<ShortcutDescriptor> = [
  // ----- Help -----
  {
    id: 'help.openCheatsheet.questionMark',
    section: 'Help',
    keyDisplay: ['?'],
    description: 'Open keyboard cheatsheet (when no input is focused)',
    keyMatch: (e) => e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey && !isInTextInput(e),
    documentationOnly: false,
  },
  {
    id: 'help.openCheatsheet.slash',
    section: 'Help',
    keyDisplay: ['Cmd/Ctrl', '/'],
    description: 'Toggle keyboard cheatsheet (works from inside inputs too)',
    // Cmd+/ OR Ctrl+/ — Mac vs PC convention; the cheatsheet binding
    // is the only shortcut that's allowed to fire from inside a
    // textarea/input, so the operator can summon docs without leaving
    // the composer.
    keyMatch: (e) => e.key === '/' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey,
    documentationOnly: false,
  },

  // ----- Session -----
  {
    id: 'session.stop.escape',
    section: 'Session',
    keyDisplay: ['Esc'],
    description: 'Stop the running turn (from inside the composer)',
    // Documentation only — the actual handler lives in InputBox.tsx
    // (composer-scoped, fires only when focus is in the composer wrap
    // and isRunning). The cheatsheet row reminds operators that this
    // shortcut exists.
    keyMatch: () => false,
    documentationOnly: true,
  },
  {
    id: 'session.stop.cmdPeriod',
    section: 'Session',
    keyDisplay: ['Cmd/Ctrl', '.'],
    description: 'Stop the running turn (alternative to Esc; works globally)',
    // macOS convention: Cmd+. = "cancel current operation". Wired as
    // a global handler in App.tsx so it works even when focus is
    // outside the composer. Per spec H1-7, this is the canonical
    // Stop binding when Esc precedence is unclear.
    keyMatch: (e) => e.key === '.' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey,
    documentationOnly: false,
  },
  {
    id: 'session.logs.cmdShiftL',
    section: 'Session',
    keyDisplay: ['Cmd/Ctrl', 'Shift', 'L'],
    description: 'Open the raw-event Logs inspector for the active session',
    // Cluster H C3 UI: keyboard parity for the single-agent LogsButton
    // mount. Global handler in App.tsx pushes the `#/session/:id/logs`
    // hash, which the existing LogsButton hashchange subscriber promotes
    // to an open modal. Works whether focus is in the composer or on
    // the page chrome. Letter keys arrive as `e.key === 'L'` (uppercase)
    // when Shift is held; match both cases for IME / OS-quirk safety.
    keyMatch: (e) =>
      (e.key === 'L' || e.key === 'l') && e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey,
    documentationOnly: false,
  },
  {
    id: 'session.search.cmdP',
    section: 'Session',
    keyDisplay: ['Cmd/Ctrl', 'P'],
    description: 'Search across all sessions by content (cross-session search)',
    // Cluster I C4 UI: opens the SessionSearchModal. Global handler in
    // App.tsx toggles it. We intentionally do NOT gate on isInTextInput —
    // a modifier shortcut should fire even while the composer is focused
    // (same as the OS Cmd+P it overrides). The hook calls preventDefault on
    // match, so the browser's native Print dialog never opens. Letter keys
    // arrive uppercase under Caps Lock; match both cases.
    keyMatch: (e) =>
      (e.key === 'p' || e.key === 'P') && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey,
    documentationOnly: false,
  },

  // ----- Composer -----
  {
    id: 'composer.send.cmdEnter',
    section: 'Composer',
    keyDisplay: ['Cmd/Ctrl', 'Enter'],
    description:
      'Send the current draft (Enter alone also sends; Cmd/Ctrl+Enter is the explicit alias)',
    // Documentation only — Enter-to-send lives in GrowTextarea. The
    // Cmd/Ctrl+Enter binding is the explicit alias muscle-memory from
    // other chat apps; GrowTextarea handles bare Enter, so we don't
    // need to add a second listener.
    keyMatch: () => false,
    documentationOnly: true,
  },
  {
    id: 'composer.palette.cmdK',
    section: 'Composer',
    keyDisplay: ['Cmd/Ctrl', 'K'],
    description: 'Open slash-command palette from any caret position',
    // Documentation only — the actual handler lives in InputBox.tsx
    // (Cluster E Phase 1 / E1). Component-scoped because the palette
    // anchors to the composer.
    keyMatch: () => false,
    documentationOnly: true,
  },
  {
    id: 'composer.palette.slash',
    section: 'Composer',
    keyDisplay: ['/'],
    description: 'Open slash-command palette (at cursor 0, empty composer only)',
    keyMatch: () => false,
    documentationOnly: true,
  },
  {
    id: 'composer.newline.shiftEnter',
    section: 'Composer',
    keyDisplay: ['Shift', 'Enter'],
    description: 'Insert a newline (without sending)',
    keyMatch: () => false,
    documentationOnly: true,
  },
];

/**
 * Heuristic: is the event target an input field where text typing
 * is expected? Used by the `?` cheatsheet trigger so that typing a
 * literal `?` in a textarea doesn't yank focus into the modal.
 *
 * Lifted to a top-level helper because multiple shortcuts may need
 * the same check; today only the bare `?` opener uses it.
 */
export function isInTextInput(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    // <input type="checkbox"> etc. don't accept text — the chip-toggle
    // case shouldn't block global `?`. Type-narrow to the text family.
    const type = (t as HTMLInputElement).type?.toLowerCase();
    return (
      type === 'text' ||
      type === 'search' ||
      type === 'email' ||
      type === 'url' ||
      type === 'password' ||
      type === 'number' ||
      type === undefined
    );
  }
  if (t.isContentEditable) return true;
  return false;
}
