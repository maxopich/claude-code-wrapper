/**
 * PR-5: Split-view role-editor panel for the fullscreen modal.
 *
 * Rendered to the right of the diagram canvas at ≥1024 px (and stacked
 * below at <768 px via CSS grid). Each row carries the agent's identity
 * chip (8×8 hue swatch + glyph mirrors the canvas) and a plain textarea
 * for the role/goal. Reads/writes roles via the parent's callbacks so
 * `roles` stays the single source of truth across modal toggle (AC-19).
 *
 * Bidi sync (AC-23):
 *  - Canvas tile activation → parent updates `selectedPid` → this panel
 *    scrolls the matching row into view and focuses its textarea.
 *  - Textarea focus → fire `onSelect(pid)` → the canvas tile gets the
 *    `.is-selected` outline.
 *
 * No add/remove of agents here — template authoring is elsewhere.
 *
 * PR-6: per-row "About this project" disclosure surfaces the working
 * directory and the head of the project's root CLAUDE.md (when present).
 * Lazy-loaded — the RPC fires on first summary open, then a `useRef<Map>`
 * caches the reply for the lifetime of this panel instance (a closed-then-
 * reopened modal remounts this panel and re-fetches, so stale on-disk state
 * is impossible to display).
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Project, ProjectFacts, ServerMsg } from '@cebab/shared/protocol';
import { agentIdentity } from '../../agentIdentity';

/** Local cache entry per project. `'loading'` covers the gap between
 *  the RPC firing and the reply landing; `null` is an explicit "we've
 *  asked once, never got a reply" placeholder (currently unused — the
 *  server always replies — but keeps the union honest if we later add
 *  a timeout or wrapper_error path). */
type FactsState = 'loading' | ProjectFacts;

