/**
 * Where an arrow key moves you in a list of things.
 *
 * Five surfaces in this app declare a composite ARIA role — `menu`, `grid`,
 * `listbox`, `radiogroup` — and every one of those roles obliges arrow-key
 * movement. Three of them already implemented it, each with its own policy:
 * `SlashCommandPalette` wraps at the ends, `SessionSearchModal` clamps,
 * `ToolsList` clamps and adds Home/End. Adding two more hand-rolled variants
 * would have made five.
 *
 * So the movement rule lives here as a pure function with one test file,
 * the same shape as `drawerState.ts` / `theme.ts` / `shortcutRegistry.ts`.
 * The DOM half — which element to call `.focus()` on — stays with the
 * caller, because that differs per widget (a menu focuses items, a grid
 * focuses rows, a combobox focuses nothing and points `aria-activedescendant`
 * instead).
 *
 * Policies come from the APG pattern each caller claims, not from taste:
 * menus and radio groups wrap, listboxes and grids clamp.
 */

/** Which arrow keys count as "forward" and "back" for this widget. */
export type Orientation = 'vertical' | 'horizontal' | 'both';

export type ListNavOptions = {
  /** `KeyboardEvent.key`, passed through verbatim. */
  key: string;
  /** Currently active index. May be `-1` for "nothing active yet". */
  current: number;
  /** Number of items. Zero means there is nowhere to go. */
  count: number;
  /** Wrap past the ends instead of stopping at them. Default `false`. */
  wrap?: boolean;
  /** Default `'vertical'` — only ArrowUp/ArrowDown move. */
  orientation?: Orientation;
  /**
   * Whether Home/End jump to the ends. Default `true`.
   *
   * Pass `false` when the handler is bound to a **text input** — a combobox's
   * search field owns Home/End for caret movement, and APG puts them with the
   * textbox rather than the popup. Claiming them for the list means the
   * caller's `preventDefault()` also stops the caret from moving, which is
   * how `SessionSearchModal` silently lost "jump to start of query" when it
   * adopted this helper.
   */
  homeEnd?: boolean;
};

/**
 * The index this key should move to, or `null` when the key is not a
 * navigation key for this widget (or the list is empty).
 *
 * `null` is the signal NOT to call `preventDefault()`: a caller that swallows
 * every keystroke breaks typing, Tab, and Escape. Returning the *current*
 * index for an unhandled key would look the same to the index but would tell
 * the caller nothing, which is why this is nullable rather than clamped.
 */
export function nextIndex(o: ListNavOptions): number | null {
  const { key, current, count } = o;
  if (count <= 0) return null;
  const wrap = o.wrap ?? false;
  const orientation = o.orientation ?? 'vertical';
  const last = count - 1;

  if (o.homeEnd ?? true) {
    if (key === 'Home') return 0;
    if (key === 'End') return last;
  }

  const forward =
    (key === 'ArrowDown' && orientation !== 'horizontal') ||
    (key === 'ArrowRight' && orientation !== 'vertical');
  const back =
    (key === 'ArrowUp' && orientation !== 'horizontal') ||
    (key === 'ArrowLeft' && orientation !== 'vertical');
  if (!forward && !back) return null;

  // `current` is allowed to be out of range: -1 means "nothing active", and a
  // list that shrank under a stale index shouldn't throw. Both land somewhere
  // sensible — forward from -1 is 0, back from -1 is the last item when
  // wrapping and 0 when not.
  if (forward) {
    if (current >= last) return wrap ? 0 : last;
    return current < 0 ? 0 : current + 1;
  }
  if (current <= 0) return wrap ? last : 0;
  return current > last ? last : current - 1;
}
