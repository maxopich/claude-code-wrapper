/**
 * Live measurement: does a project's own `CLAUDE.md` reach the model on an
 * ordinary Cebab turn — and under which `settingSources`?
 *
 *   npm --workspace server exec tsx src/project_rules_smoke.ts
 *
 * WHY THIS IS A SMOKE AND NOT A TEST. It spawns the real `claude` CLI and
 * spends four short model turns, so it needs the operator's credentials and
 * costs quota; CI has neither. Same reason `system_prompt_smoke.ts`,
 * `live_smoke.ts` and `mcp_scope_smoke.ts` are scripts.
 *
 * WHY IT EXISTS (`Cebab-5sb8`, and then `Cebab-0fgx` made it urgent). Two
 * claims about project rules have been load-bearing for a long time and
 * neither was ever measured:
 *
 *   1. that the SDK auto-loads a project's root `CLAUDE.md` when
 *      `settingSources` includes `'project'` (CLAUDE.md's own header says so,
 *      and `bus/runtime.ts` decides how much to inject on the strength of it);
 *   2. that an UNTRUSTED project — `settingSources: ['user']` — therefore gets
 *      none of it.
 *
 * Claim 2 turned into a real report on 2026-09-18: an operator asked an
 * ordinary chat session to follow the repo's CLAUDE.md, and it had never seen
 * the file. The session was untrusted, so Cebab had passed
 * `--setting-sources=user`, and nothing anywhere told the operator — or the
 * agent — that the project's rules had been dropped.
 *
 * HOW IT DISCRIMINATES. The fact under test has to be one the model can only
 * know from the file, so the file carries a RANDOM token minted per run. A
 * fixed word would be guessable from context and a well-known one is in
 * training data; either would let a row "pass" while carrying nothing.
 *
 * NO TOOLS, AND THAT IS THE WHOLE MEASUREMENT. `CLAUDE.md` sits in the cwd, so
 * a single `Read` would hand every row the token and make all four agree —
 * the classic vacuous gate. `tools: []` removes every built-in from the
 * model's context, and `canUseTool` denies whatever survives. Both, not one:
 * `canUseTool` is measured NOT to be a universal gate (in-cwd reads settle
 * before it is consulted — see CLAUDE.md, "`default` binds on trusted projects
 * too"), so the callback alone would leave exactly the hole this probe cannot
 * afford.
 *
 * THE ROWS ARE A MATRIX, NOT A LIST. `APPENDED` is the positive control: it
 * delivers the same bytes through `systemPromptAppend`, the mechanism
 * `Cebab-0fgx` ships, so a run where every row says UNKNOWN is legible as
 * "the question is unanswerable" rather than as a clean confirmation that
 * project rules never load. `ABSENT` is the negative control: same settings as
 * the trusted row but no `CLAUDE.md` on disk at all, so a token that shows up
 * anyway means the probe is leaking it (from the prompt, from the path, from
 * the operator's own user-scope memory) and no row above means anything.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Belt and braces, same as `system_prompt_smoke.ts`: nothing below imports
// `db.ts`, but a future edit that adds a `translate()` call would, and
// `config.ts` reads CEBAB_DATA_DIR once at module init. Set it BEFORE the
// dynamic import — an ESM `import` is hoisted above this line and would open
// the operator's real `~/.cebab`.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-projrules-home-'));
process.env.CEBAB_DATA_DIR = path.join(tmpRoot, '.cebab');
const { buildSdkOptions } = await import('./runner/claude.js');
const { query } = await import('@anthropic-ai/claude-agent-sdk');

/**
 * Minted per run, never checked in.
 *
 * The model cannot know this from training, cannot infer it from the question,
 * and cannot derive it from the temp path (which it is not told). So "the
 * model said the token" has exactly one explanation: the file's bytes reached
 * it. A memorable fixed word would make the negative control weaker than the
 * thing it is controlling for.
 */
