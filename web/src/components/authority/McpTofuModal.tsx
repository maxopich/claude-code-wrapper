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
//     hash_changed, "MCP server declaration changed" for declaration_changed,
//     "MCP server script changed" for script_changed)
//   - Body: server name, originPath, command, args, current binarySha,
//     previousSha (when hash_changed), previously-approved vs now-declares
//     (when declaration_changed — Cebab-rxg), the per-file was/now list (when
//     script_changed — Cebab-1af), reason chip
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
  send: (msg: ClientMsg) => boolean;
  /** Pop the queue. Called after a decision has gone out. */
  onClose: () => void;
  /**
   * Register W28: back out without deciding — sends `cancel_gate`, which
   * unparks the spawn without recording anything. Bound to Escape and the
   * backdrop below.
   */
  onCancel: () => void;
}) {
  const { pending, send, onClose, onCancel } = props;
  // Esc / backdrop close. This used to say closing without deciding "leaves
  // the server-side gate parked — that's intentional", justified by two
  // things: that the operator can refresh the WS to clear it, and that "the
  // server re-emits on attach in future phases".
  //
  // Register W28: only the first is true. PR #310's drain made the refresh
  // escape real; nothing re-emits a pending gate on attach, then or now. So
  // the fallback the comment leaned on never arrived, and dismissing left the
  // spawn parked until the socket dropped. Esc now CANCELS — same
  // reject-don't-resolve path, nothing recorded, asked again next time.
  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose: onCancel });

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
    // W29: only close once the decision has actually gone out. A drop on a
    // reconnecting socket used to dismiss the modal anyway, taking the
    // operator's only route back to this gate with it.
    if (!send(msg)) return;
    onClose();
  }

  const isHashChanged = pending.reason === 'hash_changed';
  // Cebab-rxg: the server was approved before at this name+origin, but for a
  // DIFFERENT program. Distinct from hash_changed on purpose — the reproduced
  // attack swapped `node <script>` for another script and moved no hash at
  // all, because a bare command has none to move.
  const isDeclChanged = pending.reason === 'declaration_changed';
  // Cebab-1af: the declaration is IDENTICAL to the approved one here — that is
  // what makes this its own reason rather than a variant of the two above.
  // Showing a before/after of the declaration would show two identical lines,
  // so the files carry the whole message.
  const isScriptChanged = pending.reason === 'script_changed';
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
            {isDeclChanged
              ? 'MCP server declaration changed'
              : isScriptChanged
                ? 'MCP server script changed'
                : isHashChanged
                  ? 'MCP server binary changed'
                  : 'Trust this MCP server?'}
          </h3>
          <span
            className={`gate-modal-reason gate-modal-reason-${pending.reason}`}
            aria-label={`reason: ${pending.reason.replaceAll('_', ' ')}`}
          >
            {isDeclChanged
              ? 'declaration changed'
              : isScriptChanged
                ? 'script changed'
                : isHashChanged
                  ? 'hash changed'
                  : 'first seen'}
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
          {isDeclChanged && pending.previousCommand !== undefined && (
            <div className="gate-modal-fact">
              <dt>Previously approved</dt>
              <dd>
                <code className="gate-modal-decl-prev">
                  {[pending.previousCommand, ...(pending.previousArgs ?? [])].join(' ') || '(none)'}
                </code>
              </dd>
            </div>
          )}
          {isDeclChanged && (
            <div className="gate-modal-fact">
              <dt>Now declares</dt>
              <dd>
                <code>{[pending.command, ...(pending.args ?? [])].join(' ') || '(none)'}</code>
              </dd>
            </div>
          )}
          {isScriptChanged &&
            (pending.changedScripts ?? []).map((f) => (
              <div className="gate-modal-fact" key={f.path}>
                <dt>Script changed</dt>
                <dd>
                  <code className="gate-modal-path">{f.path}</code>
                  <div className="gate-modal-script-shas">
                    <code className="gate-modal-sha gate-modal-sha-prev">{f.previousSha}</code>
                    <span aria-hidden="true">→</span>
                    <code className="gate-modal-sha">{f.sha}</code>
                  </div>
                </dd>
              </div>
            ))}
        </dl>
        <p className="gate-modal-help">
          {isDeclChanged
            ? 'You approved this server name before, but it declared a different program then. Approving here trusts the new one. Approve only if you made this change yourself — a declaration you did not edit that changed anyway is how an approved name gets pointed at something else.'
            : isScriptChanged
              ? 'This declaration is unchanged from the one you approved — the file it runs is not. Nothing in the config moved, so a diff of it shows nothing. Approve only if you edited or upgraded this file yourself.'
              : isHashChanged
                ? 'The binary at this path has a different sha than the one you previously trusted. Approve only if you expect the change (e.g. a legitimate upgrade).'
                : 'The Cebab session resolver has never seen this MCP server declaration before. Approve only if you intentionally added it.'}
        </p>
        {/*
          Register H04. Until 2026-08-02 Deny recorded a decision and the
          binary loaded anyway — the operator was never told. It now blocks the
          server from starting, so this line says plainly what the buttons do.
          If the enforcement ever regresses, this copy has to change with it.
        */}
        <p className="gate-modal-help gate-modal-help-secondary">
          Either Deny stops this server from starting for the run being gated, and withholds its
          tools. <strong>Deny once</strong> re-asks on your next connection;{' '}
          <strong>Deny &amp; remember</strong> persists the decision and applies it silently from
          then on. Every choice is recorded in the audit log.
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