export function SplitViewPanel(props: {
  participants: Project[];
  roles: Record<string, string>;
  onRoleChange: (projectId: number, text: string) => void;
  onCommitRole?: (projectId: number, text: string) => void;
  selectedPid: number | null;
  onSelect: (projectId: number | null) => void;
  /** PR-6: request a project's static facts. Optional — when absent the
   *  disclosure is still rendered but its summary toggle is inert (the
   *  test harness doesn't need a WS round-trip for non-facts tests). */
  onReadProjectFacts?: (projectId: number) => void;
  /** PR-6: subscription seam. Paired with `onReadProjectFacts`. */
  subscribeServerMsg?: (cb: (msg: ServerMsg) => void) => () => void;
}) {
  const { participants, roles, selectedPid, onReadProjectFacts, subscribeServerMsg } = props;
  const taRefs = useRef(new Map<number, HTMLTextAreaElement>());

  // PR-6: per-panel-instance cache for project_facts replies. The modal
  // unmounts this panel when closed; reopening creates a fresh Map so
  // closed-then-reopened modal sees fresh on-disk state (matches the plan's
  // "(projectId, modalOpenedAt)" invalidation contract without an explicit ts).
  const [facts, setFacts] = useState<Map<number, FactsState>>(() => new Map());

  // Subscribe to project_facts ServerMsgs and merge into the local cache.
  // The subscription's lifetime tracks this panel — no leaks across modal
  // reopens (each new panel adds its own subscriber, the previous one was
  // removed on unmount).
  useEffect(() => {
    if (!subscribeServerMsg) return;
    const unsub = subscribeServerMsg((msg) => {
      if (msg.type !== 'project_facts') return;
      setFacts((prev) => {
        // Only swap entries that exist in our cache (i.e. we asked for them);
        // a stray reply from another surface won't poison this panel's state.
        if (!prev.has(msg.projectId)) return prev;
        const next = new Map(prev);
        next.set(msg.projectId, msg.facts);
        return next;
      });
    });
    return unsub;
  }, [subscribeServerMsg]);

  // Bidi sync: scroll + focus the matching textarea when the canvas
  // selects a tile. The previous-pid ref guards against re-focusing
  // on every parent render — we only react when selectedPid changes.
  const prevSelected = useRef<number | null>(null);
  useEffect(() => {
    if (selectedPid === null) {
      prevSelected.current = null;
      return;
    }
    if (selectedPid === prevSelected.current) return;
    prevSelected.current = selectedPid;
    const ta = taRefs.current.get(selectedPid);
    if (!ta) return;
    // Defer one frame so the row's bounding box is settled (newly-mounted
    // panel + selection in the same tick).
    requestAnimationFrame(() => {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      ta.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
      ta.focus({ preventScroll: true });
    });
  }, [selectedPid]);

  /** First-open handler for the per-row "About this project" disclosure.
   *  Fires the RPC at most once per panel instance per project — a second
   *  open after a close reuses the cached reply (no extra round-trip). */
  function onFactsToggle(projectId: number, open: boolean) {
    if (!open || !onReadProjectFacts) return;
    if (facts.has(projectId)) return; // cached (loading or resolved) — no refetch
    setFacts((prev) => {
      const next = new Map(prev);
      next.set(projectId, 'loading');
      return next;
    });
    onReadProjectFacts(projectId);
  }

  return (
    <div className="tpl-panel-inner">
      <header className="tpl-panel-header">
        <h4 className="tpl-panel-heading">
          {participants.length} agent{participants.length === 1 ? '' : 's'}
        </h4>
        <p className="tpl-panel-sub">
          Edit each agent's role. Changes persist on Enter or when you close.
        </p>
      </header>
      <ul className="tpl-panel-list" role="list">
        {participants.map((p) => {
          const ident = agentIdentity(p.name);
          const isSelected = selectedPid === p.id;
          const swatchStyle: CSSProperties = {
            ['--identity-hue']: ident.hueVar ?? 'var(--fg-3)',
          } as CSSProperties;
          const role = roles[String(p.id)] ?? '';
          const cached = facts.get(p.id);
          return (
            <li
              key={p.id}
              className={`tpl-panel-row${isSelected ? ' is-selected' : ''}`}
              data-pid={p.id}
            >
              {/* Avatar-style ident chip: the hue is a translucent
               *  background tint and the glyph sits inside it. Stacking
               *  swatch + glyph stacked vertically looked like duplicate
               *  chips for the ■ glyph case where both shapes are filled
               *  squares — collapsing to one element keeps the carrier
               *  unambiguous. */}
              <div className="tpl-panel-ident" style={swatchStyle} aria-hidden="true">
                <span className="tpl-panel-glyph">{ident.glyph}</span>
              </div>
              <div className="tpl-panel-body">
                <label className="tpl-panel-label" htmlFor={`tpl-panel-ta-${p.id}`}>
                  {p.name}
                </label>
                <textarea
                  id={`tpl-panel-ta-${p.id}`}
                  ref={(el) => {
                    if (el) taRefs.current.set(p.id, el);
                    else taRefs.current.delete(p.id);
                  }}
                  className="tpl-panel-textarea"
                  value={role}
                  placeholder="Role / goal…"
                  spellCheck={false}
                  rows={2}
                  onChange={(e) => props.onRoleChange(p.id, e.target.value)}
                  onFocus={() => props.onSelect(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      e.stopPropagation();
                      props.onCommitRole?.(p.id, role);
                    }
                    // Esc bubbles up to useModalKeys → closes the modal.
                    // The committed value lives in `roles` already (controlled
                    // via onChange), so closing isn't data-lossy.
                  }}
                />
                {/* PR-6: per-row static facts disclosure. Closed by default;
                 *  the first open fires the WS round-trip, subsequent opens
                 *  reuse the cached reply for this panel instance. */}
                <ProjectFactsDisclosure
                  projectId={p.id}
                  facts={cached}
                  onToggle={(open) => onFactsToggle(p.id, open)}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** PR-6: collapsed `<details>` block per panel row.
 *
 *  Rendered always (even when the parent supplied no `onReadProjectFacts` —
 *  in that case the body shows nothing on open but the summary still
 *  renders, which is what the test harness wants). The body only mounts
 *  when open, so a closed disclosure is essentially free.
 */
function ProjectFactsDisclosure(props: {
  projectId: number;
  facts: FactsState | undefined;
  onToggle: (open: boolean) => void;
}) {
  const bodyId = `tpl-panel-facts-${props.projectId}`;
  return (
    <details
      className="tpl-panel-facts"
      onToggle={(e) => props.onToggle((e.target as HTMLDetailsElement).open)}
    >
      <summary className="tpl-panel-facts-summary" aria-controls={bodyId}>
        About this project
      </summary>
      <div id={bodyId} className="tpl-panel-facts-body">
        <ProjectFactsBody facts={props.facts} />
      </div>
    </details>
  );
}

/** Render the facts payload. Three states:
 *  - undefined: the disclosure was opened, RPC not yet fired (or no
 *    onReadProjectFacts was provided). Shows nothing — the body is empty.
 *  - 'loading': RPC fired, no reply yet. Shows a low-noise placeholder.
 *  - ProjectFacts: render only the fields that are present. */
function ProjectFactsBody(props: { facts: FactsState | undefined }) {
  const { facts } = props;
  if (facts === undefined) return null;
  if (facts === 'loading') {
    return <p className="tpl-panel-facts-loading">Loading…</p>;
  }
  return (
    <>
      <div className="tpl-panel-facts-row">
        <strong>Working directory:</strong> <code>{facts.path || '—'}</code>
      </div>
      {facts.claudeMdHead && (
        <details className="tpl-panel-facts-claudemd">
          <summary>
            CLAUDE.md
            {facts.claudeMdSizeLabel ? <> ({facts.claudeMdSizeLabel})</> : null}
          </summary>
          <pre className="tpl-panel-claudemd-head">{facts.claudeMdHead}</pre>
        </details>
      )}
    </>
  );
}
