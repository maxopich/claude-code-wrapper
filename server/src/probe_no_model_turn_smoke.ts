/**
 * Live measurement: does the authority probe really cost "a spawn and NO model
 * turn"? (Cebab-6fax.40.1)
 *
 *   npm --workspace server exec tsx src/probe_no_model_turn_smoke.ts
 *
 * WHY THIS IS A SMOKE AND NOT A TEST. The positive control below spends one
 * short model turn against the real `claude` CLI, so it needs the operator's
 * credentials and costs quota; CI has neither. Same reason `live_smoke.ts`,
 * `system_prompt_smoke.ts` and `mcp_scope_smoke.ts` are scripts.
 *
 * THE CLAIM UNDER TEST. `runner/probe.ts`'s header says the probe breaks at the
 * first `system/init` — emitted before the CLI contacts the API — so it "costs a
 * process spawn and no model turn". That claim is load-bearing: it is the whole
 * reason probing on project SELECTION is affordable (`Cebab-ws0.7` fires one per
 * landed-on project, and `probe_schedule.ts`'s settle delay and global cap were
 * sized against the cheap reading). It had never been measured on the live path.
 *
 * WHY THE OBVIOUS SMOKE IS UNSAFE. The probe SIGTERMs the CLI right after init,
 * so "the transcript has no assistant entry" is equally consistent with "the
 * transcript was never flushed for a session killed that early" — and a MISSING
 * (or empty) transcript file would read as a clean pass. That is a textbook
 * vacuous gate (`project_gates_pass_vacuously`): a measurement whose negative
 * result has a second, duller explanation is not a measurement.
 *
 * SO THE POSITIVE CONTROL COMES FIRST, and it is not optional. On the SAME CLI
 * build and the SAME cwd-encoded transcript path, a turn that is KNOWN to spend
 * tokens is run first, and we establish that it DOES produce the exact marker
 * the probe assertion looks for — a top-level `assistant` entry in the on-disk
 * transcript. Only then does the probe's silence mean anything. The control's
 * marker is asserted present in THIS run, not trusted from a previous one.
 *
 * AND THE PROBE'S TRANSCRIPT MUST NOT BE MISSING. A confirmed pass requires the
 * probe's transcript to EXIST and to carry its early entries (the `user` prompt
 * the CLI writes at session start, before init) while carrying NO `assistant`
 * entry. A missing or empty file is reported INCONCLUSIVE and fails — it is the
 * exact reading that would otherwise fake a clean confirmation.
 *
 * WHY WE WAIT BEFORE READING THE PROBE'S TRANSCRIPT. After the probe returns we
 * pause a few seconds before reading. This is not just to let an early write
 * flush: it makes the test MORE sensitive to the failure mode, not less. If
 * aborting at init does NOT actually stop the turn, the assistant entry would
 * land during the wait and we would catch it — which is the more valuable
 * outcome the bead calls out: selection-time probing would then need re-costing.
 *
 * WHAT A PASS SAYS. Not "no turn happened" but "a turn that happens is visible
 * here (the control), and the probe's is not". Both sides are printed.
 *
 * MEASURED 2026-09-10, SDK 0.3.251, CLI-reported model claude-opus-5 — AND THE
 * CLAIM DID NOT HOLD:
 *
 *   control (a real turn) → assistant entries: 1, output tokens: 6
 *   probe                 → user entries: 1, assistant entries: 1, output
 *                           tokens: 16 (+ ~10.7k cache-creation input tokens)
 *
 * The probe's transcript carried a genuine model reply — "I'm here. What would
 * you like me to work on?" — with real usage. Characterised across three runs:
 * `system/init` is emitted ~2.8-3.5s after spawn, the CLI has already dispatched
 * the API request by then, and aborting AT init (even immediately, with no
 * `refreshModelCatalogue` in the way) does NOT cancel it — the SDK's ~2s close
 * grace is enough for the short turn to complete and bill. So this smoke exits
 * NON-ZERO by design: the probe DOES spend a model turn on the live path, and
 * the "no model turn" claim in `probe.ts`'s header (and the several CLAUDE.md
 * lines that repeat it) is stale. Selection-time probing (`Cebab-ws0.7`, one
 * probe per landed-on project) and `probe_schedule.ts`'s settle delay + global
 * cap were all sized against the cheap reading and need re-costing.
 *
 * DO NOT relax the assertion to make this green. The red IS the result; the fix
 * is to the probe or its cost model, not to this measurement.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set BEFORE anything pulls in ./db.js: `config.ts` reads CEBAB_DATA_DIR once at
// module init, and a static import would hoist above this line. `probe.js` and
// `claude.js` both reach `translate()`, which reads the session's mock flag from
// the DB, and `db.ts` refuses outright to open the operator's real ~/.cebab from
// a script. Same pattern as `mcp_scope_smoke.ts` / `system_prompt_smoke.ts`.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-probe-turn-home-'));
process.env.CEBAB_DATA_DIR = path.join(tmpRoot, '.cebab');
const { runClaude } = await import('./runner/claude.js');
const { probeSessionStarted } = await import('./runner/probe.js');

/** A prompt the model can answer in one word with no tools — it spends a real
 *  (small) model turn, which is the whole point of the control. */
