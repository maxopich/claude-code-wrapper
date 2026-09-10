/**
 * Live measurement: what system prompt does a Cebab turn actually run with?
 *
 *   npm --workspace server exec tsx src/system_prompt_smoke.ts
 *
 * WHY THIS IS A SMOKE AND NOT A TEST. It spawns the real `claude` CLI and
 * spends four short model turns, so it needs the operator's credentials and
 * costs quota; CI has neither. Same reason `live_smoke.ts` and
 * `mcp_scope_smoke.ts` are scripts.
 *
 * WHY IT EXISTS. `Cebab-ws0.15` attaches a short factual note about unhealthy
 * MCP servers to `Options.systemPrompt`, and that is only safe because an
 * ordinary project turn sets no system prompt. The SDK's normalizer (`pO` in `sdk.mjs` 0.3.220)
 * maps an OMITTED `systemPrompt` to the empty string — an explicit override,
 * not "use the CLI default" — so writing a note there adds a line where there
 * was nothing rather than replacing Claude Code's preset with one sentence.
 *
 * That reading came from minified vendor code. If it is wrong, the note would
 * silently destroy the agent's entire system prompt, and NOTHING in this repo
 * would notice: no test spawns a real CLI and inspects what it was told. So the
 * claim is measured here instead of trusted, and re-measured whenever the SDK
 * or the CLI moves.
 *
 * HOW IT DISCRIMINATES. The claim is an EQUIVALENCE, so it is measured as one:
 * `omitted` and an explicit `''` must be indistinguishable, and both must
 * differ from the preset. Asking "does omitting give an empty prompt?" directly
 * would need the model to introspect its own instructions, which it cannot do
 * reliably. Asking for the working directory does not: that fact reaches the
 * model only through the preset's dynamic sections, so it is present or it is
 * not, and the model can answer from what it was given.
 *
 * The SENTINEL case is the positive control, and it is not optional. Without
 * it, a CLI that ignored `systemPrompt` entirely would report UNKNOWN for every
 * case and read as a clean confirmation of the very thing being tested
 * (`project_gates_pass_vacuously`). RESUMED is the third question the bead
 * asked: whether a system prompt supplied on a `--resume` turn binds, or
 * whether the session's first one sticks.
 *
 * Measured 2026-08-20, SDK 0.3.220, CLI 2.1.212:
 *
 *   omitted (ordinary project turn) → "UNKNOWN"
 *   explicit ''                  → "UNKNOWN"
 *   preset 'claude_code'         → "/private/var/folders/.../cebab-sysprompt-cwd-yRXlEm"
 *   sentinel string              → "PINEAPPLE"
 *   resumed + new prompt         → "KUMQUAT"
 *   fresh + same new prompt      → "KUMQUAT"
 *
 * So: omitting `systemPrompt` really is an empty override, the preset really is
 * the thing being declined, and a system prompt supplied on a `--resume` turn
 * DOES bind — Cebab can therefore recompute the note every turn rather than
 * having to fix it at session creation.
 *
 * THE RESUME ROW COST A SECOND RUN, AND THE FIRST ONE LIED. It originally
 * re-asked QUESTION on the resumed turn and came back "UNKNOWN", which reads
 * as a clean "resume ignores the new system prompt" — and would have moved the
 * note to session-creation-only, permanently stale for the rest of a session.
 * The real cause was that the resumed turn already had "Q: ... A: UNKNOWN" in
 * context and simply repeated itself. The two explanations are indistinguishable
 * whenever the probe re-asks a question the transcript already answers. Hence
 * MATH below, and the fresh-session control beside it. Keep both: a probe whose
 * negative result has a second, duller explanation is not a measurement.
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
const RESUME_SENTINEL = 'KUMQUAT';

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
 * what a model with no system prompt says, the sentinel is what one carrying
 * the new prompt says, and nothing in the prior context suggests either.
 */
const MATH = 'What is 2+2? Reply with only the number. Do not use any tools. Do not explain.';

type Case = {
  label: string;
  systemPrompt?: Options['systemPrompt'];
  expect: string;
};

const CASES: Case[] = [
  // THE POSTURE CEBAB SHIPS (`Cebab-6s27`). Every ordinary project turn now
  // states this explicitly rather than omitting the option and inheriting
  // whatever the SDK's normalizer does that release.
  {
    label: "preset 'claude_code'",
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    expect: '<cwd>',
  },
  // THE SAFETY PROPERTY, and the reason `systemPromptAppend` exists as its own
  // field. Cebab's text must ADD to the preset, not replace it — so this row
  // must contain BOTH the marker and a working directory. If it ever carries
  // the marker alone, the MCP status note is once again discarding the agent's
  // instructions, which is exactly the defect this design removed.
  {
    label: 'preset + append',
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: `Always begin your reply with the single token ${APPEND_MARKER}, then answer normally.`,
    },
    expect: `${APPEND_MARKER} + <cwd>`,
  },
  // WHY THE TWO FIELDS ARE SEPARATE. A plain string REPLACES everything, so
  // this row must say the sentinel and must NOT know the cwd. It doubles as the
  // positive control that `systemPrompt` reaches the model at all: if this row
  // fails, no row above means anything.
  {
    label: 'sentinel string',
    systemPrompt: `Whatever you are asked, reply with exactly the single word ${SENTINEL} and nothing else.`,
    expect: SENTINEL,
  },
  // OBSERVATIONAL, not a posture Cebab relies on any more, and recorded for
  // exactly that reason. Omission used to be believed equivalent to an empty
  // override; it stopped being so between two SDK releases and took a
  // documented safety property with it. Kept so the next reader can see whether
  // it has moved again — never so anything can depend on it.
  { label: 'omitted (nothing Cebab ships)', expect: '(observational)' },
];

