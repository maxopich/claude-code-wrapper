import { useEffect, useRef } from 'react';
import type { ManagedCopySkip, ManagedCopyPreflight } from '@cebab/shared/protocol';
import { useModalSurface } from '../useModalSurface';

/**
 * Cebab-ws0.9 — confirm copying an agent into Cebab-managed space.
 *
 * WHY A MEASURED NUMBER BEFORE THE BUTTON. The operator chose to copy
 * everything, so a gigabyte is the ordinary case rather than the exotic one.
 * A confirm dialog that could only say "this will copy the project" would be
 * asking for consent to something it had not described.
 *
 * WHY SKIPS ARE NAMED, NOT COUNTED AWAY. A snapshot that quietly dropped a
 * symlink is not the snapshot it claims to be. Symlinks that would point back
 * out of the copy are the interesting ones — they are refused on purpose, and
 * the operator should be able to see which.
 */

export type ManagedCopyState = {
  projectId: number;
  status: 'measuring' | 'ready' | 'copying' | 'done';
  preflight: ManagedCopyPreflight | null;
  progress: { files: number; bytes: number; totalFiles: number; totalBytes: number } | null;
  result:
    | {
        ok: true;
        managedProjectId: number;
        name: string;
        files: number;
        bytes: number;
        symlinks: number;
        skips: ManagedCopySkip[];
        skipsTruncated: number;
      }
    | { ok: false; error: string }
    | null;
};

export type ManagedCopyModalProps = {
  projectName: string;
  state: ManagedCopyState;
  onConfirm: () => void;
  onClose: () => void;
};

/** Bytes as something a person reads. Binary units, because that is what a disk reports. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Operator-facing wording for why something was left out. */
export function skipLabel(reason: ManagedCopySkip['reason']): string {
  switch (reason) {
    case 'symlink_escapes':
      return 'link out of the project — not copied, so the copy stays independent';
    case 'not_regular':
      return 'not a regular file (pipe, socket or device)';
    case 'symlink_unsupported':
      return 'link could not be recreated on this system';
    case 'excluded_vcs':
      return 'version control data — left out, so the copy cannot push to the original';
    case 'permissions_unenforced':
      return 'copied, but its permissions could not be tightened';
  }
}

export function ManagedCopyModal({
  projectName,
  state,
  onConfirm,
  onClose,
}: ManagedCopyModalProps) {
  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose });
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = `managed-copy-title-${state.projectId}`;

  const preflight = state.preflight;
  const canCopy = state.status === 'ready' && preflight !== null && !preflight.overCap;

  useEffect(() => {
    // Focus the safe control first. Unlike the authority preflight, the primary
    // action here writes gigabytes — defaulting focus onto it invites a Return
    // keypress that was meant for the dialog that had focus a moment ago.
    closeBtnRef.current?.focus();
  }, []);

  return (
    <div
      ref={overlayRef}
      className="gate-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={onBackdropMouseDown}
    >
      <div className="gate-modal modal-surface managed-copy-modal">
        <header className="gate-modal-header">
          <h3 id={titleId} className="gate-modal-title">
            Copy {projectName} into Cebab
          </h3>
        </header>
        <p className="gate-modal-help">
          Cebab makes an independent copy in its own folder and runs the agent from there. The
          original is never touched, and there is no link between the two — copy again later to pick
          up changes.
        </p>

        {state.status === 'measuring' && (
          <p className="gate-modal-help managed-copy-measuring">Measuring the project…</p>
        )}

        {preflight === null && state.status !== 'measuring' && (
          <p className="gate-modal-help managed-copy-error">
            That project could not be measured — it may have been removed.
          </p>
        )}

        {preflight && (
          <div className="managed-copy-facts" data-testid="managed-copy-facts">
            <p className="managed-copy-size">
              {preflight.overCap ? 'More than ' : ''}
              <strong>{formatSize(preflight.bytes)}</strong> across{' '}
              <strong>{preflight.files.toLocaleString('en')}</strong> files
            </p>
            {preflight.overCap && (
              <p className="gate-modal-help managed-copy-error">
                That is past the limit Cebab will copy ({formatSize(preflight.maxBytes)} or{' '}
                {preflight.maxFiles.toLocaleString('en')} files). Nothing has been written.
              </p>
            )}
            {preflight.largest.length > 0 && (
              <ul className="managed-copy-largest">
                {preflight.largest.map((entry) => (
                  <li key={entry.name}>
                    <span className="managed-copy-largest-name">{entry.name}</span>
                    <span className="managed-copy-largest-size">{formatSize(entry.bytes)}</span>
                  </li>
                ))}
              </ul>
            )}
            {preflight.credentialFiles.length > 0 && (
              <div className="managed-copy-credentials" data-testid="managed-copy-credentials">
                <p className="gate-modal-help managed-copy-credentials-lead">
                  <span className="managed-copy-glyph" aria-hidden="true">
                    ⚠
                  </span>{' '}
                  These files look like they hold live credentials. They are copied as they are, in
                  a folder only your account can open. Cebab never reads what is in them.
                </p>
                <ul>
                  {preflight.credentialFiles.map((rel) => (
                    <li key={rel}>
                      <span className="managed-copy-skip-path">{rel}</span>
                    </li>
                  ))}
                </ul>
                {preflight.credentialFilesTruncated > 0 && (
                  <p className="gate-modal-help">
                    …and {preflight.credentialFilesTruncated.toLocaleString('en')} more
                  </p>
                )}
              </div>
            )}
            {preflight.skips.length > 0 && (
              <div className="managed-copy-skips" data-testid="managed-copy-skips">
                <p className="gate-modal-help">Not copied:</p>
                <ul>
                  {preflight.skips.map((skip) => (
                    <li key={`${skip.rel}:${skip.reason}`}>
                      <span className="managed-copy-skip-path">{skip.rel}</span>
                      <span className="managed-copy-skip-reason">{skipLabel(skip.reason)}</span>
                    </li>
                  ))}
                </ul>
                {preflight.skipsTruncated > 0 && (
                  <p className="gate-modal-help">
                    …and {preflight.skipsTruncated.toLocaleString('en')} more
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {state.status === 'copying' && (
          <p className="gate-modal-help managed-copy-progress" role="status">
            {state.progress
              ? `Copied ${state.progress.files.toLocaleString('en')} of ${state.progress.totalFiles.toLocaleString('en')} files…`
              : 'Copying…'}
          </p>
        )}

        {state.status === 'done' && state.result && (
          <p
            className={`gate-modal-help ${state.result.ok ? 'managed-copy-done' : 'managed-copy-error'}`}
            role="status"
          >
            {state.result.ok
              ? `Copied ${state.result.files.toLocaleString('en')} files. The copy is in your sidebar as ${state.result.name}.`
              : state.result.error}
          </p>
        )}

        <div className="gate-modal-buttons">
          <button
            type="button"
            ref={closeBtnRef}
            className="ghost-btn gate-modal-btn"
            onClick={onClose}
          >
            {state.status === 'done' ? 'Done' : 'Cancel'}
          </button>
          {state.status !== 'done' && (
            <button
              type="button"
              ref={confirmBtnRef}
              className="ghost-btn gate-modal-btn gate-modal-btn-primary"
              onClick={onConfirm}
              disabled={!canCopy}
            >
              {state.status === 'copying' ? 'Copying…' : 'Copy'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
