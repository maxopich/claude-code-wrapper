/**
 * Live measurement: what system prompt does a Cebab turn actually run with?
 *
 *   npm --workspace server exec tsx src/system_prompt_smoke.ts
 *
 * WHY THIS IS A SMOKE AND NOT A TEST. It spawns the real `claude` CLI and
 * spends about ten short model turns, so it needs the operator's credentials
 * and costs quota; CI has neither. Same reason `live_smoke.ts` and
 * `mcp_scope_smoke.ts` are scripts.
 *
 * WHY IT EXISTS. `Cebab-ws0.15` attaches a short factual note about unhealthy
 * MCP servers to the system prompt, and `Cebab-0fgx` attaches an untrusted
 * project's CLAUDE.md the same way. Both are only safe because the text is
 * APPENDED to Claude Code's preset (`Cebab-6s27`) rather than replacing it, and
 * both are only useful because they are recomputed on every turn. Each of
 * those is a claim about SDK behaviour, not about our code, so it is measured
 * here instead of trusted, and re-measured whenever the SDK or the CLI moves.
 * Nothing else in this repo spawns a real CLI and inspects what it was told.
 *
 * HOW IT DISCRIMINATES. Asking "what is your system prompt?" would need the
 * model to introspect its own instructions, which it cannot do reliably.
 * Asking for the working directory does not: that fact reaches the model only
 * through the preset's dynamic sections, so it is present or it is not, and
 * the model can answer from what it was given.
 *
 * The SENTINEL case is the positive control, and it is not optional. Without
 * it, a CLI that ignored `systemPrompt` entirely would report UNKNOWN for every
 * case and read as a clean confirmation of the very thing being tested
 * (`project_gates_pass_vacuously`).
 *
 * EVERY ROW THAT CLAIMS TO BE CEBAB GOES THROUGH `buildSdkOptions` UNCHANGED.
 * A row that hand-writes the preset measures a second implementation of the
 * thing under test — and the resume row below did exactly that: it passed a
 * plain string, which Cebab never ships, so it could not see an option Cebab
 * sets on the preset. Only the rows that are deliberately NOT Cebab's posture
 * (the string override, the omitted key, the recorded default) modify the
 * options, and each says so in its label.
 *
 * THE RESUME ROWS, and why they now fail the run. Cebab runs one subprocess
 * per message with `--resume`, and recomputes its append every turn. SDK
 * 0.3.271 added `systemPrompt.snapshot`; omitted, it means the CLI records the
 * prompt on a session's first request and re-sends that record on every
 * resume, so a new append is ignored until compaction. Cebab sets
 * `snapshot: false`. Three resume rows pin that from three sides:
 *
 *   resumed, as shipped        — the claim itself. MUST bind, or the MCP note,
 *                                 the project rules and the preset's git
 *                                 status freeze at the first message.
 *   recorded first, shipped on resume
 *                              — a session whose first turn WAS recorded (one
 *                                 started by a build without the fix)
 *                                 un-freezes. MUST bind.
 *   recorded both turns        — the control that makes `snapshot: false` the
 *                                 cause rather than a bystander: the SDK default
 *                                 should NOT bind. It is observational, because
 *                                 recording is rolling out per account; where it
 *                                 is off, this row binds too and the run says it
 *                                 cannot tell the two apart on this account.
 *
 * Each resume row asks arithmetic, not the cwd question, and a fresh-session
 * control asks the same thing with the same append. See MATH below for why.
 *
 * Measured 2026-08-20, SDK 0.3.220, CLI 2.1.212 (the original rows):
 *
 *   omitted (ordinary project turn) → "UNKNOWN"
 *   explicit ''                  → "UNKNOWN"
 *   preset 'claude_code'         → "/private/var/folders/.../cebab-sysprompt-cwd-yRXlEm"
 *   sentinel string              → "PINEAPPLE"
 *   resumed + new prompt         → "KUMQUAT"
 *   fresh + same new prompt      → "KUMQUAT"
 *
 * Measured 2026-09-23, SDK 0.3.271 (before `snapshot: false`): every first-turn
 * row as expected, and the resume row answered "4" (2 of 2 runs) where 0.3.251
 * answered "KUMQUAT" in the same hour. The same run with `snapshot: false`
 * binds, including when only the resumed turn carries it.
 *
 * THE RESUME ROW COST A SECOND RUN ONCE, AND THE FIRST ONE LIED. It originally
 * re-asked QUESTION on the resumed turn and came back "UNKNOWN", which reads
 * as a clean "resume ignores the new system prompt" — and would have moved the
 * note to session-creation-only, permanently stale for the rest of a session.
 * The real cause was that the resumed turn already had "Q: ... A: UNKNOWN" in
 * context and simply repeated itself. The two explanations are indistinguishable
 * whenever the probe re-asks a question the transcript already answers. Hence
 * MATH below, and the fresh-session control beside it. Keep both: a probe whose
 * negative result has a second, duller explanation is not a measurement. For
 * the same reason every resume row resumes its OWN session: resuming one
 * session twice would put the first resume's answer in the second's context.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

// Belt and braces: nothing below imports `db.ts`, but a future edit that adds
// a `translate()` call would, and `config.ts` reads CEBAB_DATA_DIR once at
// module init. Setting it before the dynamic import is the pattern
// `mcp_scope_smoke.ts` uses and the reason it never touches the real ~/.cebab.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-sysprompt-home-'));
process.env.CEBAB_DATA_DIR = path.join(tmpRoot, '.cebab');
const { buildSdkOptions } = await import('./runner/claude.js');
const { query } = await import('@anthropic-ai/claude-agent-sdk');

const SENTINEL = 'PINEAPPLE';
/** The append probe's marker. A word no ordinary answer contains, so its
 *  presence can only come from the appended text having reached the model. */
