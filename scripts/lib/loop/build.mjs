/**
 * Autonomous loop — BUILD. The one stage a model owns.
 *
 * HOOK SUPPRESSION IS TWO FLAGS, AND THE SPEC'S ONE FLAG DOES NOT WORK.
 * Measured 2026-08-25 in an isolated scratch repo, positive control first:
 *
 *   control, no flags            -> the project's SessionEnd hook FIRED
 *                                   (so hooks do run in -p mode)
 *   --settings <hooks:{}>        -> it STILL FIRED. `--settings` MERGES with
 *                                   project settings; it does not replace them
 *   --setting-sources user       -> suppressed
 *
 * So R1's stated mechanism — a `.claude/loop-settings.json` that simply omits
 * the SessionEnd entry — would have pushed the Kanban board on every single
 * iteration, invisibly, and shown up days later as a mangled board. What
 * replaces it uses BOTH flags, and the merge behaviour that broke the original
 * is exactly what makes the replacement work: `--setting-sources user` drops
 * the project's SessionEnd (kanban-sync) and Stop (bus inbox) hooks, and
 * `--settings` then merges the loop's OWN PreToolUse deny hook back on top.
 *
 * CLAUDE.md IS NOT ASSUMED TO BE IN CONTEXT. With file tools disabled the
 * marker from a project CLAUDE.md was absent even under default setting
 * sources, so `build-system.md` instructs the agent to read it rather than
 * relying on auto-discovery, whose behaviour varies with the scope set.
 * (Related measurement: auto-discovery needs a git project root at all.)
 *
 * `--max-turns` AND `--append-system-prompt-file` ARE REAL despite being
 * absent from `claude --help`'s option list. Verified by ordered probe: place
 * a known-bogus sentinel AFTER the flag under test under `-p` and read which
 * option commander names. `--flag --version` proves nothing — commander
 * short-circuits `--version` before validating.
 */
import fs from 'node:fs';
import path from 'node:path';

import { tokensFrom } from './usage.mjs';

/**
 * §8.4 Layer 3 — did the SUBSCRIPTION stop this run?
 *
 * THE STRINGS BELOW WERE EXTRACTED FROM THE SHIPPED CLI, NOT INVENTED. The
 * previous matcher looked for the single literal `hit your … limit`, and
 * `Cebab-qd2.8` was filed saying it could not be widened without guessing.
 * It can — the wording is a literal in the binary:
 *
 *   strings -n 6 "$(readlink -f "$(which claude)")" \
 *     | grep -oiE '.{0,70}(hit your [a-z0-9 -]{0,20}limit|usage limit|limit reached).{0,70}' \
 *     | sort -u
 *
 * Re-run that when the CLI updates. Measured on 2.1.212, the vocabulary and
 * both templates are literals:
 *
 *   O0t = { five_hour:"session limit", seven_day:"weekly limit",
 *           seven_day_opus:"Opus limit", seven_day_sonnet:"Sonnet limit",
 *           seven_day_overage_included:"Fable 5 limit",
 *           overage:"usage credit limit" }
 *   S5e = (name, suffix) => `You've hit your ${name}${suffix}`
 *   banner                => `${Cap(O0t[type] || type)} reached`
 *   hvg                   => "You've reached your Fable 5 limit."
 *
 * So there are THREE forms and the old matcher handled one. It missed the whole
 * banner family (`Weekly limit reached`) and the `reached your …` family.
 *
 * THE NAIVE WIDENING IS WRONG, AND THE SAME BINARY PROVES IT. Matching bare
 * `limit reached` also matches `Context limit reached` — which happens on
 * ordinary long turns — plus `Subagent nesting limit reached`,
 * `Concurrency Limit reached`, `recursion limit reached` and half a dozen more.
 * Halting an overnight run on any of those is worse than the bug being fixed.
 *
 * AND THE OLD MATCHER ALREADY HAD A LIVE FALSE POSITIVE: `You've hit your fast
 * limit` matched, but fast-mode exhaustion DEGRADES to the normal model. It
 * does not stop anything.
 *
 * Hence the split, which is what the corpus supports rather than what reads
 * tidiest:
 *
 *   - the possessive forms (`hit your X limit`, `reached your X limit`) are
 *     about the account, so any name is accepted EXCEPT the known non-stops;
 *   - the impersonal banner (`X limit reached`) is ambiguous, so the name must
 *     be IN the vocabulary.
 *
 * Evaluated PER LINE. Every false positive above arrives on its own line, and
 * a whole-blob scan cannot tell `Context limit reached` on line 4 from a real
 * stop on line 9.
 */

