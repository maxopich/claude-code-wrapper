import { useMemo, useRef, useState, useEffect } from 'react';
import { SHORTCUTS, type ShortcutDescriptor, type ShortcutSection } from '../shortcutRegistry';
import { useModalSurface } from '../useModalSurface';

/**
 * Cluster E Phase 4 (H1) — keyboard cheatsheet.
 *
 * Renders every entry in `shortcutRegistry.ts` grouped by section. A
 * filter input at the top narrows by key text + description (case-
 * insensitive substring). Sections with no surviving rows hide their
 * header so the layout doesn't show "Composer" above nothing.
 *
 * The modal is intentionally read-only: the spec's footer "Customize
 * bindings" link is an OQ-E3 deferral (docs link only in v1; in-app
 * editor is v1.x). The "Add a binding by editing the registry" hint
 * is shown so contributors know where to look.
 */

export type KeyboardShortcutsModalProps = {
  onClose: () => void;
};

const SECTION_ORDER: ShortcutSection[] = [
  'Session',
  'Composer',
  'Notifications',
  'Authority',
  'Multi-agent',
  'Help',
];

export function KeyboardShortcutsModal({ onClose }: KeyboardShortcutsModalProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus the filter input on mount so the operator can type to narrow
  // immediately. Esc dismissal lives in useModalSurface.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose });

  const sectioned = useMemo(() => {
    const q = query.trim().toLowerCase();
    const groups = new Map<ShortcutSection, ShortcutDescriptor[]>();
    for (const s of SHORTCUTS) {
      if (q.length > 0) {
        const hay = `${s.keyDisplay.join(' ')} ${s.description}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const list = groups.get(s.section) ?? [];
      list.push(s);
      groups.set(s.section, list);
    }
    // Render in spec'd order; sections with no surviving rows are
    // omitted by the renderer below.
    return SECTION_ORDER.map((name) => ({ name, rows: groups.get(name) ?? [] }));
  }, [query]);

  const isEmpty = sectioned.every((s) => s.rows.length === 0);

  return (
    <div
      ref={overlayRef}
      className="modal-backdrop"
      onMouseDown={onBackdropMouseDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="keyboard-shortcuts-modal-title"
    >
      <div className="modal modal-surface keyboard-shortcuts-modal">
        <header>
          <h2 id="keyboard-shortcuts-modal-title">Keyboard shortcuts</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </header>
        <section className="keyboard-shortcuts-modal-filter-section">
          <input
            ref={inputRef}
            type="text"
            className="keyboard-shortcuts-modal-filter"
            placeholder="Filter shortcuts (e.g. stop, palette, send)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter shortcuts"
            spellCheck={false}
            autoComplete="off"
          />
        </section>
        <section className="keyboard-shortcuts-modal-body">
          {isEmpty ? (
            <p className="keyboard-shortcuts-modal-empty">
              No shortcuts match{' '}
              {query.length > 0 ? <code>{query}</code> : 'your filter'}.
            </p>
          ) : (
            sectioned.map((s) =>
              s.rows.length === 0 ? null : (
                <div key={s.name} className="keyboard-shortcuts-modal-section">
                  <h3 className="keyboard-shortcuts-modal-section-title">{s.name}</h3>
                  <ul className="keyboard-shortcuts-modal-list">
                    {s.rows.map((row) => (
                      <li key={row.id} className="keyboard-shortcuts-modal-row">
                        <span className="keyboard-shortcuts-modal-keys">
                          {row.keyDisplay.map((k, i) => (
                            <span key={i}>
                              {i > 0 && (
                                <span
                                  className="keyboard-shortcuts-modal-plus"
                                  aria-hidden="true"
                                >
                                  +
                                </span>
                              )}
                              <kbd className="kbd">{k}</kbd>
                            </span>
                          ))}
                        </span>
                        <span className="keyboard-shortcuts-modal-description">
                          {row.description}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ),
            )
          )}
        </section>
        <footer className="keyboard-shortcuts-modal-footer">
          <p className="hint">
            Want to add a shortcut? Edit{' '}
            <code>web/src/shortcutRegistry.ts</code> — the cheatsheet renders
            from there.
          </p>
        </footer>
      </div>
    </div>
  );
}
