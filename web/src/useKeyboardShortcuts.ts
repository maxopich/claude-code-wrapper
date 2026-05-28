import { useEffect, useRef } from 'react';
import type { ShortcutDescriptor } from './shortcutRegistry';

/**
 * Cluster E Phase 4 (H1) — bind a set of `ShortcutDescriptor`s to
 * `document.keydown` for the duration of the host component's life.
 *
 * Pattern:
 *   useKeyboardShortcuts({
 *     [SHORTCUTS.helpOpenCheatsheetQuestionMark.id]: () => setOpen(true),
 *     [SHORTCUTS.helpOpenCheatsheetSlash.id]: () => setOpen((cur) => !cur),
 *     [SHORTCUTS.sessionStopCmdPeriod.id]: () => onStop(),
 *   });
 *
 * Or — more typically — pass an array of (descriptor, handler) tuples
 * so the binding chooses which subset of the registry it actually wires:
 *
 *   useKeyboardShortcuts([
 *     [findShortcut('help.openCheatsheet.questionMark'), () => setOpen(true)],
 *     [findShortcut('session.stop.cmdPeriod'), () => onStop()],
 *   ]);
 *
 * The hook handles:
 *   - Single document-level listener regardless of how many shortcuts
 *     are registered.
 *   - `documentationOnly` rows are skipped (their handler lives
 *     elsewhere; registering would double-fire).
 *   - The descriptor's `when` predicate gates dispatch — useful for
 *     "only when no modal is open" or "only when there's a live
 *     session to stop."
 *   - Handler refs are mirrored in a ref so identity changes don't
 *     resubscribe the listener.
 *
 * Why a single hook instead of one document.addEventListener per
 * caller: keeping all global bindings inside one listener gives us a
 * deterministic ordering at the keydown level (registry order = wire
 * order) and a single place to add the spec's Esc precedence policy
 * (palette > modal > banner > stop) when those higher-precedence
 * overlays land.
 */

export type ShortcutBinding = readonly [ShortcutDescriptor, () => void];

export function useKeyboardShortcuts(bindings: ReadonlyArray<ShortcutBinding>): void {
  // Mirror the bindings list in a ref so the document listener — which
  // we attach once — always sees the freshest closures. Identity-
  // changing handlers (the common case when a parent re-renders with
  // a new arrow function) don't re-bind the listener.
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      for (const [descriptor, handler] of ref.current) {
        if (descriptor.documentationOnly) continue;
        if (!descriptor.keyMatch(e)) continue;
        if (descriptor.when && !descriptor.when()) continue;
        // Stop default browser behaviour (e.g. Cmd+/ might open the
        // browser's find-in-page on some platforms) AND stop further
        // matches in the same registry tick — first descriptor wins.
        e.preventDefault();
        handler();
        return;
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

/**
 * Lookup helper used at binding sites to thread the descriptor by id
 * without grovelling through the registry array. Throws when the id
 * isn't known — a registry typo at binding time should fail loud at
 * mount, not silently no-op.
 */
export function findShortcut(
  registry: ReadonlyArray<ShortcutDescriptor>,
  id: string,
): ShortcutDescriptor {
  const hit = registry.find((s) => s.id === id);
  if (!hit) {
    throw new Error(
      `useKeyboardShortcuts: unknown shortcut id "${id}". Did you add it to shortcutRegistry.ts?`,
    );
  }
  return hit;
}