/**
 * Run one turn and return its final text, or null.
 *
 * The options come from `buildSdkOptions` rather than being hand-written, so
 * the subject row really is the object a Cebab turn ships — a hand-built
 * lookalike would be measuring a second implementation of the thing under
 * test. Only `systemPrompt` is overridden, and only for the cases that need a
 * shape (`string[]`, the preset object) that `RunOptions` deliberately refuses.
 *
 * Every tool is denied: the question needs none, and a run that reached for
 * Bash would report the cwd from the tool's answer instead of the prompt's,
 * which would make all four rows agree and mean nothing.
 */
async function ask(opts: {
  cwd: string;
  question?: string;
  sessionId?: string;
  resume?: string;
  systemPrompt?: Options['systemPrompt'];
}): Promise<string | null> {
  const prompt = opts.question ?? QUESTION;
  const options = buildSdkOptions({
    cwd: opts.cwd,
    prompt,
    includePartialMessages: false,
    maxTurns: 1,
    canUseTool: async () => ({ behavior: 'deny', message: 'no tools in this measurement' }),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.resume ? { resume: opts.resume } : {}),
  });
  if (opts.systemPrompt !== undefined) options.systemPrompt = opts.systemPrompt;

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

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-sysprompt-cwd-'));
  const rows: { label: string; answer: string; expect: string }[] = [];
  let subjectSession: string | undefined;

  console.log(`[sysprompt] cwd under test: ${dir}\n`);
  try {
    for (const c of CASES) {
      const sessionId = crypto.randomUUID();
      const answer = await ask({
        cwd: dir,
        sessionId,
        ...(c.systemPrompt !== undefined ? { systemPrompt: c.systemPrompt } : {}),
      });
      if (c.label.startsWith('omitted')) subjectSession = sessionId;
      rows.push({ label: c.label, answer: answer ?? '<no result>', expect: c.expect });
      console.log(`${c.label.padEnd(28)} → ${JSON.stringify(answer)}`);
    }

    // The bead's third question: does a system prompt supplied on a --resume
    // turn bind, or does the session's original one stick? Answered with the
    // arithmetic probe so a repeated answer cannot masquerade as a verdict, and
    // paired with a fresh-session control so "ignored on resume" cannot really
    // be "this prompt never worked".
    const resumeSystemPrompt = `Whatever you are asked, reply with exactly the single word ${RESUME_SENTINEL} and nothing else.`;
    if (subjectSession) {
      const answer = await ask({
        cwd: dir,
        question: MATH,
        resume: subjectSession,
        systemPrompt: resumeSystemPrompt,
      });
      rows.push({
        label: 'resumed + new prompt',
        answer: answer ?? '<no result>',
        expect: RESUME_SENTINEL,
      });
      console.log(`${'resumed + new prompt'.padEnd(28)} → ${JSON.stringify(answer)}`);
    }
    const control = await ask({
      cwd: dir,
      question: MATH,
      sessionId: crypto.randomUUID(),
      systemPrompt: resumeSystemPrompt,
    });
    rows.push({
      label: 'fresh + same new prompt',
      answer: control ?? '<no result>',
      expect: RESUME_SENTINEL,
    });
    console.log(`${'fresh + same new prompt'.padEnd(28)} → ${JSON.stringify(control)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  const by = (k: string) => rows.find((r) => r.label.startsWith(k))?.answer ?? '';
  const sentinelWorked = by('sentinel').includes(SENTINEL);
  const presetKnowsCwd = by("preset 'claude").includes('/');
  const appended = by('preset + append');
  const appendReached = appended.toUpperCase().includes(APPEND_MARKER);
  const appendKeptPreset = appended.includes('/');
  const overrideReplaces = !by('sentinel').includes('/');

  console.log('\n[sysprompt] verdict');
  if (!sentinelWorked) {
    console.error(
      '  FAILED (control): the sentinel prompt did not reach the model, so ' +
        '`systemPrompt` did nothing in ANY row above. Nothing here is a result.',
    );
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
  console.log(`  control: sentinel honoured           → yes`);
  console.log(`  preset supplies the cwd              → yes`);
  console.log(`  append REACHES the model             → ${appendReached ? 'yes' : 'NO'}`);
  console.log(`  append KEEPS the preset beside it    → ${appendKeptPreset ? 'yes' : 'NO'}`);
  console.log(`  a string override replaces the preset → ${overrideReplaces ? 'yes' : 'NO'}`);
  const resumeBinds = by('resumed').includes(RESUME_SENTINEL);
  const freshBinds = by('fresh +').includes(RESUME_SENTINEL);
  console.log(`  control: same prompt on a FRESH       → ${freshBinds ? 'yes' : 'NO'}`);
  console.log(`  resumed turn honours a new prompt    → ${resumeBinds ? 'yes' : 'NO'}`);
  if (!freshBinds) {
    console.error(
      '  (the resume row is uninterpretable: the prompt it used did not bind on a ' +
        'fresh session either, so its answer says nothing about resume)',
    );
  }

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
  console.log(
    '\n  Ordinary Cebab project turns run the claude_code preset, stated explicitly, ' +
      "with Cebab's own text APPENDED. Appending cannot replace the agent's instructions.",
  );
}

await main();
