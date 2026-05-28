import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildSdkSlashCommands,
  filterSlashCommands,
  SLASH_COMMANDS,
  type SlashCommand,
} from '../slashCommands';

/**
 * Cluster E Phase 1 (E1) — discovery palette for slash commands.
 *
 * Triggered by:
 *   - `/` keypress in the composer when the caret is at position 0 AND
 *     the textarea is empty (the `/` keypress itself is suppressed by
 *     `InputBox` so it doesn't land in the textarea).
 *   - `Cmd/Ctrl+K` from any caret position.
 *
 * The palette is a popover anchored above the composer (input is
 * bottom-pinned). It owns its own filter input so both trigger paths
 * work identically — `/` and `Cmd+K` open the palette with an empty
 * filter, the operator types to narrow, picks a command with
 * Enter/click, and on select the InputBox replaces the textarea with
 * `<command>` + space (no auto-send; operator decides when to Send).
 *
 * Two source groups render distinctly:
 *   - **Cebab quick commands** — the 5 hard-coded vocabulary items also
 *     surfaced as quick-row buttons (`SlashCommandButtons`).
 *   - **Discovered from session** — anything in
 *     `session_started.slashCommands[]` (Cluster B Phase 2 forwards
 *     this on every init), de-duped against the Cebab list.
 *
 * Keyboard contract (inside the filter input):
 *   - ArrowUp / ArrowDown move highlight; wraps at boundaries.
 *   - Enter activates the highlighted row → `onSelect(command)`.
 *   - Esc → `onClose()`.
 *
 * Mouse contract:
 *   - Click a row → activate. The InputBox owns click-outside →
 *     onClose.
 *
 * Accessibility: `role="listbox"`, each row `role="option"`. The
 * filter input carries `aria-activedescendant` pointing at the
 * highlighted row's id. Whole popover carries
 * `aria-label="Slash command palette"`.
 */

export type SlashCommandPaletteProps = {
  /** SDK-discovered command names from `session_started.slashCommands[]`. */
  sdkCommands?: readonly string[];
  /** Invoked when the operator picks a command. */
  onSelect: (command: string) => void;
  /** Invoked when the operator cancels (Esc, click-outside via parent). */
  onClose: () => void;
};

export function SlashCommandPalette({
  sdkCommands,
  onSelect,
  onClose,
}: SlashCommandPaletteProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus the filter input on mount — both trigger paths (`/` + Cmd+K)
  // expect the operator's next keypress to filter, not land in the
  // composer textarea behind.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Build sectioned, filtered lists. Memoized on query + sdkCommands.
  const sections = useMemo(() => {
    const cebab = filterSlashCommands(
      SLASH_COMMANDS.filter((c) => c.source === 'cebab'),
      query,
    );
    const sdk = filterSlashCommands(buildSdkSlashCommands(sdkCommands), query);
    return { cebab, sdk };
  }, [query, sdkCommands]);

  // Flat list for keyboard nav. ArrowUp/Down walks this sequence; the
  // rendered DOM splits by source.
  const flat = useMemo(() => [...sections.cebab, ...sections.sdk], [sections]);

  // Highlight index. Clamped when the candidate set shrinks under it.
  const [highlight, setHighlight] = useState(0);
  useEffect(() => {
    setHighlight((cur) => (flat.length === 0 ? 0 : Math.min(cur, flat.length - 1)));
  }, [flat.length]);

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((cur) => (flat.length === 0 ? 0 : (cur + 1) % flat.length));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((cur) =>
        flat.length === 0 ? 0 : (cur - 1 + flat.length) % flat.length,
      );
      return;
    }
    if (e.key === 'Enter') {
      if (flat.length === 0) return;
      e.preventDefault();
      onSelect(flat[highlight]!.command);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
  }

  // Compute the rendered indices so each section can reflect aria-selected.
  let runningIdx = 0;
  function nextIdx() {
    return runningIdx++;
  }

  const isEmpty = flat.length === 0;
  const activeRowId = !isEmpty ? `slash-palette-row-${highlight}` : undefined;

  return (
    <div
      className="slash-palette"
      role="dialog"
      aria-label="Slash command palette"
    >
      <input
        ref={inputRef}
        type="text"
        className="slash-palette-input"
        placeholder="Type to filter slash commands…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKey}
        aria-label="Filter slash commands"
        aria-controls="slash-palette-listbox"
        aria-activedescendant={activeRowId}
        autoComplete="off"
        spellCheck={false}
      />
      <div
        id="slash-palette-listbox"
        role="listbox"
        aria-label="Available slash commands"
        className="slash-palette-listbox"
      >
        {isEmpty ? (
          <p className="slash-palette-empty">
            No commands match {query.length > 0 ? <code>{query}</code> : 'your filter'}.
          </p>
        ) : (
          <>
            {sections.cebab.length > 0 && (
              <div className="slash-palette-section">
                <p className="slash-palette-section-title" aria-hidden="true">
                  Cebab quick commands
                </p>
                <ul className="slash-palette-list">
                  {sections.cebab.map((c) => {
                    const i = nextIdx();
                    return (
                      <PaletteRow
                        key={c.command}
                        item={c}
                        index={i}
                        active={highlight === i}
                        onHover={setHighlight}
                        onSelect={onSelect}
                      />
                    );
                  })}
                </ul>
              </div>
            )}
            {sections.sdk.length > 0 && (
              <div className="slash-palette-section">
                <p className="slash-palette-section-title" aria-hidden="true">
                  Discovered from session
                </p>
                <ul className="slash-palette-list">
                  {sections.sdk.map((c) => {
                    const i = nextIdx();
                    return (
                      <PaletteRow
                        key={c.command}
                        item={c}
                        index={i}
                        active={highlight === i}
                        onHover={setHighlight}
                        onSelect={onSelect}
                      />
                    );
                  })}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function PaletteRow({
  item,
  index,
  active,
  onHover,
  onSelect,
}: {
  item: SlashCommand;
  index: number;
  active: boolean;
  onHover: (i: number) => void;
  onSelect: (command: string) => void;
}) {
  return (
    <li
      id={`slash-palette-row-${index}`}
      role="option"
      aria-selected={active}
      className={`slash-palette-row${active ? ' is-active' : ''}`}
      onMouseDown={(e) => {
        // mousedown not click so the filter input doesn't lose focus
        // before our onSelect runs (the textarea outside is the focus
        // target after onSelect closes the palette).
        e.preventDefault();
        onSelect(item.command);
      }}
      onMouseEnter={() => onHover(index)}
    >
      <code className="slash-palette-row-command">{item.command}</code>
      {item.description ? (
        <span className="slash-palette-row-description">{item.description}</span>
      ) : (
        <span className="slash-palette-row-description slash-palette-row-description-empty">
          {item.source === 'sdk' ? 'SDK-discovered' : ''}
        </span>
      )}
    </li>
  );
}