const APPEND_MARKER = 'MARMALADE';
const RESUME_MARKER = 'KUMQUAT';

/** The same phrasing for both markers: it is the one the append row has
 *  measured the model following, and an append (unlike a string override)
 *  sits beside the preset, so "begin with" is obeyed where "reply with only"
 *  competes with everything else the preset says. */
const appendSaying = (marker: string): string =>
  `Always begin your reply with the single token ${marker}, then answer normally.`;

/** Answerable only from the preset's dynamic sections. "Do not use any tools"
 *  matters: with a Bash call the model could discover the cwd regardless, which
 *  would make every case report the path and the measurement say nothing. */
const QUESTION =
  'Reply with ONLY your current working directory as an absolute path. ' +
  'If your instructions have not told you a working directory, reply with ONLY ' +
  'the word UNKNOWN. Do not use any tools. Do not explain.';

/**
 * The resume probe asks a DIFFERENT question, and that is the whole point.
 *
 * A resumed turn already carries the previous turn's Q&A, so re-asking QUESTION
 * makes "the new system prompt was ignored" and "the model simply repeated its
 * last answer" produce the identical output. Arithmetic breaks the tie: `4` is
 * what a model that never saw the new append says, the marker is what one
 * carrying it says, and nothing in the prior context suggests either.
 */
const MATH = 'What is 2+2? Reply with only the number. Do not use any tools. Do not explain.';

/**
 * Which system prompt a spawn carries.
 *
 *   shipped  — `buildSdkOptions` exactly as a Cebab turn ships it, with the
 *              append passed the way Cebab passes it (`systemPromptAppend`).
 *   recorded — the same object minus `snapshot`, i.e. the SDK's own default.
 *              What Cebab would send if the `snapshot: false` line went away.
 *   override — a caller-supplied value (the string-override row only).
 *   omitted  — no `systemPrompt` key at all. Cebab never ships this.
 */
type Shape =
  | { kind: 'shipped'; append?: string }
  | { kind: 'recorded'; append?: string }
  | { kind: 'override'; systemPrompt: Options['systemPrompt'] }
  | { kind: 'omitted' };