const TOKEN = `CEBAB-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

/** What the project's rules file says. Shaped like a real convention rather
 *  than a bare marker: the claim under test is that a project's ENGINEERING
 *  RULES bind, and a rule is what those look like. */
const RULES = [
  '# Project rules',
  '',
  '## Release codename',
  '',
  `The release codename for this project is ${TOKEN}.`,
  '',
  'When anyone asks for the release codename, reply with exactly that token',
  'and nothing else.',
  '',
].join('\n');

/**
 * Answerable ONLY from the rules file. The UNKNOWN branch is spelled out so a
 * model that was told nothing has a compliant answer available — without it,
 * an honest "I have not been told" arrives as a paragraph and the row has to
 * be read rather than compared.
 */
const QUESTION =
  "What is this project's release codename? Reply with ONLY the codename token. " +
  'If your instructions have not told you a release codename, reply with ONLY ' +
  'the word UNKNOWN. Do not use any tools. Do not explain.';

type Case = {
  label: string;
  /** Which settings scopes the turn layers. The row under test. */
  settingSources: ('user' | 'project' | 'local')[];
  /** Whether this row's cwd has a CLAUDE.md on disk. */
  rulesOnDisk: boolean;
  /** Whether the rules are ALSO handed over as an explicit system-prompt
   *  append — the mechanism `Cebab-0fgx` adds for untrusted projects. */
  append: boolean;
  expect: string;
  /**
   * The token that must appear for this row to be a usable MEASUREMENT rather
   * than a result. Only control rows carry it, and only control rows are
   * retried — a substantive row that answers wrongly is a FINDING, and
   * retrying it would be the "relax the assertion" move the live smokes exist
   * to refuse. Copied deliberately from `system_prompt_smoke.ts` (`Cebab-ygs4`),
   * where an echo-one-word control was measured declining about one ask in
   * three and failed a whole overnight gate on a single sample.
   */
  control?: string;
};

/** How many times a CONTROL row may be asked before its failure is believed. */
const CONTROL_ATTEMPTS = 3;

const CASES: Case[] = [
  // THE TRUSTED POSTURE. This is the row that says whether the SDK auto-load
  // claim — restated in CLAUDE.md, in `bus/runtime.ts`'s header, and in
  // `docs/bus-architecture.md` — is true at all. Everything that decided to
  // skip work "because the SDK already loads it" rests here.
  {
    label: "trusted ['user','project','local']",
    settingSources: ['user', 'project', 'local'],
    rulesOnDisk: true,
    append: false,
    expect: TOKEN,
  },
  // THE REPORTED BUG. An ordinary untrusted chat session, which is what Cebab
  // ships by default. If this answers UNKNOWN, a project's rules are silently
  // absent from every untrusted turn.
  {
    label: "untrusted ['user']",
    settingSources: ['user'],
    rulesOnDisk: true,
    append: false,
    expect: 'UNKNOWN (the reported bug)',
  },
  // THE FIX, AND THE POSITIVE CONTROL. Same untrusted scopes, with the file's
  // bytes handed over as a system-prompt append instead. It has to carry the
  // token: if it does not, the question is simply unanswerable in this harness
  // and no row above is evidence of anything.
  {
    label: "untrusted + Cebab's append",
    settingSources: ['user'],
    rulesOnDisk: true,
    append: true,
    expect: TOKEN,
    control: TOKEN,
  },
  // THE NEGATIVE CONTROL. Trusted scopes, no CLAUDE.md anywhere. A token here
  // means the probe leaks it and the whole table is void.
  {
    label: 'no CLAUDE.md on disk',
    settingSources: ['user', 'project', 'local'],
    rulesOnDisk: false,
    append: false,
    expect: 'UNKNOWN',
  },
];

/**
 * Run one turn and return its final text, or null.
 *
 * Options come from `buildSdkOptions` rather than being hand-written, so the
 * row really is the object a Cebab turn ships — a hand-built lookalike would
 * measure a second implementation of the thing under test.
 */
async function ask(opts: {
  cwd: string;
  settingSources: ('user' | 'project' | 'local')[];
  append?: string;
}): Promise<string | null> {
  const options = buildSdkOptions({
    cwd: opts.cwd,
    prompt: QUESTION,
    sessionId: crypto.randomUUID(),
    includePartialMessages: false,
    maxTurns: 1,
    settingSources: opts.settingSources,
    // See the header: BOTH layers. `tools: []` is the one that actually keeps
    // `Read` out of the model's context; the callback is the belt.
    tools: [],
    canUseTool: async () => ({ behavior: 'deny', message: 'no tools in this measurement' }),
    ...(opts.append ? { systemPromptAppend: opts.append } : {}),
  });

  const q = query({ prompt: QUESTION, options });
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
  // Two cwds: one that ships rules and one that does not. Separate directories
  // rather than writing and deleting one file, so a row can never be measuring
  // the leftovers of the row before it.
  const withRules = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-projrules-'));
  const withoutRules = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-projrules-bare-'));
  fs.writeFileSync(path.join(withRules, 'CLAUDE.md'), RULES, 'utf8');

  const rows: { label: string; answer: string; expect: string }[] = [];

  console.log(`[project-rules] token under test: ${TOKEN}`);
  console.log(`[project-rules] cwd with rules:   ${withRules}`);
  console.log(`[project-rules] cwd without:      ${withoutRules}\n`);

  try {
    for (const c of CASES) {
      const cwd = c.rulesOnDisk ? withRules : withoutRules;
      const appendText = c.append
        ? [
            'The repository you are working in ships a CLAUDE.md with its canonical',
            'engineering conventions, reproduced verbatim below. Treat it as',
            'AUTHORITATIVE project rules.',
            '',
            RULES,
          ].join('\n')
        : undefined;

      let answer = await ask({
        cwd,
        settingSources: c.settingSources,
        ...(appendText ? { append: appendText } : {}),
      });
      // Control rows only, and every retry is announced — a silent retry would
      // hide a model complying one time in three, which is itself worth seeing.
      for (
        let attempt = 2;
        c.control !== undefined &&
        attempt <= CONTROL_ATTEMPTS &&
        !(answer ?? '').includes(c.control);
        attempt += 1
      ) {
        console.log(
          `${''.padEnd(34)}   (control did not answer the token; attempt ${attempt} of ${CONTROL_ATTEMPTS})`,
        );
        answer = await ask({
          cwd,
          settingSources: c.settingSources,
          ...(appendText ? { append: appendText } : {}),
        });
      }

      rows.push({ label: c.label, answer: answer ?? '<no result>', expect: c.expect });
      console.log(`${c.label.padEnd(34)} → ${JSON.stringify(answer)}`);
    }
  } finally {
    fs.rmSync(withRules, { recursive: true, force: true });
    fs.rmSync(withoutRules, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  const by = (k: string) => rows.find((r) => r.label.startsWith(k))?.answer ?? '';
  const trusted = by('trusted').includes(TOKEN);
  const untrusted = by('untrusted [').includes(TOKEN);
  const appended = by("untrusted + Cebab's").includes(TOKEN);
  const leaked = by('no CLAUDE.md').includes(TOKEN);

  console.log('\n--- verdict ---');
  console.log(`SDK auto-loads project CLAUDE.md on trusted scopes → ${trusted ? 'YES' : 'NO'}`);
  console.log(`  …on untrusted ['user']                           → ${untrusted ? 'YES' : 'NO'}`);
  console.log(`Cebab's append delivers it regardless              → ${appended ? 'YES' : 'NO'}`);
  console.log(`negative control leaked the token                  → ${leaked ? 'YES' : 'no'}`);

  // Order matters: the controls are checked FIRST, because a failure in either
  // makes the two substantive rows unreadable rather than informative.
  if (leaked) {
    console.error(
      '\nVOID: the negative control produced the token with no CLAUDE.md on disk. ' +
        'The probe is leaking it — nothing above is evidence.',
    );
    process.exit(1);
  }
  if (!appended) {
    console.error(
      `\nVOID: the positive control did not carry the token through ${CONTROL_ATTEMPTS} attempts. ` +
        'Either the append path is broken or the model will not echo it; either way the ' +
        'rows above measure nothing. Fix this before reading them.',
    );
    process.exit(1);
  }
  if (!trusted) {
    console.error(
      '\nFINDING: trusted scopes did NOT deliver the project CLAUDE.md. The repo asserts ' +
        'this auto-load in several places and decides how much to inject on the strength ' +
        'of it. Re-read those before trusting them: CLAUDE.md, server/src/bus/runtime.ts, ' +
        'docs/bus-architecture.md.',
    );
    process.exit(1);
  }
  console.log(
    untrusted
      ? '\nNote: untrusted scopes ALSO delivered it. That contradicts the trust model as ' +
          "documented — re-measure before relying on either answer, and do not weaken Cebab's " +
          'append on the strength of one run.'
      : "\nAs documented: only the trusted scopes auto-load it, which is why Cebab's append " +
          'exists for every other turn.',
  );
}

await main();
