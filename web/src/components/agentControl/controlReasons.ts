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
 * `scripts/controlReasonVocabulary.test.mjs` derives from the source that no
 * modal declares a list of its own, so a fourth copy cannot appear quietly.
 * It lives in `scripts/` rather than beside this file because it reads three
 * component sources plus this one, and `web/tsconfig.json` sets `types: []`,
 * so a web-side test cannot open a file — see `docs/source-gates.md`.
 *
 * THE RULE FOR `help`: it describes the OBSERVATION that prompted the
 * operator, never the outcome of the verb. That is what lets one vocabulary
 * serve five verbs, and it is what makes the reason valid audit data — the
 * `safety_audit` row records why the operator acted, not what the mechanism
 * achieved. `forensics` was the one entry that broke the rule, and
 * `Cebab-vie.5` is largely about that; see its `caveat`s.
 */
import type { ControlReasonCode } from '@cebab/shared/protocol';

/** The five per-agent control verbs that render this picker. */
export type ControlVerb = 'mute' | 'unmute' | 'pause' | 'resume' | 'kick';

export type ReasonOption = {
  code: ControlReasonCode;
  label: string;
  /** The observation that prompted the operator. Never an outcome. */
  help: string;
  /**
   * What THIS verb will not do about that observation. Present only where the
   * verb cannot deliver the remedy the reason implies — see `CAVEATS`.
   */
  caveat?: string;
};

const BASE_OPTIONS: readonly ReasonOption[] = [
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
    // `Cebab-vie.5`: this used to read "Need to freeze this agent to inspect
    // its state without further mutation" — the one entry that stated a
    // CAPABILITY rather than an observation, and a capability no verb in v1
    // has. Worse on Mute and Pause, which promised two things neither does:
    // the forensic BUNDLE is kick-only (`captureKickForensics` writes the
    // `controllability_forensics` row keyed to the kick's audit row). The want
    // is real and stays; what it gets is now in the caveats.
    help: "You want this agent's state captured for later review.",
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

/**
 * Per-verb corrections, keyed by reason.
 *
 * THIS IS THE ALTERNATIVE TO FILTERING THE VOCABULARY, which is the other fix
 * `Cebab-vie.5` floated and the wrong one. "I muted it because spend was
 * climbing" is a true and useful `safety_audit` record even though mute does
 * not reduce spend — dropping `cost_ceiling` from mute's list would destroy
 * forensic information to fix a copy bug. A caveat corrects the operator's
 * inference instead of deleting their reason.
 *
 * `unmute` and `resume` have no entries, deliberately rather than by omission:
 * they REMOVE a restriction, so there is no outcome to disclaim. The reasons
 * there record why the operator is lifting the control.
 *
 * Absent for `off_task`, `incorrect_output`, `topology_repair` and `other`
 * under every verb: each verb is a reasonable response to those, so there is
 * nothing to correct. A caveat everywhere would be wallpaper within a week.
 *
 * Every sentence here is a claim about the code, and each is checkable:
 * mute is outbound-only (one `mutedSet.has(ev.source)` read in the router; the
 * deliver branches consult nothing and `bus/runner.ts` has no `mute`
 * reference); `AgentRunner.pause` gates the NEXT turn and documents "current
 * in-flight turn NOT cancelled"; kick is pinned to `mode: 'drain'` because the
 * server answers `hard_kill_unsupported_v1`.
 */
const CAVEATS: Partial<Record<ControlVerb, Partial<Record<ControlReasonCode, string>>>> = {
  mute: {
    runaway_loop:
      'Mute does not stop the loop — it stops you seeing it. The agent keeps being woken and keeps spending.',
    cost_ceiling:
      'Mute does not reduce spend: the agent keeps receiving messages and keeps running turns.',
    tool_misuse: 'Mute does not block tool calls. They keep running, unmediated.',
    forensics: 'Mute freezes nothing, and captures no bundle — only Kick captures one.',
  },
  pause: {
    runaway_loop:
      'The turn already running is not interrupted; the gate applies to the next one, so a loop inside the current turn keeps going.',
    cost_ceiling:
      'The turn already running keeps spending until it ends. Only the next turn is held.',
    tool_misuse:
      'The turn already running keeps its remaining tool calls; only the next turn is held.',
    forensics:
      'A queued turn is held, but a turn already running is not frozen — and no bundle is captured. Only Kick captures one.',
  },
  kick: {
    runaway_loop:
      'The turn already running drains rather than aborting, so a loop inside it runs until that turn ends.',
    cost_ceiling: 'The turn already running keeps spending until it drains.',
    tool_misuse:
      'The turn already running keeps its remaining tool calls while it drains. There is no hard kill in v1.',
    forensics:
      'The bundle is captured at the moment of the kick — but the turn already running is not frozen; it drains.',
  },
};

/**
 * The eight reasons, with this verb's caveats attached.
 *
 * Always all eight, for every verb. A per-verb filter is the edit to resist —
 * see `CAVEATS` for why the reason is audit data and the caveat is the fix.
 */
export function reasonOptionsFor(verb: ControlVerb): readonly ReasonOption[] {
  const forVerb = CAVEATS[verb];
  return BASE_OPTIONS.map((opt) => {
    const caveat = forVerb?.[opt.code];
    return caveat === undefined ? opt : { ...opt, caveat };
  });
}

/**
 * `Cebab-vie.5`: the always-true sentence for a verb, shown whatever reason is
 * picked.
 *
 * It exists because the caveats above cannot cover the commonest path. Every
 * modal defaults to `topology_repair`, which has no caveat and should not have
 * one — so an operator who takes the default and submits would otherwise be
 * told nothing about what keeps running.
 *
 * The second clause is the `Cebab-vie.17` correction, and it is the part that
 * was previously true nowhere on screen. When this bead was filed, a bus hop
 * really was an unbounded agent turn; #387 shipped `AgentRunnerDeps.maxTurns`
 * (floor `config.maxTurns`, operator-settable as Settings → "Default max
 * turns"), so a runaway loop inside a hop IS bounded now — just not by any of
 * these verbs. Telling an operator "nothing stops it" would be the new wrong
 * answer; naming the levers that do exist is the right one.
 *
 * `unmute` and `resume` are absent for the same reason they carry no caveats.
 */
export const VERB_LIMITS: Partial<Record<ControlVerb, string>> = {
  mute:
    'Mute changes what you hear, not what the agent does — it keeps receiving, keeps being woken for new turns, and keeps running tools. ' +
    'No per-agent verb aborts a running turn: the per-hop turn cap (Settings → Default max turns) ends the hop, and Stop ends the whole session.',
  pause:
    'The turn already running is not interrupted; the gate applies to the next one. ' +
    'No per-agent verb aborts a running turn: the per-hop turn cap (Settings → Default max turns) ends the hop, and Stop ends the whole session.',
  kick:
    'The turn already running is not interrupted — it drains in the background, and there is no hard kill in v1. ' +
    'The per-hop turn cap (Settings → Default max turns) ends the hop, and Stop ends the whole session.',
};
