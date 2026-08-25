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

/**
 * §8.4 Layer 3. A subscription limit is not a bead failure: the CLI does not
 * back off, it prints a line and exits non-zero. Matched linearly rather than
 * by regex — same reason as guard.mjs, and it also copes with the per-model
 * wording ("Opus limit") that a two-alternative pattern would miss.
 */
export function detectUsageLimit(text = '') {
  const lower = text.toLowerCase();
  const at = lower.indexOf('hit your ');
  if (at === -1) return { hit: false };
  const after = lower.slice(at + 'hit your '.length);
  const limitAt = after.indexOf(' limit');
  if (limitAt === -1) return { hit: false };

  const word = after.slice(0, limitAt).trim().split(/\s+/).pop() ?? '';
  const kind = word === 'weekly' ? 'weekly' : word === 'session' ? 'session' : 'model';

  // "· resets 3:45pm" — take the remainder of that line verbatim; never guess.
  let resetsAt = null;
  const resetAt = after.indexOf('resets ');
  if (resetAt !== -1) {
    const rest = after.slice(resetAt + 'resets '.length);
    const line = rest.split('\n')[0].trim();
    if (line) resetsAt = line;
  }
  return { hit: true, kind, resetsAt, raw: text.slice(0, 400) };
}

/**
 * The BUILD argv. Exported for the tests: `--max-budget-usd` and the two
 * settings flags are the parts most likely to be dropped by a refactor and
 * least likely to be noticed, since the loop keeps working without them and
 * only spends more / syncs a board it should not touch.
 */
export function buildArgv({
  config,
  repoRoot,
  resumeSessionId = null,
  schemaPath,
  systemPromptPath,
  settingsPath,
}) {
  const argv = ['-p'];
  if (resumeSessionId) argv.push('--resume', resumeSessionId);
  argv.push(
    '--output-format',
    'json',
    // --json-schema requires --output-format json; it does not work with
    // stream-json. The trade is deliberate: a schema-validated verdict is
    // worth more to this loop than the live event stream, and usage limits
    // are detectable after the fact from stderr.
    '--json-schema',
    fs.readFileSync(schemaPath, 'utf8'),
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

export function renderPrompt(template, vars) {
  let out = template;
  // Block form first, so an unused {{#if repair}} section is removed whole
  // rather than leaving its inner {{...}} markers behind.
  const open = '{{#if repair}}';
  const close = '{{/if}}';
  const start = out.indexOf(open);
  const end = out.indexOf(close);
  if (start !== -1 && end !== -1) {
    const body = out.slice(start + open.length, end);
    out = out.slice(0, start) + (vars.repair ? body : '') + out.slice(end + close.length);
  }
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(String(value ?? ''));
  }
  return out;
}

export function makeBuild({ run, cwd, config, libDir, loopDir, log = () => {} }) {
  const schemaPath = path.join(libDir, 'verdict.schema.json');
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
    async run({ bead, attempt, maxRepairs, failedStep, failureOutput, resumeSessionId }) {
      const prompt = renderPrompt(template, {
        bead_id: bead.id,
        bead_title: bead.title,
        bead_body: bead.description ?? '',
        repair: Boolean(failedStep),
        attempt,
        max: maxRepairs,
        failed_step: failedStep ?? '',
        failure_output: failureOutput ?? '',
      });
      fs.writeFileSync(path.join(loopDir, 'current-prompt.md'), prompt);

      const tier = resolveTier(bead, null, config.build.tiers);
      const effective = tier ? { ...config, build: { ...config.build, ...tier } } : config;
      const argv = buildArgv({
        config: effective,
        repoRoot: cwd,
        resumeSessionId,
        schemaPath,
        systemPromptPath,
        settingsPath,
      });

      log(
        `build: ${bead.id} attempt ${attempt} (${effective.build.model}/${effective.build.effort})`,
      );
      const result = await run('claude', [...argv, prompt], {
        cwd,
        timeoutMs: config.build.timeoutMs,
      });

      // Checked BEFORE anything else — a usage limit must never be recorded as
      // a bead failure, nor count toward the circuit breaker.
      const limit = detectUsageLimit(`${result.stderr}\n${result.stdout}`);
      if (limit.hit) return { ok: false, usageLimit: limit };

      if (result.timedOut) return { ok: false, failure: 'timeout' };
      if (result.code !== 0) {
        return {
          ok: false,
          failure: 'exit',
          exitCode: result.code,
          stderr: result.stderr.slice(-2000),
        };
      }

      let envelope;
      try {
        envelope = JSON.parse(result.stdout);
      } catch {
        return { ok: false, failure: 'unparsable_envelope' };
      }
      const verdict = envelope.structured_output;
      if (!verdict || typeof verdict !== 'object') {
        return { ok: false, failure: 'no_structured_output' };
      }
      return {
        ok: true,
        verdict,
        sessionId: envelope.session_id ?? null,
        numTurns: envelope.num_turns ?? null,
        costUsd: envelope.total_cost_usd ?? null,
        isError: envelope.is_error ?? false,
        exitCode: result.code,
      };
    },
  };
}