const CONTROL_PROMPT =
  'Reply with ONLY the single word BANANA and nothing else. Do not use any tools.';

/**
 * The CLI keys its transcript store on the CANONICAL absolute cwd, encoding
 * every non-alphanumeric character to `-` (the "Resume gotcha" in CLAUDE.md).
 * Verified against `~/.claude/projects/` on disk: `/Users/x/Claude_Space/Cebab`
 * → `-Users-x-Claude-Space-Cebab`. The CLI resolves symlinks first — on macOS
 * `os.tmpdir()` is `/var/folders/…`, a symlink to `/private/var/folders/…`, and
 * the transcript lands under the `/private` form — so callers pass a
 * `fs.realpathSync`-resolved cwd.
 */
function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Root the CLI writes transcripts under. Honours `CLAUDE_CONFIG_DIR` because
 *  `subscriptionOnlyEnv` passes it through to the child unchanged, so the child
 *  writes where this computes. Not relocated here: the control needs the real
 *  credentials a redirected config dir would hide. */
function transcriptDirFor(cwd: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects', encodeCwd(cwd));
}

type TurnCounts = {
  exists: boolean;
  /** Top-level `type: "assistant"` entries — the marker of a model turn. */
  assistant: number;
  /** Top-level `type: "user"` entries — written at session start, before init.
   *  Their presence is what proves the transcript captured THIS session, so a
   *  zero-assistant reading is a real observation rather than an empty file. */
  user: number;
  /** Summed `message.usage.output_tokens` across assistant entries. */
  outputTokens: number;
};

