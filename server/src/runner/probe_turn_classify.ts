/**
 * Pure scoring for the probe-cost measurement (`Cebab-6fax.40.1`).
 *
 * Split out of `probe_no_model_turn_smoke.ts` so the VERDICT is a function of
 * parsed transcript counts and observed stream events — nothing here spawns,
 * reads a file, waits, or otherwise depends on the machine — and can be pinned
 * with fixture JSONL in `probe_turn_classify.test.ts`. That test is the guard
 * the first attempt (PR #594, closed) never had: it scored a vacuous reading as
 * a pass, and because the scoring lived inline in a live-only smoke, nothing
 * automated would have reddened when the guard was wrong. Reverting any branch
 * below reddens a named case.
 *
 * WHY THE SCORING IS SUBTLE. The probe SIGTERMs the CLI just after `system/init`
 * (`runner/probe.ts` breaks there and aborts). So a probe transcript with NO
 * assistant entry is equally consistent with "no reply was billed" and "a reply
 * was billed but had not been flushed when we killed it". The `user` entry does
 * NOT rescue this: it is written when the request is DISPATCHED, so "user
 * present, no assistant" proves only that a reply was not RECORDED — a lower
 * bound, never proof that none was sent. Hence:
 *
 *   - a real reply RECORDED (an assistant entry with `output_tokens >= 1` that
 *     is not a synthetic `isApiErrorMessage` entry) is the FINDING: the probe
 *     spent a billed turn;
 *   - a positive stream signal that a request went OUT (`system/status`
 *     `'requesting'` observed after init) is ALSO the finding — the request was
 *     billed even if its reply lost the race with the SDK's ~2 s close grace;
 *   - a "no request" verdict is admissible ONLY on the opposite positive
 *     signal: the stream was read past init and carried no `'requesting'`;
 *   - everything else — a missing transcript, `user`-only with no stream
 *     signal, a 0-token entry, an API-error entry — is INCONCLUSIVE, never a
 *     pass. This is the branch PR #594 got wrong.
 *
 * The measured reality (2026-09-10, SDK 0.3.251): the CLI dispatches the request
 * ~2 ms after init and aborting at init does not cancel it, so a live run scores
 * `reply-recorded` or `request-sent` — exit 1 — not `no-request`.
 */

/**
 * Counts parsed from ONE session's transcript JSONL. Pure over the text; the
 * smoke reads the file and hands the string (or `null` when it is missing) to
 * `parseTranscript`.
 */
export type TranscriptCounts = {
  /** The transcript existed (a non-null string was parsed). A missing file is
   *  `false` and, on the probe side with no stream signal, INCONCLUSIVE. */
  present: boolean;
  /** Top-level `type:"user"` entries. Written from session start; on their own
   *  they show the transcript captured THIS session, not that a reply landed. */
  userEntries: number;
  /** Assistant entries with `output_tokens >= 1` that are NOT `isApiErrorMessage`
   *  — the marker of a real, billed model reply. */
  realAssistant: number;
  /** Assistant entries flagged `isApiErrorMessage: true` (e.g. "Please run
   *  /login"). Never a billed turn, so INCONCLUSIVE rather than a finding. */
  errorAssistant: number;
  /** Assistant entries that are neither: present but 0 output tokens and not an
   *  API error. Inconclusive on their own. */
  emptyAssistant: number;
  /** Summed `output_tokens` across the real assistant entries. */
  outputTokens: number;
};

/** What the live stream told us, past init. In the smoke these come from
 *  iterating the probe spawn; in the test they are fixture inputs. */
export type ProbeStreamSignals = {
  /** The probe spawn emitted a `system/init` — it got far enough to be measured
   *  at all. */
  initArrived: boolean;
  /** We observed a `system/status` with `status:"requesting"` after init: a
   *  positive signal the CLI dispatched an API request. */
  requestingObserved: boolean;
  /** We iterated the probe stream past init to its end (or a bounded window),
   *  so the ABSENCE of a `'requesting'` event is meaningful rather than "we
   *  stopped looking". Only this makes a `no-request` verdict admissible. */
  streamReadPastInit: boolean;
};

export type ProbeTurnVerdict =
  | 'control-failed'
  | 'probe-no-init'
  | 'reply-recorded'
  | 'request-sent'
  | 'no-request'
  | 'inconclusive';

