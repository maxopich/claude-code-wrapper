import { useId, useRef, type KeyboardEvent } from 'react';
import type { ManagedFileKind, ManagedFileRefusal } from '@cebab/shared/protocol';
import { nextIndex } from '../listNavigation';
import { useModalSurface } from '../useModalSurface';
import { GrowTextarea } from './GrowTextarea';
import type { ManagedEditorMode } from '../store';

/**
 * Cebab-ws0.10 — edit a managed agent's own config files.
 *
 * WHY RAW BYTES AND NOT A FORM. What is on screen is exactly what is on disk.
 * A structured editor would have to parse and re-serialise, which reformats the
 * operator's file, reorders its keys, and drops anything the form did not know
 * about — on files whose whole purpose is to be read by another program. The
 * cost of showing raw text is that the operator can write invalid JSON; the
 * server refuses it and nothing lands, which is a recoverable mistake. The cost
 * of silently rewriting someone's config is not.
 *
 * WHY IT SAYS THESE ARE SECRETS. `pathLooksSensitive` is true for `.mcp.json`
 * and `.claude/settings.json` — Cebab's own rule already treats their whole
 * bodies as credentials. `Cebab-ws0.11` wanted this warning and had nowhere to
 * put it, so it went into the COPY dialog instead ("you are about to duplicate
 * these"). This is its real home, and the wording is the other one: what is on
 * screen right now is live.
 *
 * MANAGED AGENTS ONLY. There is no path on the wire — only a kind from a closed
 * set of three — so this cannot be pointed at an operator's own repository even
 * by a client that tried.
 */

export type ManagedFileEditorProps = {
  projectName: string;
  kind: ManagedFileKind;
  relPath: string | null;
  sensitive: boolean;
  view: ManagedEditorMode;
  canSave: boolean;
  saving: boolean;
  savedAt: number | null;
  /** A failed SAVE, shown alongside the operator's text rather than replacing
   *  it — losing what they typed to report why it did not save would be worse
   *  than the failure. */
  saveRefusal: { refusal: ManagedFileRefusal; detail?: string } | null;
  onKind: (kind: ManagedFileKind) => void;
  onDraft: (text: string) => void;
  onSave: () => void;
  onClose: () => void;
};

const TABS: { kind: ManagedFileKind; label: string }[] = [
  { kind: 'settings', label: 'settings.json' },
  { kind: 'mcp', label: '.mcp.json' },
  { kind: 'claude_md', label: 'CLAUDE.md' },
];

/**
 * What went wrong, in the operator's terms and with the next step implied.
 *
 * Each refusal gets its own sentence rather than one generic line, because they
 * ask for different things: a stale token means reopen, invalid JSON means fix
 * a character, too large means use an editor outside Cebab.
 */
export function refusalMessage(refusal: ManagedFileRefusal, detail?: string): string {
  switch (refusal) {
    case 'not_managed':
      return 'Only agents Cebab manages can be edited here. This project lives in your own workspace, so Cebab leaves it alone.';
    case 'unknown_project':
      return 'That agent is no longer in the list.';
    case 'unknown_kind':
      return 'That is not one of the files Cebab can edit.';
    case 'too_large':
      return 'This file is too large to edit here. Open it in your own editor — Cebab will not show part of a file it might then save over the rest of.';
    case 'unreadable':
      return 'That file could not be read. Its folder may have been removed.';
    case 'invalid_json':
      return detail ? `That is not valid JSON: ${detail}` : 'That is not valid JSON.';
    case 'stale':
      return 'This file changed somewhere else while you were editing. Close and reopen it so you are working from the current version — nothing has been overwritten.';
    case 'write_failed':
      return 'The file could not be written. Its previous contents are untouched.';
    case 'audit_failed':
      return 'Cebab could not record the change, so it did not make it. Editing a config can add hooks, servers and environment variables, and an unrecorded change to any of those is not one Cebab will make.';
  }
}

