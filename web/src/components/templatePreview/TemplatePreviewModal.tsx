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
 * Focus management: the `inert`-trap + body scroll lock + backdrop
 * click + activeElement restore that used to live inline here were
 * lifted into `useModalSurface` (PR-2B) so every modal in the app
 * gets them uniformly. The parent expand button's focus is also
 * restored on close by the hook (replaces the parent's manual
 * .focus() callback path).
 *
 * Reduced motion: the open animation is opacity-only when
 * `prefers-reduced-motion: reduce` (CSS rule pairs `.tpl-modal-overlay`
 * and `.tpl-modal` with `animation: none`). The compact card behind
 * the dimmed backdrop is paused via the parent's `paused={modalOpen}`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { MultiAgentTemplate, Project, ServerMsg } from '@cebab/shared/protocol';
import { useModalSurface } from '../../useModalSurface';
import { AgentDiagram } from './AgentDiagram';
import { SplitViewPanel } from './SplitViewPanel';
import { BypassPermissionsBanner, ConsultantModeBanner } from './TemplatePreviewBanners';

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

  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose });

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

  // Initial focus on close button (mirrors LogsModal). Screen readers
  // announce the dialog when its labelledby content + the button
  // label come into focus.
  useEffect(() => {
    closeRef.current?.focus();
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
      onMouseDown={onBackdropMouseDown}
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
          {/* Cluster F Phase D5 (UI-D5): pair with the bypass banner for
              orchestrator templates. Custom templates render via the
              orchestrator path (`layoutCustomGrid` delegates there), so the
              consultant-mode guardrail applies to them too; chain templates
              run under `renderChainBriefing` which has no consultant text. */}
          {(template.mode === 'orchestrator' || template.mode === 'custom') && (
            <ConsultantModeBanner />
          )}
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
