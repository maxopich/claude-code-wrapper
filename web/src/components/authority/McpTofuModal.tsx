import { useEffect, useRef } from 'react';
import type { ClientMsg, ServerMsg } from '@cebab/shared/protocol';
import { useModalSurface } from '../../useModalSurface';

// Cluster B Phase 6a (§4.4, UI-B36–UI-B39): TOFU prompt that fires when the
// server emits `mcp_auto_install_pending` for a first-seen / hash-changed
// MCP server. The operator's four-button choice ships back as a
// `mcp_trust_decision` with the matching `pendingId`, which the Phase 4b
// spawn-gate awaits before the SDK can load the binary.
//
// UI contract (spec §5.4):
//   - Title: "Trust this MCP server?" (or "MCP server binary changed" for
//     hash_changed)
//   - Body: server name, originPath, command, args, current binarySha,
//     previousSha (when hash_changed), reason chip
//   - Four buttons: Trust / Trust & pin hash / Deny once / Deny & remember
//   - "Trust & pin hash" is GREYED when binarySha is absent (npx etc) —
//     pinning a sha that can't be computed is meaningless
//
// The modal is "modal" in the WCAG sense — useModalSurface handles focus
// trap, body-scroll lock, Esc-to-close, and backdrop-click-to-close. We
// also restore focus to the originating element on unmount via the same
// hook.

type Pending = Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>;

export function McpTofuModal(props: {
  pending: Pending;
  send: (msg: ClientMsg) => void;
  onClose: () => void;
}) {
  const { pending, send, onClose } = props;
  // Esc / backdrop close. NOTE: closing without picking a decision leaves
  // the server-side gate parked — that's intentional, the operator can
  // refresh the WS to clear, or open another window where the same
  // pending re-fires on reconnect (the server re-emits on attach in
  // future phases; for now Phase 6a treats Esc as "I'll decide later"
  // which is the same as the spec's "Refuse & edit" focus default).
  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose });

  // Focus the safest default button (Deny once) on mount so screen
  // readers announce the modal and the operator's first Enter doesn't
  // grant trust by accident.
  const denyOnceRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    denyOnceRef.current?.focus();
  }, []);

  function decide(decision: 'trust' | 'trust_pinned' | 'deny_once' | 'deny_remember'): void {
    const msg: ClientMsg = {
      type: 'mcp_trust_decision',
      pendingId: pending.pendingId,
      serverName: pending.serverName,
      originPath: pending.originPath,
      decision,
      ...(pending.binarySha ? { binarySha: pending.binarySha } : {}),
    };
    send(msg);
    onClose();
  }

  const isHashChanged = pending.reason === 'hash_changed';
  const canPinHash = Boolean(pending.binarySha);
  const titleId = `mcp-tofu-title-${pending.pendingId}`;

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
            {isHashChanged ? 'MCP server binary changed' : 'Trust this MCP server?'}
          </h3>
          <span
            className={`gate-modal-reason gate-modal-reason-${pending.reason}`}
            aria-label={`reason: ${pending.reason.replace('_', ' ')}`}
          >
            {pending.reason === 'hash_changed' ? 'hash changed' : 'first seen'}
          </span>
        </header>
        <dl className="gate-modal-facts">
          <div className="gate-modal-fact">
            <dt>Server</dt>
            <dd>
              <code>{pending.serverName}</code>
            </dd>
          </div>
          <div className="gate-modal-fact">
            <dt>Declared in</dt>
            <dd>
              <code className="gate-modal-path">{pending.originPath}</code>
            </dd>
          </div>
          <div className="gate-modal-fact">
            <dt>Command</dt>
            <dd>
              <code>{pending.command || '(none)'}</code>
            </dd>
          </div>
          {pending.args && pending.args.length > 0 && (
            <div className="gate-modal-fact">
              <dt>Args</dt>
              <dd>
                <code>{pending.args.join(' ')}</code>
              </dd>
            </div>
          )}
          {pending.binarySha ? (
            <div className="gate-modal-fact">
              <dt>Binary sha256</dt>
              <dd>
                <code className="gate-modal-sha">{pending.binarySha}</code>
              </dd>
            </div>
          ) : (
            <div className="gate-modal-fact">
              <dt>Binary sha256</dt>
              <dd className="gate-modal-sha-absent">
                unresolvable (bare command — sha can&apos;t be pinned)
              </dd>
            </div>
          )}
          {isHashChanged && pending.previousSha && (
            <div className="gate-modal-fact">
              <dt>Previous sha256</dt>
              <dd>
                <code className="gate-modal-sha gate-modal-sha-prev">{pending.previousSha}</code>
              </dd>
            </div>
          )}
        </dl>
        <p className="gate-modal-help">
          {isHashChanged
            ? 'The binary at this path has a different sha than the one you previously trusted. Approve only if you expect the change (e.g. a legitimate upgrade).'
            : 'The Cebab session resolver has never seen this MCP server declaration before. Approve only if you intentionally added it.'}
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
            className="ghost-btn gate-modal-btn"
            onClick={() => decide('trust_pinned')}
            disabled={!canPinHash}
            aria-disabled={!canPinHash}
            title={canPinHash ? undefined : 'No binary sha to pin (bare command)'}
          >
            Trust &amp; pin hash
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