type Case = {
  label: string;
  shape: Shape;
  expect: string;
  /**
   * `Cebab-ygs4`: the token that must appear for this row to be a usable
   * MEASUREMENT rather than a result. Only control rows carry it, and only
   * control rows are retried — a substantive row that answers wrongly is a
   * finding, and retrying it would be exactly the "relax the assertion" move
   * this file exists to refuse.
   */
  control?: string;
};

/**
 * `Cebab-ygs4`: how many times a CONTROL row may be asked before its failure
 * is believed.
 *
 * A control here asks the model to echo one word. That is an instruction, and
 * a model declines it occasionally for reasons that have nothing to do with
 * the system prompt: measured 2026-09-18, the sentinel row answered with the
 * working directory on one run of an overnight gate and with `PINEAPPLE` on
 * the next, from the same code. One sample was enough to fail the LAST step of
 * the Playground tier, which discards a bead that has already passed eleven
 * deterministic steps and four live smokes, costs a repair budget, and on a
 * second failure parks it permanently.
 *
 * Three attempts, not more: if a string override has genuinely stopped
 * replacing the preset, all three fail and the verdict below still says so.
 * Retrying makes the control robust against the model; it does not make it
 * unable to fail.
 */
const CONTROL_ATTEMPTS = 3;

const SHIPPED_LABEL = 'shipped preset';

const CASES: Case[] = [
  // THE POSTURE CEBAB SHIPS (`Cebab-6s27`): the preset, stated explicitly, via
  // `buildSdkOptions` untouched. Its session is also the one the first resume
  // row resumes, so that row measures a conversation Cebab really started.
  { label: SHIPPED_LABEL, shape: { kind: 'shipped' }, expect: '<cwd>' },
  // THE SAFETY PROPERTY, and the reason `systemPromptAppend` exists as its own
  // field. Cebab's text must ADD to the preset, not replace it — so this row
  // must contain BOTH the marker and a working directory. If it ever carries
  // the marker alone, the MCP status note is once again discarding the agent's
  // instructions, which is exactly the defect this design removed.
  {
    label: 'shipped preset + append',
    shape: { kind: 'shipped', append: appendSaying(APPEND_MARKER) },
    expect: `${APPEND_MARKER} + <cwd>`,
  },
  // WHY THE TWO FIELDS ARE SEPARATE. A plain string REPLACES everything, so
  // this row must say the sentinel and must NOT know the cwd. It doubles as the
  // positive control that `systemPrompt` reaches the model at all: if this row
  // fails, no row above means anything.
  {
    label: 'sentinel string',
    shape: {
      kind: 'override',
      systemPrompt: `Whatever you are asked, reply with exactly the single word ${SENTINEL} and nothing else.`,
    },
    expect: SENTINEL,
    control: SENTINEL,
  },
  // OBSERVATIONAL, not a posture Cebab relies on, and recorded for exactly that
  // reason. Omission used to be believed equivalent to an empty override; it
  // stopped being so between two SDK releases and took a documented safety
  // property with it. This row used to be labelled "omitted" while running
  // `buildSdkOptions`' preset — which is always set — so it measured the preset
  // a second time. It now removes the key, so it observes what it names.
  { label: 'omitted (Cebab never ships)', shape: { kind: 'omitted' }, expect: '(observational)' },
];

/** Apply a `Shape` to options `buildSdkOptions` produced. */
function applyShape(options: Options, shape: Shape): void {
  switch (shape.kind) {
    case 'shipped':
      return;
    case 'recorded': {
      const sp = options.systemPrompt;
      if (typeof sp !== 'object' || Array.isArray(sp) || sp.type !== 'preset') {
        throw new Error(`expected buildSdkOptions to ship a preset, got ${JSON.stringify(sp)}`);
      }
      // Whatever the shipped object says about `snapshot`, the recorded shape
      // says nothing — so this stays the SDK default even if the shipped line
      // is removed, and the rows that compare the two stay meaningful.
      const copy = { ...sp };
      delete copy.snapshot;
      options.systemPrompt = copy;
      return;
    }
    case 'override':
      options.systemPrompt = shape.systemPrompt;
      return;
    case 'omitted':
      delete options.systemPrompt;
      return;
  }
}