export function ManagedFileEditor(props: ManagedFileEditorProps) {
  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose: props.onClose });
  const titleId = useId();
  const { view } = props;
  const tabsRef = useRef<HTMLDivElement>(null);

  /**
   * The keyboard half of `role="tablist"`, which is a promise and not a label:
   * arrows move between tabs, Home/End jump to the ends, and Tab leaves the
   * widget rather than walking through it. `nextIndex` is the shared helper the
   * other composite widgets here use; horizontal orientation and wrapping match
   * the ARIA tabs pattern.
   *
   * Selection follows focus, which is the pattern's default for tab panels whose
   * content is cheap to produce. It is a local file read, so it is.
   */
  function onTabKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    // Never swallow a key another handler already claimed — the trap that bit
    // the session-search combobox when it adopted this helper.
    if (e.defaultPrevented) return;
    const current = TABS.findIndex((t) => t.kind === props.kind);
    const target = nextIndex({
      key: e.key,
      current,
      count: TABS.length,
      orientation: 'horizontal',
      wrap: true,
    });
    if (target === null || target === current) return;
    e.preventDefault();
    const kind = TABS[target]!.kind;
    props.onKind(kind);
    // Roving focus: the newly selected tab becomes the single tab stop, so
    // focus has to move with it or the operator's next arrow starts from the
    // wrong place.
    tabsRef.current?.querySelector<HTMLButtonElement>(`#managed-file-tab-${kind}`)?.focus();
  }

  return (
    <div
      ref={overlayRef}
      className="gate-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={onBackdropMouseDown}
    >
      <div className="gate-modal modal-surface managed-file-modal">
        <header className="gate-modal-header">
          <h3 id={titleId} className="gate-modal-title">
            {props.projectName} — configuration
          </h3>
        </header>

        <div
          ref={tabsRef}
          className="managed-file-tabs"
          role="tablist"
          aria-label="Configuration file"
          onKeyDown={onTabKeyDown}
        >
          {TABS.map((t) => (
            <button
              key={t.kind}
              type="button"
              role="tab"
              id={`managed-file-tab-${t.kind}`}
              aria-selected={t.kind === props.kind}
              aria-controls="managed-file-panel"
              // One tab stop for the whole widget, which is what the role
              // promises. Three tabbable buttons would be the radiogroup bug
              // `widgetRoles.test.ts` was written after.
              tabIndex={t.kind === props.kind ? 0 : -1}
              className={`managed-file-tab${t.kind === props.kind ? ' is-active' : ''}`}
              onClick={() => props.onKind(t.kind)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div
          id="managed-file-panel"
          role="tabpanel"
          aria-labelledby={`managed-file-tab-${props.kind}`}
          className="managed-file-panel"
        >
          {props.relPath && (
            <p className="gate-modal-help managed-file-path">
              <code>{props.relPath}</code>
              {view.mode === 'editing' && view.creating && (
                <span className="managed-file-absent">
                  {' '}
                  — does not exist yet; saving creates it
                </span>
              )}
            </p>
          )}

          {props.sensitive && (
            <p className="gate-modal-help managed-file-secret" data-testid="managed-file-secret">
              <span className="managed-file-glyph" aria-hidden="true">
                ⚠
              </span>{' '}
              This file can hold live credentials, and what is below is the real thing — not a
              preview and not masked. Take the same care you would with the file itself.
            </p>
          )}

          {view.mode === 'loading' && <p className="gate-modal-help">Reading the file…</p>}

          {view.mode === 'refused' && (
            <p className="gate-modal-help managed-file-error" data-testid="managed-file-refusal">
              {refusalMessage(view.refusal, view.detail)}
            </p>
          )}

          {view.mode === 'editing' && (
            <>
              <GrowTextarea
                value={view.content}
                onChange={props.onDraft}
                onSubmit={() => {}}
                // Enter must insert a newline in a file, and saving is an
                // explicit button — the composer's Enter-submits default would
                // write to disk on a line break.
                submitOnEnter={false}
                disabled={props.saving}
                minRows={12}
                maxHeightPx={420}
                ariaLabel={`Contents of ${props.relPath ?? 'the file'}`}
              />
              {props.saveRefusal && (
                <p
                  className="gate-modal-help managed-file-error"
                  data-testid="managed-file-save-error"
                >
                  {refusalMessage(props.saveRefusal.refusal, props.saveRefusal.detail)}
                </p>
              )}
              {props.savedAt !== null && !props.saveRefusal && (
                <p className="gate-modal-help managed-file-saved" role="status">
                  Saved. The next session this agent starts will load it.
                </p>
              )}
            </>
          )}
        </div>

        <div className="gate-modal-actions">
          <button type="button" className="btn" onClick={props.onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!props.canSave}
            onClick={props.onSave}
          >
            {props.saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