/** Parse a session's transcript and count the entries the assertion turns on. */
function countTurns(cwd: string, sessionId: string): TurnCounts {
  const file = path.join(transcriptDirFor(cwd), `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return { exists: false, assistant: 0, user: 0, outputTokens: 0 };
  const counts: TurnCounts = { exists: true, assistant: 0, user: 0, outputTokens: 0 };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: { type?: string; message?: { usage?: { output_tokens?: number } } };
    try {
      o = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (o.type === 'assistant') {
      counts.assistant += 1;
      const out = o.message?.usage?.output_tokens;
      if (typeof out === 'number') counts.outputTokens += out;
    } else if (o.type === 'user') {
      counts.user += 1;
    }
  }
  return counts;
}

/** Drain a real turn to completion, returning its session id and final text. */
async function runControlTurn(
  cwd: string,
): Promise<{ sessionId: string | null; answer: string | null }> {
  const q = runClaude({
    cwd,
    prompt: CONTROL_PROMPT,
    sessionId: crypto.randomUUID(),
    permissionMode: 'default',
    canUseTool: async () => ({ behavior: 'deny', message: 'no tools in this control' }),
    includePartialMessages: false,
    maxTurns: 1,
    settingSources: ['user'],
  });
  let sessionId: string | null = null;
  let answer: string | null = null;
  try {
    for await (const m of q) {
      const anyMsg = m as unknown as { session_id?: string; type?: string; result?: unknown };
      if (typeof anyMsg.session_id === 'string' && anyMsg.session_id) {
        sessionId = anyMsg.session_id;
      }
      if (anyMsg.type === 'result') {
        answer = typeof anyMsg.result === 'string' ? anyMsg.result.trim() : null;
      }
    }
  } finally {
    await q.close?.();
  }
  return { sessionId, answer };
}

/** JS timer, not a shell sleep: let a late transcript write flush, and give a
 *  turn that DIDN'T actually abort the room to reveal itself. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  // Resolve symlinks up front: the CLI keys its transcript on the canonical
  // cwd, and on macOS the tmp dir is reached through a `/var → /private/var`
  // symlink. Encoding the unresolved path would look in a directory the CLI
  // never wrote to — which reads exactly like "no transcript" (the vacuous
  // pass this smoke exists to refuse).
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-probe-turn-cwd-')));
  console.log(`[probe-turn] cwd under test: ${cwd}`);
  console.log(`[probe-turn] transcripts:   ${transcriptDirFor(cwd)}\n`);

  try {
    // ---- POSITIVE CONTROL: a turn known to spend tokens, measured FIRST. ----
    console.log('[probe-turn] control: running one real model turn…');
    const control = await runControlTurn(cwd);
    if (!control.sessionId) {
      console.error(
        '  FAILED (control): the control turn produced no session id, so its transcript ' +
          'cannot be located. Nothing below is a measurement. Is `claude` authenticated?',
      );
      process.exitCode = 1;
      return;
    }
    // Give the durable write a moment, same as the probe read below.
    await wait(2_000);
    const controlCounts = countTurns(cwd, control.sessionId);
    console.log(`  control answer=${JSON.stringify(control.answer)} session=${control.sessionId}`);
    console.log(
      `  control transcript → exists=${controlCounts.exists} ` +
        `assistant=${controlCounts.assistant} user=${controlCounts.user} ` +
        `outputTokens=${controlCounts.outputTokens}`,
    );
    if (!controlCounts.exists || controlCounts.assistant < 1 || controlCounts.outputTokens < 1) {
      console.error(
        '\n  FAILED (control): a turn that DID spend tokens left no assistant entry (with ' +
          'output tokens) in the transcript at the cwd-encoded path. The marker the probe ' +
          "assertion looks for is not visible here, so the probe's silence would mean " +
          'nothing. Fix the path/marker before trusting any probe row.',
      );
      process.exitCode = 1;
      return;
    }
    console.log('  control OK: a real turn IS visible as an assistant entry here.\n');

    // ---- THE PROBE: same CLI build, same cwd-encoded transcript path. ----
    console.log('[probe-turn] probe: spawning + aborting at init…');
    const started = await probeSessionStarted({ cwd, projectId: 0, settingSources: ['user'] });
    if (!started || started.type !== 'session_started' || !started.sessionId) {
      console.error(
        '  FAILED (probe): no init arrived, so the probe could not be measured. This is ' +
          'a broken probe, not a confirmation of the claim.',
      );
      process.exitCode = 1;
      return;
    }
    const probeSession = started.sessionId;
    console.log(`  probe init → session=${probeSession} model=${started.model}`);
    // If aborting at init did NOT stop the turn, the assistant entry lands during
    // this wait and we catch it. If it did, nothing new appears.
    await wait(4_000);
    const probeCounts = countTurns(cwd, probeSession);
    console.log(
      `  probe transcript → exists=${probeCounts.exists} ` +
        `assistant=${probeCounts.assistant} user=${probeCounts.user} ` +
        `outputTokens=${probeCounts.outputTokens}`,
    );

    console.log('\n[probe-turn] verdict');
    console.log(`  a real turn is visible          → yes (assistant=${controlCounts.assistant})`);

    // The vacuity guard: a missing or empty probe transcript is NOT a pass.
    if (!probeCounts.exists || probeCounts.user < 1) {
      console.error(
        `  probe transcript captured session → NO (exists=${probeCounts.exists}, ` +
          `user=${probeCounts.user})`,
      );
      console.error(
        '\n  INCONCLUSIVE: the probe left no readable transcript for its session (missing, ' +
          'or written without even the startup `user` entry). "No assistant entry" here is ' +
          'indistinguishable from "the transcript was never flushed", which is exactly the ' +
          'vacuous reading this smoke refuses to score as a pass. Increase the post-probe ' +
          'wait, or measure the turn a different way — do not call this confirmed.',
      );
      process.exitCode = 1;
      return;
    }
    console.log(`  probe transcript captured session → yes (user=${probeCounts.user})`);

    if (probeCounts.assistant > 0) {
      console.error(
        `  probe spent NO model turn         → NO (assistant=${probeCounts.assistant})`,
      );
      console.error(
        '\n  FINDING: the probe DID spend a model turn. `runner/probe.ts` claims "a spawn ' +
          'and no model turn", and selection-time probing (Cebab-ws0.7) plus probe_schedule ' +
          "'s settle delay and global cap were all sized against that. Re-cost them. Do NOT " +
          'relax this assertion to make it green — the red IS the result.',
      );
      process.exitCode = 1;
      return;
    }
    console.log('  probe spent NO model turn         → yes (assistant=0)');
    console.log(
      '\n  CONFIRMED: the probe spawned, wrote its transcript, and produced no assistant ' +
        'entry, while a real turn on the same CLI build and cwd-encoded path did. The ' +
        '"a spawn and no model turn" claim holds on the live path.',
    );
  } finally {
    // Clean up both the temp cwd and the transcripts it produced under the real
    // config dir — the encoded dir is unique to this run, so removing it cannot
    // touch the operator's own project transcripts.
    fs.rmSync(transcriptDirFor(cwd), { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

await main();