/** Limit names that ARE a subscription stop, longest phrase first so
 *  `usage credit` is never credited to `usage`. */
const LIMIT_KINDS = Object.freeze([
  ['usage credit', 'credit'],
  ['monthly spend', 'spend'],
  ['monthly usage', 'usage'],
  ['session', 'session'],
  ['weekly', 'weekly'],
  ['fable 5', 'model'],
  ['sonnet', 'model'],
  ['opus', 'model'],
  ['spend', 'spend'],
  ['usage', 'usage'],
]);

/** Names that end in ` limit` and are NOT the subscription running out. */
const NOT_A_USAGE_LIMIT = Object.freeze(['fast']);

/** Real CLI lines that NAME a limit without one having been hit. A line
 *  carrying any of these is skipped whole. */
const NOT_A_STOP = Object.freeze([
  'approaching',
  '% of your',
  'close to your',
  'not your usage limit',
  'running into usage limits',
  'portion of your usage limits',
  'upgrade to increase',
  'is set to $0',
]);

function kindOf(name) {
  for (const [phrase, kind] of LIMIT_KINDS) {
    if (name.includes(phrase)) return kind;
  }
  return null;
}

/** "· resets 3:45pm", "· resets in 2h" — taken verbatim, never parsed. */
function resetsIn(line) {
  const at = line.indexOf('resets ');
  if (at === -1) return null;
  return line.slice(at + 'resets '.length).trim() || null;
}

function hitInLine(line) {
  if (NOT_A_STOP.some((phrase) => line.includes(phrase))) return null;

  // Possessive: `You've hit your <name> limit`, `You've reached your <name> limit`.
  for (const lead of ['hit your ', 'reached your ']) {
    const at = line.indexOf(lead);
    if (at === -1) continue;
    const after = line.slice(at + lead.length);
    // The name is optional: `S5e('limit', …)` is a real fallback in the CLI, so
    // `You've hit your limit · resets 3pm` has no name and no separating space.
    const limitAt = after.startsWith('limit') ? 0 : after.indexOf(' limit');
    if (limitAt === -1) continue;
    // `limits`, `limiting`, `limitation` are not this. A letter after the word
    // means it was never the word — which also independently rejects
    // "running into usage limits", the phrase NOT_A_STOP names directly.
    const rest = after.slice(limitAt === 0 ? 'limit'.length : limitAt + ' limit'.length);
    if (rest && rest[0] >= 'a' && rest[0] <= 'z') continue;
    const name = after.slice(0, limitAt).trim();
    if (NOT_A_USAGE_LIMIT.some((word) => name.includes(word))) continue;
    return kindOf(name) ?? 'model';
  }

  // Banner: `<Name> limit reached`. Vocabulary-only, see the header.
  for (const [phrase, kind] of LIMIT_KINDS) {
    if (line.includes(`${phrase} limit reached`)) return kind;
  }
  return null;
}

export function detectUsageLimit(text = '') {
  for (const raw of String(text).toLowerCase().split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const kind = hitInLine(line);
    if (kind) return { hit: true, kind, resetsAt: resetsIn(line), raw: String(text).slice(0, 400) };
  }
  return { hit: false };
}

/**
 * WHICH STREAMS A LIMIT CAN HONESTLY BE FOUND IN.
 *
 * The scan used to read `stderr + stdout`, and stdout is the result envelope —
 * which contains the AGENT'S OWN PROSE. A bead about rate limiting whose
 * verdict summary quotes one of the phrases above would halt the whole run, and
 * widening the matcher widens exactly that surface.
 *
 * The rule that removes it: A USAGE LIMIT IS A REASON THE RUN FAILED. If the
 * CLI exited 0 and produced a verdict, nothing in its output is a limit that
 * stopped it. stderr is always scanned — it carries CLI diagnostics, never the
 * agent's text — and stdout only when the run did not succeed, which is also
 * where the CLI writes its own refusals.
 */
