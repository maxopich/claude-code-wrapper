import { useEffect, useRef } from 'react';
import type { ClientMsg, ServerMsg } from '@cebab/shared/protocol';
import { useModalSurface } from '../../useModalSurface';

// Cluster G Phase 4 (D6/D11) BusTofuModal: TOFU prompt that fires when the
// server emits `bus_auto_install_pending` for a first-seen bus install
// attempt — either the explicit sidebar "Install bus integration" click
// or the implicit auto-install via "Add participant" in an orchestrator
// session. The operator's three-button choice ships back as a
// `bus_trust_decision` with the matching `pendingId`, which the backend
// gate (`bus/install_trust_gate.ts`) awaits before letting
// `installBusForProject` flip the project's `bus_installed` flag.
//
// UI contract (high/G-run-awareness §5 "D6/D11"):
//   - Title: "Trust this bus install?"
//   - Body explains the consequence: this project becomes a routable
//     participant identity on the bus; messages it sends will carry the
//     pinned `agentName` slug as `source`.
//   - Three buttons: Trust / Deny once / Deny & remember
//   - Default focus on `[Deny once]` per the agentic-reviewer's
//     destructive-modal pattern (the safer option pre-selected so the
//     operator's reflexive Enter doesn't grant trust by accident).
//
// Why no fourth "Trust & pin" button (vs the MCP TOFU): the bus is a
// Cebab-injected in-process MCP closure (`bus/runner.ts:makeBusToolServer`),
// not a binary. There is no sha to pin. The MCP modal greys its fourth
// affordance when the binarySha is absent — the bus modal omits the
// affordance entirely because it can never be applicable.
//
// `useModalSurface` provides focus trap, body-scroll lock, Esc-to-close,
// and backdrop-click-to-close.
//
// Register W28: this used to say Esc/backdrop "leaves the server-side gate
// parked; that's intentional", resting on two escapes — refreshing the WS,
// and "the same pending re-fires on reconnection in a future phase". Only the
// first exists: PR #310's drain made it real, while nothing re-emits a pending
// gate on attach. So "I'll decide later" was really "the install hangs until
// you drop the socket". Esc / backdrop now send `cancel_gate`, which unparks
// `installBusForProject` without recording a trust decision.

type Pending = Extract<ServerMsg, { type: 'bus_auto_install_pending' }>;

export function BusTofuModal(props: {
  pending: Pending;
  send: (msg: ClientMsg) => boolean;
  /** Pop the queue. Called after a decision has gone out. */
  onClose: () => void;
  /** Register W28: back out without deciding — sends `cancel_gate`, which
   *  unparks the spawn without recording a trust decision. */
  onCancel: () => void;
}) {
  const { pending, send, onClose, onCancel } = props;
  // W28: Esc / backdrop cancel rather than silently popping the queue and
  // leaving `installBusForProject` parked on its promise.
  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose: onCancel });

  // Default focus on Deny once per the destructive-modal pattern (spec
  // D6-4): the safer option is pre-selected so the operator's first
  // Enter doesn't grant trust.
  const denyOnceRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    denyOnceRef.current?.focus();
  }, []);

  function decide(decision: 'trust' | 'deny_once' | 'deny_remember'): void {
    const msg: ClientMsg = {
      type: 'bus_trust_decision',
      pendingId: pending.pendingId,
      projectId: pending.projectId,
      decision,
    };
    // W29: only close once the decision has actually gone out.
    if (!send(msg)) return;
    onClose();
  }

  const titleId = `bus-tofu-title-${pending.pendingId}`;

  return (
    <div
      ref={overlayRef}
      className="gate-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={onBackdropMouseDown}
    >
      <div className="gate-modal modal-surface">
        <header className="gate-modal-header">
          <h3 id={titleId} className="gate-modal-title">
            Trust this bus install?
          </h3>
          <span
            className="gate-modal-reason gate-modal-reason-first_seen"
            aria-label="reason: first seen"
          >
            first seen
          </span>
        </header>
        <dl className="gate-modal-facts">
          <div className="gate-modal-fact">
            <dt>Project</dt>
            <dd>
              <code>{pending.projectName}</code>
            </dd>
          </div>
          <div className="gate-modal-fact">
            <dt>Agent name</dt>
            <dd>
              <code>{pending.agentName}</code>
            </dd>
          </div>
          {pending.contextSessionId && (
            <div className="gate-modal-fact">
              <dt>Triggered from session</dt>
              <dd>
                <code className="gate-modal-path">{pending.contextSessionId}</code>
              </dd>
            </div>
          )}
        </dl>
        <p className="gate-modal-help">
          Installing the bus integration lets this project participate in multi-agent sessions as a
          routable identity. The agent slug above will be pinned as the worker&apos;s{' '}
          <code>source</code> on every message it sends, and the orchestrator&apos;s router-drop
          filters will treat that identity as authoritative. The bus runs in-process (no binary
          executes; nothing is written into your project) — but the trust decision is still
          consequential because the slug becomes part of the authority surface for every later bus
          message.
        </p>
        <div className="gate-modal-buttons">
          <button
            type="button"
            ref={denyOnceRef}
            className="ghost-btn gate-modal-btn"
            onClick={() => decide('deny_once')}
          >
            Deny once
          </button>
          <button
            type="button"
            className="ghost-btn gate-modal-btn gate-modal-btn-danger"
            onClick={() => decide('deny_remember')}
          >
            Deny &amp; remember
          </button>
          <button
            type="button"
            className="ghost-btn gate-modal-btn gate-modal-btn-primary"
            onClick={() => decide('trust')}
          >
            Trust
          </button>
        </div>
      </div>
    </div>
  );
}
