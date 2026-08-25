/**
 * `Cebab-vie.5` — the reason vocabulary the per-agent control verbs share.
 *
 * WHY IT IS ONE FILE NOW. It was three: `MuteReasonModal`, `PauseReasonModal`
 * and `KickModal` each declared their own `REASON_OPTIONS`, and
 * `PauseReasonModal`'s header justified that — "the lists are short, identical
 * strings show up in one place per file (and grep-able for code review), and
 * the inlining keeps each modal a single-file read."
 *
 * Measured before moving them: the premise had already failed. Kick's
 * `topology_repair` help had diverged from the other two and nothing noticed,
 * because "identical" was an assertion nobody was checking. The merged wording
 * below keeps Kick's concrete sentence and Mute/Pause's "this is the neutral
 * choice" signal, which is the part an operator picking a reason under time
 * pressure actually needs.
 *
 * `reasonList_single_definition.test.ts` derives from the source that no modal
 * declares a list of its own, so a fourth copy cannot appear quietly.
 *
 * THE RULE FOR `help`: it describes the OBSERVATION that prompted the
 * operator, never the outcome of the verb. That is what lets one vocabulary
 * serve five verbs, and it is what makes the reason valid audit data — the
 * `safety_audit` row records why the operator acted, not what the mechanism
 * achieved. `forensics` was the one entry that broke the rule, and
 * `Cebab-vie.5` is largely about that; see its `caveat`s.
 */
import type { ControlReasonCode } from '@cebab/shared/protocol';

export type ReasonOption = {
  code: ControlReasonCode;
  label: string;
  /** The observation that prompted the operator. Never an outcome. */
  help: string;
};

export const CONTROL_REASON_OPTIONS: readonly ReasonOption[] = [
  {
    code: 'runaway_loop',
    label: 'Runaway loop',
    help: 'Agent stuck retrying or oscillating without progress.',
  },
  {
    code: 'off_task',
    label: 'Off-task',
    help: "Agent drifted from the relayed request and isn't coming back.",
  },
  {
    code: 'cost_ceiling',
    label: 'Cost ceiling',
    help: 'Cumulative spend or token use is climbing past acceptable bounds.',
  },
  {
    code: 'tool_misuse',
    label: 'Tool misuse',
    help: 'Agent invoked a tool in a way that risks harm or violates policy.',
  },
  {
    code: 'incorrect_output',
    label: 'Incorrect output',
    help: "Agent's most recent answer is wrong and can't be salvaged.",
  },
  {
    code: 'forensics',
    label: 'Forensics',
    help: 'Need to freeze this agent to inspect its state without further mutation.',
  },
  {
    code: 'topology_repair',
    label: 'Topology repair',
    help: "Reshaping the participant set; this agent isn't needed for the current task — the neutral choice.",
  },
  {
    code: 'other',
    label: 'Other',
    help: 'Requires a free-text explanation in the field below.',
  },
];
