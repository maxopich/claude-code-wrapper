/**
 * PR-5: Fullscreen modal for the template preview diagram.
 *
 * Mirrors the LogsModal shell pattern: a `role="dialog"
 * aria-modal="true" aria-labelledby` overlay with `useModalKeys` for
 * Esc dismissal, a scoped sr-only live region, and initial focus on
 * the close button. The body holds a stretched-stage `AgentDiagram`
 * (left) and an optional split-view side panel (right) that lets the
 * operator edit per-agent roles in plain textareas. Split-view is on
 * by default at N≥9 and toggleable; the preference is persisted to
 * `localStorage` so the operator's last choice sticks across sessions.
 *
 * Focus management: there is no shared focus-trap utility in the
 * codebase (`useModalKeys` only handles Esc/Enter). PR-5 uses the
 * single-effect `inert` pattern — mark every sibling of the overlay,
 * walking up to `document.body`, with the `inert` attribute on open.
 * This blocks keyboard focus and pointer events from reaching the rest
 * of the page without depending on a focus-trap library. The
 * originating expand button restores focus on close (the parent owns
 * the button ref and calls .focus() after onClose runs).
 *
 * Reduced motion: the open animation is opacity-only when
 * `prefers-reduced-motion: reduce` (CSS rule pairs `.tpl-modal-overlay`
 * and `.tpl-modal` with `animation: none`). The compact card behind
 * the dimmed backdrop is paused via the parent's `paused={modalOpen}`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import type { MultiAgentTemplate, Project, ServerMsg } from '@cebab/shared/protocol';
import { useModalKeys } from '../../useModalKeys';
import { AgentDiagram } from './AgentDiagram';
import { SplitViewPanel } from './SplitViewPanel';
import { BypassPermissionsBanner } from './TemplatePreviewBanners';

export const SPLIT_VIEW_PREF_KEY = 'cebab.tpl.splitView';
/** N at which split-view defaults to ON when the user has no stored pref. */
export const SPLIT_VIEW_AUTO_N = 9;

/** Pure decision: stored pref overrides the N-based default; null
 *  means "no pref stored" so the auto-N rule kicks in. Extracted for
 *  unit testing (AC-22) without needing to render the modal. */
export function decideSplitView(n: number, storedPref: boolean | null): boolean {
  if (storedPref !== null) return storedPref;
  return n >= SPLIT_VIEW_AUTO_N;
}

export type ModalOrigin = { x: number; y: number };