export type ProbeClassification = {
  verdict: ProbeTurnVerdict;
  /** `true`/`false` when determined, `null` when the observation cannot decide
   *  it. Half of the "request sent: yes/no; reply recorded: yes/no" line. */
  requestSent: boolean | null;
  replyRecorded: boolean;
  /**
   * Distinct so a broken measurement is never mistaken for the known result
   * after an SDK bump:
   *   1 — the FINDING (the probe spent a billed turn),
   *   2 — INCONCLUSIVE or control/measurement failure,
   *   0 — the "no model turn" claim positively held.
   */
  exitCode: 0 | 1 | 2;
  /** One-line human summary for the smoke's verdict block. */
  summary: string;
};

/** Parse a session's transcript JSONL into the counts the verdict turns on.
 *  `null` means the file was missing; `''` means it existed but was empty. */
export function parseTranscript(jsonl: string | null): TranscriptCounts {
  const counts: TranscriptCounts = {
    present: jsonl !== null,
    userEntries: 0,
    realAssistant: 0,
    errorAssistant: 0,
    emptyAssistant: 0,
    outputTokens: 0,
  };
  if (jsonl === null) return counts;
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: {
      type?: string;
      isApiErrorMessage?: boolean;
      message?: { usage?: { output_tokens?: number } };
    };
    try {
      o = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (o?.type === 'user') {
      counts.userEntries += 1;
    } else if (o?.type === 'assistant') {
      const out = Number(o?.message?.usage?.output_tokens ?? 0) || 0;
      if (o?.isApiErrorMessage === true) {
        counts.errorAssistant += 1;
      } else if (out >= 1) {
        counts.realAssistant += 1;
        counts.outputTokens += out;
      } else {
        counts.emptyAssistant += 1;
      }
    }
  }
  return counts;
}

function make(
  verdict: ProbeTurnVerdict,
  requestSent: boolean | null,
  replyRecorded: boolean,
  exitCode: 0 | 1 | 2,
  summary: string,
): ProbeClassification {
  return { verdict, requestSent, replyRecorded, exitCode, summary };
}

/**
 * Score one measurement. Order is load-bearing:
 *   1. the control must prove a real turn is visible as a real assistant entry,
 *      or nothing below is a measurement;
 *   2. the probe must have reached init;
 *   3. a recorded real reply is the finding;
 *   4. an observed `'requesting'` is the finding even with no recorded reply;
 *   5. `no-request` needs the opposite positive signal AND no API-error noise;
 *   6. anything else is a lower bound — INCONCLUSIVE, never a pass.
 */
export function classifyProbeTurn(input: {
  control: TranscriptCounts;
  probe: TranscriptCounts;
  stream: ProbeStreamSignals;
}): ProbeClassification {
  const { control, probe, stream } = input;

  if (control.realAssistant < 1) {
    return make(
      'control-failed',
      null,
      false,
      2,
      'control turn left no real assistant entry — the marker the probe assertion ' +
        'looks for is not visible, so nothing below is a measurement',
    );
  }

  if (!stream.initArrived) {
    return make(
      'probe-no-init',
      null,
      false,
      2,
      'probe produced no system/init — a broken measurement, not a result',
    );
  }

  if (probe.realAssistant >= 1) {
    return make(
      'reply-recorded',
      true,
      true,
      1,
      `probe recorded a real reply (assistant=${probe.realAssistant}, ` +
        `outputTokens=${probe.outputTokens}) — it spent a billed turn`,
    );
  }

  if (stream.requestingObserved) {
    return make(
      'request-sent',
      true,
      false,
      1,
      "probe dispatched a request (system/status 'requesting' after init); its reply " +
        'was not recorded before SIGTERM, but the request was billed',
    );
  }

  if (stream.streamReadPastInit && probe.errorAssistant === 0) {
    return make(
      'no-request',
      false,
      false,
      0,
      "no request observed: the stream was read past init with no 'requesting' — the " +
        "'no model turn' claim holds for this run",
    );
  }

  return make(
    'inconclusive',
    null,
    false,
    2,
    'reply not recorded, and no positive signal that a request was or was not sent ' +
      '(missing transcript, user-only, a 0-token entry, or an API-error entry) — a ' +
      'lower bound, never a pass',
  );
}
