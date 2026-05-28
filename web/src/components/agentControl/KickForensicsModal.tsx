import { useEffect, useRef } from 'react';
import type {
  ForensicBusEvent,
  ForensicMutation,
  KickForensicsSnapshot,
} from '@cebab/shared/protocol';
import { useModalSurface } from '../../useModalSurface';
import {
  useForensicViewerActions,
  useForensicViewerState,
} from './ForensicViewerContext';

// Cluster C Phase 4g4 (spec §5.5, §6.4): viewer for the forensic bundle
// captured when an agent was kicked. Operator triggers via the ⋮ menu
// (which now stays enabled on a kicked participant — the only item
// shown is "View forensics…").
//
// Layout: a header with the kick provenance (audit id, reason, ts,
// operator), then sections for the captured fields:
//   - Effective prompt (would-have-run on next turn)
//   - Bus events (most-recent N this agent was in source OR destination)
//   - Mutations attributed to this agent
//   - Snapshot meta (workdir tree hash, audit lineage)
//
// Snapshot-failed path: if the capture itself threw, the audit row
// still exists (kick is the obligation; forensics is the evidence
// pack on top — per repo doc). The modal renders an error banner and
// hides the body sections; operator at least sees what was attempted
// and why.

export function KickForensicsModal() {
  const state = useForensicViewerState();
  const { close } = useForensicViewerActions();

  // useModalSurface MUST be called unconditionally per React's rules-of-
  // hooks; if state is closed we never reach the JSX so the hook does
  // nothing useful, but its registration is harmless.
  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose: close });
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (state.kind === 'ready' || state.kind === 'loading' || state.kind === 'error') {
      closeBtnRef.current?.focus();
    }
  }, [state.kind]);

  if (state.kind === 'closed') return null;

  const titleId = `kick-forensics-modal-title-${state.sessionId}-${state.agentSlug}`;
  return (
    <div
      ref={overlayRef}
      className="gate-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={onBackdropMouseDown}
    >
      <div className="gate-modal modal-surface kick-forensics-modal">
        <header className="gate-modal-header">
          <h3 id={titleId} className="gate-modal-title">
            Kick forensics · <code>{state.agentSlug}</code>
          </h3>
          <span
            className="gate-modal-reason gate-modal-reason-env"
            aria-label="info: read-only inspection"
          >
            read-only
          </span>
        </header>
        <Body state={state} />
        <div className="gate-modal-buttons">
          <button
            type="button"
            ref={closeBtnRef}
            className="ghost-btn gate-modal-btn gate-modal-btn-primary"
            onClick={close}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Body({
  state,
}: {
  state: Exclude<ReturnType<typeof useForensicViewerState>, { kind: 'closed' }>;
}) {
  if (state.kind === 'loading') {
    return (
      <p className="gate-modal-help kick-forensics-status">
        Loading forensic bundle for <code>{state.agentSlug}</code>…
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <p className="gate-modal-help kick-forensics-status is-error">
        Failed to load: {state.message}
      </p>
    );
  }
  // ready
  if (!state.found || !state.snapshot) {
    return (
      <p className="gate-modal-help kick-forensics-status">
        No forensic bundle captured for <code>{state.agentSlug}</code> in this session. The
        capture may still be in flight, or the row was lost before persist. The
        <code> agent_control.kicked</code> safety_audit row is the authoritative obligation
        either way — its hash chain pins the kick even when the evidence pack is missing.
      </p>
    );
  }
  return <Sections snapshot={state.snapshot} />;
}

function Sections({ snapshot }: { snapshot: KickForensicsSnapshot }) {
  if (snapshot.snapshotFailedReason) {
    return (
      <>
        <Meta snapshot={snapshot} />
        <p className="gate-modal-help kick-forensics-status is-error">
          Capture failed: <code>{snapshot.snapshotFailedReason}</code>
        </p>
      </>
    );
  }
  return (
    <>
      <Meta snapshot={snapshot} />
      <EffectivePromptSection effectivePrompt={snapshot.effectivePrompt} />
      <BusEventsSection events={snapshot.busEvents} />
      <MutationsSection mutations={snapshot.mutations} />
    </>
  );
}

function Meta({ snapshot }: { snapshot: KickForensicsSnapshot }) {
  const reasonLabel =
    snapshot.kickReasonText && snapshot.kickReasonText.length > 0
      ? `${snapshot.kickReasonCode ?? '?'}: ${snapshot.kickReasonText}`
      : (snapshot.kickReasonCode ?? '(unknown)');
  return (
    <dl className="kick-forensics-meta">
      <div className="kick-forensics-meta-row">
        <dt>Reason</dt>
        <dd>
          <code>{reasonLabel}</code>
        </dd>
      </div>
      <div className="kick-forensics-meta-row">
        <dt>Mode</dt>
        <dd>
          <code>{snapshot.kickMode ?? '(unknown)'}</code>
        </dd>
      </div>
      <div className="kick-forensics-meta-row">
        <dt>Kicked at</dt>
        <dd>{new Date(snapshot.ts).toLocaleString()}</dd>
      </div>
      <div className="kick-forensics-meta-row">
        <dt>Operator</dt>
        <dd>
          <code>{snapshot.operatorId}</code>
        </dd>
      </div>
      <div className="kick-forensics-meta-row">
        <dt>Audit row</dt>
        <dd>
          <code>{snapshot.auditId}</code>
        </dd>
      </div>
      {snapshot.workdirTreeHash && (
        <div className="kick-forensics-meta-row">
          <dt>Workdir hash</dt>
          <dd>
            <code className="kick-forensics-hash">{snapshot.workdirTreeHash}</code>
          </dd>
        </div>
      )}
    </dl>
  );
}

function EffectivePromptSection({ effectivePrompt }: { effectivePrompt: unknown }) {
  return (
    <section className="kick-forensics-section">
      <h4 className="kick-forensics-section-title">Effective prompt</h4>
      {renderPrompt(effectivePrompt)}
    </section>
  );
}

function renderPrompt(prompt: unknown) {
  if (prompt === null || prompt === undefined) {
    return (
      <p className="kick-forensics-empty">
        No prompt captured — the agent had no pending bus inbox at kick time.
      </p>
    );
  }
  if (typeof prompt === 'string') {
    return <pre className="kick-forensics-prompt">{prompt}</pre>;
  }
  if (typeof prompt === 'object') {
    // Capture helper stores {kind, source, ts, text} for last-bus-inbox.
    // Render the `text` field prominently if present; fall back to a
    // pretty-printed dump for anything we don't recognize.
    const p = prompt as Record<string, unknown>;
    if (typeof p.text === 'string') {
      const kind = typeof p.kind === 'string' ? p.kind : undefined;
      const source = typeof p.source === 'string' ? p.source : undefined;
      return (
        <>
          {(kind || source) && (
            <p className="kick-forensics-prompt-meta">
              {kind ? <code>{kind}</code> : null}
              {kind && source ? ' · from ' : null}
              {source ? <code>{source}</code> : null}
            </p>
          )}
          <pre className="kick-forensics-prompt">{p.text}</pre>
        </>
      );
    }
    return <pre className="kick-forensics-prompt">{JSON.stringify(prompt, null, 2)}</pre>;
  }
  return <pre className="kick-forensics-prompt">{String(prompt)}</pre>;
}

function BusEventsSection({ events }: { events: ForensicBusEvent[] }) {
  if (events.length === 0) {
    return (
      <section className="kick-forensics-section">
        <h4 className="kick-forensics-section-title">Bus events</h4>
        <p className="kick-forensics-empty">
          No bus events captured for this agent in this session.
        </p>
      </section>
    );
  }
  return (
    <section className="kick-forensics-section">
      <h4 className="kick-forensics-section-title">
        Bus events <span className="kick-forensics-count">·&nbsp;{events.length}</span>
      </h4>
      <ul className="kick-forensics-event-list">
        {events.map((ev) => (
          <li key={ev.id} className="kick-forensics-event">
            <span className="kick-forensics-event-meta">
              <code>{ev.source}</code> → <code>{ev.destination}</code>{' '}
              <span className="kick-forensics-event-kind">{ev.kind}</span>
              <span className="kick-forensics-event-ts">
                {new Date(ev.ts).toLocaleTimeString()}
              </span>
            </span>
            {ev.textPreview && (
              <p className="kick-forensics-event-text">{ev.textPreview}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function MutationsSection({ mutations }: { mutations: ForensicMutation[] }) {
  if (mutations.length === 0) {
    return (
      <section className="kick-forensics-section">
        <h4 className="kick-forensics-section-title">Mutations</h4>
        <p className="kick-forensics-empty">
          No mutations attributed to this agent.
        </p>
      </section>
    );
  }
  return (
    <section className="kick-forensics-section">
      <h4 className="kick-forensics-section-title">
        Mutations <span className="kick-forensics-count">·&nbsp;{mutations.length}</span>
      </h4>
      <ul className="kick-forensics-mutation-list">
        {mutations.map((m) => (
          <li key={m.id} className={`kick-forensics-mutation kick-forensics-mutation-${m.category}`}>
            <span className="kick-forensics-mutation-meta">
              <code>{m.toolName}</code>
              <span className="kick-forensics-mutation-category">{m.category}</span>
              {!m.confirmed && (
                <span
                  className="kick-forensics-mutation-unconfirmed"
                  title="Mutation never reached the operator's confirm gate"
                >
                  unconfirmed
                </span>
              )}
            </span>
            <p className="kick-forensics-mutation-summary">{m.summary}</p>
            {m.filePath && (
              <p className="kick-forensics-mutation-path">
                <code>{m.filePath}</code>
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
