import type { SessionPermissionMode } from '@cebab/shared/protocol';
import { CardRadioGroup, type CardRadioOption } from './CardRadioGroup';

/**
 * Choose the permission mode a project's NEW sessions start in (Cebab-ws0.4).
 *
 * WHY A PRE-SESSION CONTROL AT ALL. The mode was derived and never chosen: a
 * fresh session got `trusted ? 'acceptEdits' : 'default'`, and the in-session
 * pill only moves once a turn is already running. So the operator could not
 * decide how the FIRST turn behaves — the one most likely to do something they
 * wanted to watch.
 *
 * NULL IS NOT A MODE. The first option stores `null`, which means "derive from
 * Trust" — exactly what every project did before this existed. Choosing it and
 * never choosing must produce the same spawn, and they only do if the column
 * is null both times.
 *
 * THE LABELS DEPEND ON TRUST, which is the part that is easy to get wrong.
 * `acceptEdits` means "auto-allow everything" on a trusted project and
 * "auto-allow file edits, Bash still asks" on an untrusted one — a single
 * fixed label is wrong on one of the two. That asymmetry is real: it is
 * `shouldAutoAllow`'s table, and describing it inaccurately here is the same
 * defect class Cebab-ws0.14 just cleaned up one layer down.
 *
 * What this control does NOT do is change what the project LOADS. Trust alone
 * decides `settingSources`, and therefore whether the project's own
 * `.claude/settings.json`, `.mcp.json` and `CLAUDE.md` apply. The copy says so,
 * because a tooltip claiming otherwise had to be removed once already (#364).
 */

export type PermissionModePickerProps = {
  /** Current stored choice; `null` = follow Trust. */
  value: SessionPermissionMode | null;
  onChange: (mode: SessionPermissionMode | null) => void;
  /** The project's Trust flag — decides what the options mean, not just their wording. */
  trusted: boolean;
  disabled?: boolean;
};

/**
 * Exported for tests: the trust-dependence is the whole design, and asserting
 * it through a rendered DOM would test React rather than the decision.
 */
export function permissionModeOptions(
  trusted: boolean,
): CardRadioOption<SessionPermissionMode | null>[] {
  return [
    {
      key: 'inherit',
      value: null,
      label: 'Follow the project’s Trust setting',
      description: trusted
        ? 'Trusted, so sessions start by auto-allowing every tool.'
        : 'Untrusted, so sessions start by asking for every tool.',
    },
    {
      key: 'default',
      value: 'default',
      label: 'Ask before every tool',
      description: 'Every tool call shows a permission card, including file edits.',
    },
    {
      key: 'acceptEdits',
      value: 'acceptEdits',
      label: trusted ? 'Auto-allow every tool' : 'Auto-allow file edits',
      description: trusted
        ? 'Bash, edits, network — all run without a card.'
        : 'Edit, Write and NotebookEdit run without a card. Bash and other tools still ask.',
    },
  ];
}

export function PermissionModePicker(props: PermissionModePickerProps) {
  return (
    <div className="permission-mode-picker">
      <CardRadioGroup
        options={permissionModeOptions(props.trusted)}
        value={props.value}
        onChange={props.onChange}
        ariaLabel="Starting permission mode"
        testIdPrefix="start-mode-option"
        {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
      />
      <p className="permission-mode-picker-hint">
        Applies when a new session starts. A session already running keeps its current mode — use
        the permissions control in the chat header for that. This changes what asks, not what the
        project loads; Trust alone decides that.
      </p>
    </div>
  );
}