/**
 * Run one turn and return its final text, or null.
 *
 * Every tool is denied: the question needs none, and a run that reached for
 * Bash would report the cwd from the tool's answer instead of the prompt's,
 * which would make the rows agree and mean nothing.
 */
async function ask(opts: {
  cwd: string;
  shape: Shape;
  question?: string;
  sessionId?: string;
  resume?: string;
}): Promise<string | null> {
  const prompt = opts.question ?? QUESTION;
  const append =
    (opts.shape.kind === 'shipped' || opts.shape.kind === 'recorded') && opts.shape.append
      ? opts.shape.append
      : undefined;
  const options = buildSdkOptions({
    cwd: opts.cwd,
    prompt,
    includePartialMessages: false,
    maxTurns: 1,
    canUseTool: async () => ({ behavior: 'deny', message: 'no tools in this measurement' }),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.resume ? { resume: opts.resume } : {}),
    ...(append ? { systemPromptAppend: append } : {}),
  });
  applyShape(options, opts.shape);

  const q = query({ prompt, options });
  try {
    for await (const m of q) {
      if (m.type === 'result') {
        return 'result' in m && typeof m.result === 'string' ? m.result.trim() : null;
      }
    }
  } finally {
    await q.close?.();
  }
  return null;
}

/**
 * A first turn, then a resumed turn in the SAME session carrying the resume
 * marker's append. Returns the resumed turn's answer. The first turn asks the
 * cwd question so the transcript holds nothing that suggests either answer.
 */