export function TemplatePreviewModal(props: {
  template: MultiAgentTemplate;
  participants: Project[];
  roles: Record<string, string>;
  onRoleChange: (projectId: number, text: string) => void;
  onCommitRole?: (projectId: number, text: string) => void;
  onClose: () => void;
  /** Center-of-button viewport coordinates for the open animation's
   *  `transform-origin`. Without it the dialog scales from its own
   *  center (still legible but loses the "from the button" feel). */
  origin?: ModalOrigin;
  /** PR-6: request a participant project's static facts (path + CLAUDE.md
   *  head). Optional so test harnesses that don't exercise the disclosure
   *  can omit the WS plumbing; when absent, `SplitViewPanel` renders
   *  the disclosure but its summary click is a no-op (closed state). */
  onReadProjectFacts?: (projectId: number) => void;
  /** PR-6: subscription seam for `project_facts` replies. Paired with
   *  `onReadProjectFacts` — present together or absent together. */
  subscribeServerMsg?: (cb: (msg: ServerMsg) => void) => () => void;
}) {
  const { template, participants, roles, onClose } = props;
  const n = participants.length;
  const titleId = useMemo(() => `tpl-modal-title-${template.id}`, [template.id]);

  useModalKeys({ onClose });

  // Split-view preference: stored boolean overrides the N-based default.
  // The default (no pref) is on at N≥9, off below. Toggling writes the
  // explicit pref so it sticks across templates AND sessions.
  const [splitView, setSplitView] = useState<boolean>(() =>
    decideSplitView(n, readSplitViewPref()),
  );
  function toggleSplitView() {
    setSplitView((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SPLIT_VIEW_PREF_KEY, next ? '1' : '0');
      } catch {
        /* private mode / quota — pref just doesn't persist */
      }
      return next;
    });
  }

  // Bidi sync between canvas tile and panel row. Tile activation
  // (click / Enter / Space) sets `selectedPid`; the panel scrolls the
  // matching row into view + focuses its textarea. Conversely the
  // panel calls back here on row focus, but we drive selectedPid from
  // the panel's onSelect so both sides stay symmetric.
  const [selectedPid, setSelectedPid] = useState<number | null>(null);

  const closeRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Initial focus on close button (mirrors LogsModal L52–54). Screen
  // readers announce the dialog when its labelledby content + the
  // button label come into focus.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Body scroll lock — restored on unmount so chained modals still
  // see the lock. Single-modal codebase today, so no ref-count needed.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Focus trap via `inert`: mark every sibling of the overlay (walking
  // up to document.body) with the inert attribute. inert blocks both
  // keyboard focus and pointer events without aria-hidden's "still
  // tab-able" pitfall. The cleanup removes only the siblings we
  // marked, so any pre-existing inert content keeps its attribute.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const inerted: HTMLElement[] = [];
    // `node` is non-null throughout: it starts at `overlay` (just
    // guarded above) and only ever gets reassigned to `parent` after
    // the !parent break below — so the loop only needs the body-stop
    // check, not a redundant truthiness test (CodeQL js/trivial-conditional).
    let node: HTMLElement = overlay;
    while (node !== document.body) {
      const parent = node.parentElement;
      if (!parent) break;
      for (const sib of Array.from(parent.children)) {
        if (sib === node) continue;
        if (!(sib instanceof HTMLElement)) continue;
        if (sib.hasAttribute('inert')) continue;
        sib.setAttribute('inert', '');
        inerted.push(sib);
      }
      node = parent;
    }
    return () => {
      for (const el of inerted) el.removeAttribute('inert');
    };
  }, []);

  // Scoped live region announcement: open / close.
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    setAnnouncement(`Expanded ${template.name}: ${n} agent${n === 1 ? '' : 's'}`);
    return () => {
      // The empty value is harmless — the next mount will announce.
      setAnnouncement('');
    };
  }, [template.name, n]);

  function onBackdropClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  const overlayStyle: CSSProperties = {
    ['--tpl-modal-origin-x']: props.origin ? `${props.origin.x}px` : '50%',
    ['--tpl-modal-origin-y']: props.origin ? `${props.origin.y}px` : '50%',
  } as CSSProperties;

  return (
    <div
      ref={overlayRef}
      className="tpl-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      style={overlayStyle}
      onMouseDown={onBackdropClick}
    >
      <div className="tpl-modal">
        <header className="tpl-modal-header">
          <div className="tpl-modal-titlewrap">
            <h3 id={titleId} className="tpl-modal-title" title={template.name}>
              {template.name}
            </h3>
            <p className="tpl-modal-subtitle">
              {template.mode} · {template.lifecycle} · {n} agent{n === 1 ? '' : 's'}
            </p>
          </div>
          <div className="tpl-modal-actions">
            <button
              type="button"
              className="ghost-btn tpl-modal-split-toggle"
              aria-pressed={splitView}
              onClick={toggleSplitView}
              title={
                splitView
                  ? 'Hide the side panel (canvas only)'
                  : 'Show a side panel for editing roles'
              }
            >
              {splitView ? 'Hide panel' : 'Show panel'}
            </button>
            <button
              ref={closeRef}
              type="button"
              className="ghost-btn tpl-modal-close"
              onClick={onClose}
              aria-label="Close expanded template preview"
            >
              Close
            </button>
          </div>
        </header>

        {/* PR-1: repeated bypass banner. Sits between header and body so
            it's the first thing the operator sees after the title — the
            modal can outlive the multi-agent tab's banner in the operator's
            focus, especially when launched directly from a saved template. */}
        <div className="tpl-modal-banners">
          <BypassPermissionsBanner />
        </div>

        <div className={`tpl-modal-body${splitView ? ' tpl-modal-body--split' : ''}`}>
          <div className="tpl-modal-stage-wrap">
            <AgentDiagram
              mode={template.mode}
              participants={participants}
              roles={roles}
              onRoleChange={props.onRoleChange}
              onCommitRole={props.onCommitRole}
              disableOverlayEditor={splitView}
              selectedPid={selectedPid}
              onSelect={setSelectedPid}
              fullWidth
            />
          </div>
          {splitView && (
            <aside className="tpl-modal-panel" aria-label="Per-agent roles">
              <SplitViewPanel
                participants={participants}
                roles={roles}
                onRoleChange={props.onRoleChange}
                onCommitRole={props.onCommitRole}
                selectedPid={selectedPid}
                onSelect={setSelectedPid}
                onReadProjectFacts={props.onReadProjectFacts}
                subscribeServerMsg={props.subscribeServerMsg}
              />
            </aside>
          )}
        </div>

        {/* Scoped live region (sr-only). Mirrors LogsModal L145 — the
         *  pattern is "scoped, inside the dialog" rather than a global
         *  app-root region, which Cebab does not have. */}
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </div>
      </div>
    </div>
  );
}

function readSplitViewPref(): boolean | null {
  try {
    const v = window.localStorage.getItem(SPLIT_VIEW_PREF_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
    return null;
  } catch {
    return null;
  }
}
