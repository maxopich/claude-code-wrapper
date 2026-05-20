import type { SessionPermissionMode } from '@cebab/shared/protocol';
import { trustChipState, type TrustChipState } from '../store';

const LABEL: Record<TrustChipState, string> = {
  'trusted-all': 'Trusted · auto-allow ALL',
  'untrusted-edits': 'Untrusted · auto-allow edits',
  'untrusted-ask': 'Untrusted · ask every tool',
};

const VARIANT: Record<TrustChipState, 'ok' | 'warn'> = {
  // Trusted = operator vouched for everything → warn-amber. Trust auto-allows
  // dangerous tools (Bash, rm) too, so the chip is a "you said yes to all of
  // this" reminder, NOT a victory lap.
  'trusted-all': 'warn',
  // Both untrusted states use ok-green — the difference vs untrusted-ask is
  // carried in the trailing scope phrase, not color. Untrusted is the safer
  // baseline either way.
  'untrusted-edits': 'ok',
  'untrusted-ask': 'ok',
};

const TOOLTIP: Record<TrustChipState, string> = {
  'trusted-all':
    'Trusted project: every tool call auto-allows (Bash, Edit, Write, dangerous shell — all). ' +
    'The project also loads its own .claude/settings.json + CLAUDE.md (settingSources: user+project+local). ' +
    'To change: toggle Trust off in the sidebar.',
  'untrusted-edits':
    'Untrusted project + auto-edits mode: file edits auto-allow (Edit, Write, NotebookEdit). ' +
    'Bash and other tools still ask. Project-scope settings.json + CLAUDE.md are NOT loaded ' +
    '(settingSources: user only). To change scope: toggle the permissions pill, or Trust in the sidebar.',
  'untrusted-ask':
    'Untrusted project + ask mode: every tool call shows a permission card. ' +
    'Project-scope settings.json + CLAUDE.md are NOT loaded (settingSources: user only). ' +
    'To change: toggle the permissions pill to auto-edits, or Trust on in the sidebar.',
};

export function ChatHeaderChip(props: {
  trusted: boolean;
  mode: SessionPermissionMode;
}) {
  const state = trustChipState(props.trusted, props.mode);
  const label = LABEL[state];
  return (
    <span
      className={`trust-chip trust-chip-${VARIANT[state]}`}
      title={TOOLTIP[state]}
      aria-label={label}
    >
      {label}
    </span>
  );
}