export function limitScanText(result, envelope) {
  const succeeded =
    result.code === 0 && Boolean(envelope?.structured_output) && envelope?.is_error !== true;
  return succeeded ? (result.stderr ?? '') : `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
}

/**
 * The BUILD argv. Exported for the tests: `--max-budget-usd` and the two
 * settings flags are the parts most likely to be dropped by a refactor and
 * least likely to be noticed, since the loop keeps working without them and
 * only spends more / syncs a board it should not touch.
 *
 * Takes the schema's CONTENT, not its path, so this stays pure — `makeBuild`
 * reads the file once. The earlier path form made the tests reach for
 * `/dev/null`, which does not exist on Windows and turned every argv case red
 * there for a reason that had nothing to do with the argv.
 */
export function buildArgv({
  config,
  repoRoot,
  prompt,
  resumeSessionId = null,
  schemaJson,
  systemPromptPath,
  settingsPath,
}) {
  // THE PROMPT GOES FIRST, and this is not style. `--disallowedTools <tools...>`
  // is VARIADIC: commander keeps consuming bare arguments until the next
  // option or the end of argv. Appending the prompt after it made the CLI read
  // it as a third tool name and receive no prompt at all —
  //
  //   claude -p --output-format json --disallowedTools WebSearch WebFetch 'hi'
  //     -> Error: Input must be provided either through stdin or as a prompt
  //        argument when using --print
  //
  // which is how the first production run parked 3/3 beads on the circuit
  // breaker with zero model turns. Emitting the prompt here, at index 1, means
  // no caller can append a positional after a variadic option — the mistake is
  // no longer expressible rather than merely fixed.
  const argv = ['-p'];
  if (prompt !== undefined) argv.push(prompt);
  if (resumeSessionId) argv.push('--resume', resumeSessionId);
  argv.push(
    '--output-format',
    'json',
    // --json-schema requires --output-format json; it does not work with
    // stream-json. The trade is deliberate: a schema-validated verdict is
    // worth more to this loop than the live event stream, and usage limits
    // are detectable after the fact from stderr.
    '--json-schema',
    schemaJson,
    '--model',
    config.build.model,
    '--effort',
    config.build.effort,
    '--max-turns',
    String(config.build.maxTurns),
    '--permission-mode',
    config.build.permissionMode,
    '--append-system-prompt-file',
    systemPromptPath,
    // See the header: BOTH flags, in this order.
    '--setting-sources',
    'user',
    '--settings',
    settingsPath,
    '--disallowedTools',
    'WebSearch',
    'WebFetch',
  );
  // The CLI enforces this mid-turn. A driver-side sum can only notice an
  // overrun it has already paid for.
  if (config.limits.beadCostCeilingUsd) {
    argv.push('--max-budget-usd', String(config.limits.beadCostCeilingUsd));
  }
  void repoRoot;
  return argv;
}

/** First matching tier decides model + effort; an empty `tiers` changes nothing. */
export function resolveTier(bead, changedPathHint, tiers = []) {
  for (const tier of tiers) {
    const when = tier.when ?? {};
    if (when.pathPrefix && !when.pathPrefix.some((p) => (changedPathHint ?? '').startsWith(p)))
      continue;
    if (when.maxPriority !== undefined && !(bead.priority <= when.maxPriority)) continue;
    if (when.type && !when.type.includes(bead.issue_type)) continue;
    return { model: tier.model, effort: tier.effort };
  }
  return null;
}

/**
 * Did this run end because it ran out of turns?
 *
 * TWO SIGNALS ON PURPOSE. `terminal_reason` is undocumented and its vocabulary
 * is not frozen; the `errors` string is what a human reads and has its own
 * wording risk. Either one alone would be a single point of silent failure,
 * and the consequence of missing this is not cosmetic — a capped build is
 * recorded as a generic `exit`, so the operator cannot tell "needs more turns"
 * from "the CLI broke", and the two have opposite remedies.
 *
 * Measured shape:
 *   { "terminal_reason": "max_turns",
 *     "errors": ["Reached maximum number of turns (40)"], ... }
 */
export function isMaxTurns(envelope) {
  if (!envelope || typeof envelope !== 'object') return false;
  if (envelope.terminal_reason === 'max_turns') return true;
  const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
  return errors.some(
    (e) => typeof e === 'string' && e.toLowerCase().includes('maximum number of turns'),
  );
}

/**
 * `{{#if name}}…{{/if}}` blocks, then `{{var}}` substitution.
 *
 * Blocks resolve FIRST so an unused section is removed whole rather than
 * leaving its inner `{{...}}` markers behind in the prompt.
 *
 * ANY NUMBER OF NAMED BLOCKS, not just `repair`. A turn cap and a red gate are
 * both "try again", but the instruction is the opposite in each — a gate repair
 * must fix a named failing step, a resumed cap must CONTINUE and not restart —
 * and one block that hardcodes "A previous attempt failed the gate" cannot say
 * both. Two blocks keep the prose in the template rather than splitting it
 * between here and a `{{repair_intro}}` variable.
 *
 * `indexOf` rather than a regex, matching the rest of this file: the bodies
 * hold fenced code and braces, and the repo's `security/detect-unsafe-regex`
 * rule rejects the tolerant patterns such a matcher grows into.
 */
export function renderPrompt(template, vars) {
  let out = template;
  const OPEN = '{{#if ';
  const CLOSE = '{{/if}}';
  for (;;) {
    const start = out.indexOf(OPEN);
    if (start === -1) break;
    const nameEnd = out.indexOf('}}', start);
    if (nameEnd === -1) break;
    const end = out.indexOf(CLOSE, nameEnd);
    if (end === -1) break;
    const name = out.slice(start + OPEN.length, nameEnd).trim();
    const body = out.slice(nameEnd + '}}'.length, end);
    out = out.slice(0, start) + (vars[name] ? body : '') + out.slice(end + CLOSE.length);
  }
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(String(value ?? ''));
  }
  return out;
}

/**
 * The sibling follow-ups, as prompt lines.
 *
 * CAPPED AT 20, newest first. An `--until 8` night can file dozens, and a list
 * long enough to push the bead's own body out of the agent's attention would
 * trade one duplicate for something worse. Newest first because the near-
 * duplicates measured on 2026-08-27 were all filed within a few iterations of
 * each other.
 */
export function renderPriorFollowUps(followUps = [], limit = 20) {
  return followUps
    .slice(-limit)
    .reverse()
    .map((f) => `- ${f.id} — ${f.title}`)
    .join('\n');
}

export function makeBuild({ run, cwd, config, libDir, loopDir, log = () => {} }) {
  const schemaJson = fs.readFileSync(path.join(libDir, 'verdict.schema.json'), 'utf8');
  const systemPromptPath = path.join(libDir, 'build-system.md');
  // TRACKED, and NOT under `.claude/`. The spec put this at
  // `.claude/loop-settings.json` and gitignored it. Both were wrong once it
  // grew the PreToolUse deny hook: eslint ignores `.claude/**` wholesale (the
  // worktrees under it shadow every file in the repo), so the loop's security
  // boundary would have been the one module in this directory with no lint
  // gate and no natural home for its tests. It lives beside the code it
  // guards instead.
  const settingsPath = path.join(libDir, 'loop-settings.json');
  const template = fs.readFileSync(path.join(libDir, 'build-prompt.md'), 'utf8');

  return {
    async run({
      bead,
      attempt,
      maxRepairs,
      failedStep,
      failureOutput,
      resumeSessionId,
      capped,
      priorFollowUps = [],
    }) {
      const prompt = renderPrompt(template, {
        bead_id: bead.id,
        bead_title: bead.title,
        bead_body: bead.description ?? '',
        // Mutually exclusive: a resumed turn cap has no failing step to hand
        // back, and telling it "a previous attempt failed the gate" would send
        // it looking for a failure that never happened.
        repair: Boolean(failedStep) && !capped,
        capped: Boolean(capped),
        attempt,
        max: maxRepairs,
        max_turns: config.build.maxTurns,
        failed_step: failedStep ?? '',
        failure_output: failureOutput ?? '',
        // WHAT THIS RUN'S EARLIER ITERATIONS ALREADY FILED.
        //
        // Each iteration is a fresh `claude -p` with no memory of its siblings.
        // The run of 2026-08-27 filed ten follow-ups, two PAIRS of which were
        // the same finding written twice — and the agent that wrote the second
        // of one pair TITLED it "(already tracked as Cebab-03a)", so it had
        // searched and found the bead and filed anyway. It could see the DB; it
        // could not see what a sibling had filed minutes earlier, because
        // nothing put that in front of it. `Cebab-7t6`.
        prior_follow_ups: Boolean(priorFollowUps.length),
        prior_follow_up_list: renderPriorFollowUps(priorFollowUps),
      });
      fs.writeFileSync(path.join(loopDir, 'current-prompt.md'), prompt);

      const tier = resolveTier(bead, null, config.build.tiers);
      const effective = tier ? { ...config, build: { ...config.build, ...tier } } : config;
      const argv = buildArgv({
        config: effective,
        repoRoot: cwd,
        prompt,
        resumeSessionId,
        schemaJson,
        systemPromptPath,
        settingsPath,
      });

      log(
        `build: ${bead.id} attempt ${attempt} (${effective.build.model}/${effective.build.effort})`,
      );
      const result = await run('claude', argv, {
        cwd,
        timeoutMs: config.build.timeoutMs,
      });

      // THE ENVELOPE IS PARSED BEFORE THE EXIT CODE IS JUDGED, and that order
      // is the whole fix. The CLI exits NON-ZERO on a turn-cap exhaustion
      // while still emitting a complete result envelope, so returning early on
      // `result.code !== 0` threw away everything it had just been told.
      // Measured on a real run: the envelope carried
      // `terminal_reason: "max_turns"` and
      // `errors: ["Reached maximum number of turns (40)"]` alongside the
      // session id, turn count and cost — and the ledger recorded
      // `failure: 'exit'` with a truncated JSON fragment and three nulls.
      let envelope = null;
      try {
        envelope = JSON.parse(result.stdout);
      } catch {
        // Left null: an unparseable stdout is itself a diagnosis, handled below.
      }

      // Facts, recorded on EVERY outcome. The session id is what lets a human
      // (or a future repair) resume a capped build instead of redoing it, and
      // the consumption is what stops the run ceiling under-counting every
      // failure it never saw.
      //
      // TOKENS ARE THE REPORTED UNIT, `costUsd` IS ONLY RECORDED. The loop runs
      // on a subscription, so a dollar figure prices a transaction that never
      // happens and says nothing about the usage window it actually spends. It
      // is kept because it is the CLI's own number and the only free
      // cross-model normaliser; nothing prints it. See `usage.mjs`, which also
      // records why plan utilization itself is out of reach here.
      const telemetry = {
        sessionId: envelope?.session_id ?? null,
        numTurns: envelope?.num_turns ?? null,
        costUsd: envelope?.total_cost_usd ?? null,
        tokens: tokensFrom(envelope),
        // The CLI's own measurement of the turn, not the driver's wall clock:
        // it excludes spawn and teardown, so two builds are comparable.
        durationMs: envelope?.duration_ms ?? null,
        exitCode: result.code,
      };

      // Checked before every other failure class — a usage limit must never be
      // recorded as a bead failure, nor count toward the circuit breaker. It
      // now runs AFTER the parse only because `limitScanText` needs the
      // envelope to decide which streams it may honestly read; the precedence
      // among outcomes is unchanged. Telemetry rides along because a limited
      // attempt still SPENT, and counting only completed builds under-reported
      // exactly the runs the operator most wants to see.
      const limit = detectUsageLimit(limitScanText(result, envelope));
      if (limit.hit) return { ok: false, usageLimit: limit, ...telemetry };

      if (result.timedOut) return { ok: false, failure: 'timeout', ...telemetry };

      if (isMaxTurns(envelope)) {
        return {
          ok: false,
          failure: 'max_turns',
          ...telemetry,
          detail:
            `the agent used all ${envelope?.num_turns ?? config.build.maxTurns} turns without ` +
            `producing a verdict` +
            (telemetry.sessionId
              ? `; inspect with \`claude --resume ${telemetry.sessionId}\``
              : ''),
        };
      }

      if (result.code !== 0) {
        return {
          ok: false,
          failure: 'exit',
          ...telemetry,
          // Both streams: the CLI writes its own refusals (a malformed argv,
          // a missing prompt) to stdout, not stderr, so recording only stderr
          // is what made three identical `exit 1` ledger rows say nothing.
          detail: `${result.stdout}\n${result.stderr}`.trim().slice(-600),
        };
      }

      if (!envelope) return { ok: false, failure: 'unparsable_envelope', ...telemetry };
      const verdict = envelope.structured_output;
      if (!verdict || typeof verdict !== 'object') {
        return { ok: false, failure: 'no_structured_output', ...telemetry };
      }
      return { ok: true, verdict, ...telemetry, isError: envelope.is_error ?? false };
    },
  };
}