async function resumePair(cwd: string, first: Shape, resumed: Shape): Promise<string | null> {
  const sessionId = crypto.randomUUID();
  await ask({ cwd, sessionId, shape: first });
  return ask({ cwd, question: MATH, resume: sessionId, shape: resumed });
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-sysprompt-cwd-'));
  const rows: { label: string; answer: string; expect: string }[] = [];
  const record = (label: string, answer: string | null, expect: string): void => {
    rows.push({ label, answer: answer ?? '<no result>', expect });
    console.log(`${label.padEnd(36)} → ${JSON.stringify(answer)}`);
  };
  const resumeAppend = appendSaying(RESUME_MARKER);
  let shippedSession: string | undefined;

  console.log(`[sysprompt] cwd under test: ${dir}`);
  // Printed so a run's log says what was actually measured. If this line does
  // not carry `"snapshot":false`, the resume rows below are measuring a build
  // without the fix.
  console.log(
    `[sysprompt] shipped systemPrompt: ${JSON.stringify(
      buildSdkOptions({ cwd: dir, prompt: '' }).systemPrompt,
    )}\n`,
  );
  try {
    for (const c of CASES) {
      let sessionId = crypto.randomUUID();
      let answer = await ask({ cwd: dir, sessionId, shape: c.shape });
      // `Cebab-ygs4`: a CONTROL row gets up to `CONTROL_ATTEMPTS` asks. Each
      // retry is announced — a silent retry would hide a model that is
      // complying only one time in three, which is itself worth seeing.
      for (
        let attempt = 2;
        c.control !== undefined &&
        attempt <= CONTROL_ATTEMPTS &&
        !(answer ?? '').includes(c.control);
        attempt += 1
      ) {
        console.log(
          `${''.padEnd(36)}   (control did not answer ${c.control}; attempt ${attempt} of ${CONTROL_ATTEMPTS})`,
        );
        sessionId = crypto.randomUUID();
        answer = await ask({ cwd: dir, sessionId, shape: c.shape });
      }
      if (c.label === SHIPPED_LABEL) shippedSession = sessionId;
      record(c.label, answer, c.expect);
    }

    // THE CLAIM: a resumed Cebab turn honours the append it was given.
    if (shippedSession) {
      const answer = await ask({
        cwd: dir,
        question: MATH,
        resume: shippedSession,
        shape: { kind: 'shipped', append: resumeAppend },
      });
      record('resumed, as shipped', answer, RESUME_MARKER);
    }
    // THE MIGRATION: a session whose first turn WAS recorded (one started by
    // a build without `snapshot: false`) un-freezes once the resumed turn
    // carries the shipped options.
    record(
      'recorded first, shipped on resume',
      await resumePair(dir, { kind: 'recorded' }, { kind: 'shipped', append: resumeAppend }),
      RESUME_MARKER,
    );
    // THE CAUSE: identical, minus `snapshot` on both turns. Should NOT bind on
    // an account where recording is on.
    record(
      'recorded both turns (control)',
      await resumePair(dir, { kind: 'recorded' }, { kind: 'recorded', append: resumeAppend }),
      `not ${RESUME_MARKER} (where recording is on)`,
    );
    // The fresh-session control: the same append, asked the same question, in
    // a session with nothing to resume. If this does not carry the marker, no
    // resume row above says anything about resume.
    let fresh: string | null = null;
    for (let attempt = 1; attempt <= CONTROL_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        console.log(
          `${''.padEnd(36)}   (control did not answer ${RESUME_MARKER}; attempt ${attempt} of ${CONTROL_ATTEMPTS})`,
        );
      }
      fresh = await ask({
        cwd: dir,
        question: MATH,
        sessionId: crypto.randomUUID(),
        shape: { kind: 'shipped', append: resumeAppend },
      });
      if ((fresh ?? '').toUpperCase().includes(RESUME_MARKER)) break;
    }
    record('fresh + same append (control)', fresh, RESUME_MARKER);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  const by = (label: string): string => rows.find((r) => r.label === label)?.answer ?? '';
  const has = (label: string, marker: string): boolean => by(label).toUpperCase().includes(marker);
  const sentinelWorked = by('sentinel string').includes(SENTINEL);
  const presetKnowsCwd = by(SHIPPED_LABEL).includes('/');
  const appended = by('shipped preset + append');
  const appendReached = appended.toUpperCase().includes(APPEND_MARKER);
  const appendKeptPreset = appended.includes('/');
  const overrideReplaces = !by('sentinel string').includes('/');
  const freshBinds = has('fresh + same append (control)', RESUME_MARKER);
  const resumeBinds = has('resumed, as shipped', RESUME_MARKER);
  const recordedUnfreezes = has('recorded first, shipped on resume', RESUME_MARKER);
  const defaultFreezes = !has('recorded both turns (control)', RESUME_MARKER);

  console.log('\n[sysprompt] verdict');
  if (!sentinelWorked) {
    // `Cebab-ygs4`: say only what this row settles. The old wording claimed
    // `systemPrompt` "did nothing in ANY row above", which its own output
    // routinely disproves — the append row carries the marker AND the working
    // directory in the very same run. A repair agent reads this sentence and
    // goes looking for a fault the rows above have already ruled out.
    console.error(
      `  FAILED (control): after ${CONTROL_ATTEMPTS} attempts the sentinel prompt did not ` +
        'come back. The STRING-OVERRIDE row is therefore unusable — it cannot say ' +
        'whether a plain string still replaces the preset.',
    );
    if (appendReached && appendKeptPreset) {
      console.error(
        '  (but read the rows above before assuming the plumbing is broken: `append` ' +
          'reached the model AND kept the preset beside it in this same run, so ' +
          '`systemPrompt` is plainly being delivered. A control that fails while the ' +
          'append row is green is far more likely the model declining a one-word echo ' +
          'than a regression in how Cebab sets the option.)',
      );
    }
    process.exitCode = 1;
    return;
  }
  if (!presetKnowsCwd) {
    console.error(
      '  FAILED (discrimination): the claude_code preset did not supply the working ' +
        'directory either, so the question cannot tell the two states apart.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`  control: sentinel honoured                 → yes`);
  console.log(`  preset supplies the cwd                    → yes`);
  console.log(`  append REACHES the model                   → ${appendReached ? 'yes' : 'NO'}`);
  console.log(`  append KEEPS the preset beside it          → ${appendKeptPreset ? 'yes' : 'NO'}`);
  console.log(`  a string override replaces the preset      → ${overrideReplaces ? 'yes' : 'NO'}`);
  console.log(`  control: same append on a FRESH session    → ${freshBinds ? 'yes' : 'NO'}`);
  console.log(`  resumed turn honours a new append          → ${resumeBinds ? 'yes' : 'NO'}`);
  console.log(`  a recorded session un-freezes on resume    → ${recordedUnfreezes ? 'yes' : 'NO'}`);
  console.log(`  control: the SDK default freezes it        → ${defaultFreezes ? 'yes' : 'no'}`);

  if (!appendReached || !appendKeptPreset) {
    console.error(
      '\n  STOP: `append` is no longer additive. Cebab puts the MCP status note ' +
        'there (`mcpStatusNoteSpec`) precisely because it cannot replace the ' +
        "agent's instructions — if that stopped holding, a paragraph about one " +
        'broken MCP server is now the whole system prompt, on the turns where ' +
        'something is already wrong. Do not ship until this row is green again.',
    );
    process.exitCode = 1;
    return;
  }
  if (!overrideReplaces) {
    console.error(
      '\n  NOTE: a plain-string `systemPrompt` no longer replaces the preset. That ' +
        'is the premise behind splitting `systemPrompt` from `systemPromptAppend`; ' +
        'if a string is now additive too, the split may be unnecessary — but do not ' +
        'merge the fields without re-reading why the assistant wants a replacement.',
    );
    process.exitCode = 1;
    return;
  }
  if (!freshBinds) {
    console.error(
      `\n  FAILED (control): after ${CONTROL_ATTEMPTS} attempts the append did not bind on a ` +
        'FRESH session either, so the resume rows are uninterpretable: their answers ' +
        'say nothing about resume.',
    );
    process.exitCode = 1;
    return;
  }
  if (!resumeBinds) {
    console.error(
      '\n  STOP: a resumed Cebab turn IGNORED the append it was given, while the same ' +
        'append bound on a fresh session. Every message after the first is a resume, ' +
        "so the MCP status note, an untrusted project's CLAUDE.md and the preset's " +
        'git status are frozen at the first message of every conversation. Check that ' +
        '`buildSdkOptions` still sends `snapshot: false` on the preset (the line above ' +
        'prints what it sends), and whether the SDK changed what that option means.',
    );
    process.exitCode = 1;
    return;
  }
  if (!recordedUnfreezes) {
    console.error(
      '\n  STOP: a session whose first turn was RECORDED stayed frozen even though the ' +
        'resumed turn sent `snapshot: false`. New conversations are fine, but any ' +
        'session a build without the fix started keeps its first-turn prompt until it ' +
        'is compacted. That is a claim the fix was shipped on; do not ship on it again ' +
        'without saying it has changed.',
    );
    process.exitCode = 1;
    return;
  }
  if (defaultFreezes) {
    console.log(
      '\n  `snapshot: false` is what makes the resume row hold: the same pair of turns ' +
        'without it froze the prompt on this account.',
    );
  } else {
    // Not a failure. Recording is rolling out per account, and where it is off
    // the option "is accepted and has no effect" (the SDK's own doc). The
    // claim that matters — a resumed turn binds — held; only its cause could
    // not be shown here.
    console.log(
      '\n  NOTE: this account does not record system prompts yet (the SDK is rolling ' +
        'that out per account), so the SDK default bound on resume too. The resume row ' +
        'holds, but this run cannot show that `snapshot: false` is the reason.',
    );
  }
  console.log(
    '\n  Ordinary Cebab project turns run the claude_code preset, stated explicitly, ' +
      "with Cebab's own text APPENDED and re-rendered on every turn. Appending cannot " +
      "replace the agent's instructions.",
  );
}

await main();
