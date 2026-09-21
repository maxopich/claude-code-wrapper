/**
 * Live measurement: does the authority probe really cost "a spawn and NO model
 * turn"? (`Cebab-6fax.40.1`)
 *
 *   npm --workspace server exec tsx src/probe_no_model_turn_smoke.ts
 *
 * It is NOT in the loop's Playground list (that list is a gitignored loop file
 * this change must not touch) and no CI runs it — live smokes need the
 * operator's credentials and spend real quota. Run it by hand, on an SDK bump,
 * or whenever the probe's cost model is in question. The automated half — the
 * SCORING, which is where PR #594 went wrong — lives in the pure
 * `runner/probe_turn_classify.ts` and is pinned by `probe_turn_classify.test.ts`.
 *
 * THE CLAIM UNDER TEST. `runner/probe.ts`'s header used to say the probe breaks
 * at the first `system/init` — emitted before the CLI contacts the API — so it
 * "costs a process spawn and no model turn". That was load-bearing: it is why
 * probing on project SELECTION was judged affordable (`Cebab-ws0.7` fires one
 * per landed-on project; `probe_schedule.ts`'s settle delay and global cap were
 * sized against a cheap reading). MEASURED 2026-09-10 (SDK 0.3.251), the claim
 * is FALSE: the CLI dispatches the request ~2 ms after init and aborting at
 * init does not cancel it — the SDK waits ~2 s (its close grace) before SIGTERM,
 * long enough for the short turn to complete and bill (~16 output / ~10.7k
 * cache-write / ~24k cache-read tokens). The claim is now corrected everywhere
 * it was tracked; this smoke is what re-measures it.
 *
 * WHY THE OBVIOUS SMOKE IS VACUOUS, AND HOW THE SCORING ANSWERS IT. The probe
 * SIGTERMs the CLI right after init, so "the transcript has no assistant entry"
 * is equally "no reply was billed" and "a reply was billed but not yet flushed".
 * The `user` entry does NOT rescue it: it is written when the request is
 * DISPATCHED, so "user present, no assistant" is a LOWER BOUND (reply not
 * RECORDED), never proof none was sent. So this smoke reports two things
 * separately — request sent: yes/no; reply recorded: yes/no — and allows a "no
 * request" verdict ONLY on a positive signal that nothing went out: the probe
 * stream read past init with no `system/status 'requesting'`. See
 * `classifyProbeTurn` for the full ordering.
 *
 * THE POSITIVE CONTROL COMES FIRST, and is not optional. On the SAME CLI build
 * and the SAME cwd-encoded transcript path, a turn KNOWN to spend tokens is run
 * first and asserted to leave the exact marker the probe side looks for — a
 * real assistant entry (>=1 output token, not a synthetic `isApiErrorMessage`
 * entry). Only then does the probe's reading mean anything. The marker is
 * asserted present in THIS run, not trusted from a previous one.
 *
 * DISTINCT EXIT CODES so a broken measurement is never read as the known
 * result after an SDK bump: 1 = the finding (the probe spent a billed turn),
 * 2 = INCONCLUSIVE or control/measurement failure, 0 = the claim positively
 * held. DO NOT relax the assertion to make this green — the exit-1 IS the
 * result; the fix, if any, is to the probe's cost model (`Cebab-lh24`, the
 * maintainer's decision), not to this measurement.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set BEFORE anything pulls in `./db.js`: `config.ts` reads CEBAB_DATA_DIR once
// at module init, and a static import would hoist above this line. It is
// `probe.js` that reaches the DB — through `resolveProjectAuthority` and
// `translate()` (which reads the session's mock flag) — so importing it forces
// `db.ts`, which refuses outright to open the operator's real `~/.cebab` from a
// script. `claude.js` imports only the SDK and does NOT reach `translate()`;
// the redirect is here for the probe import, not the control one. Same
// CEBAB_DATA_DIR pattern as `mcp_scope_smoke.ts` / `managed_file_smoke.ts`.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-probe-turn-home-'));
process.env.CEBAB_DATA_DIR = path.join(tmpRoot, '.cebab');
const { runClaude } = await import('./runner/claude.js');
const { pickRunner } = await import('./runner/index.js');
const { registerQuery } = await import('./runner/lifecycle.js');
const { parseTranscript, classifyProbeTurn, resolveStreamSignals } =
  await import('./runner/probe_turn_classify.js');
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** A prompt the model answers in one word with no tools — it spends a real
 *  (small) model turn, which is the whole point of the control. */
const CONTROL_PROMPT =
  'Reply with ONLY the single word BANANA and nothing else. Do not use any tools.';

/** How long to keep reading the probe stream past init before aborting. The
 *  request goes out ~2 ms after init, so a few seconds is ample to observe
 *  `system/status 'requesting'` (and, usually, the reply landing during the
 *  SDK's ~2 s close grace). Long enough that a turn that did NOT actually abort
 *  reveals itself here rather than after we stopped looking. */
const PROBE_OBSERVE_MS = 5_000;

/**
 * The CLI keys its transcript store on the CANONICAL absolute cwd, encoding
 * every non-alphanumeric character to `-` (the "Resume gotcha" in CLAUDE.md):
 * `/Users/x/Claude_Space/Cebab` → `-Users-x-Claude-Space-Cebab`. It resolves
 * symlinks first — on macOS `os.tmpdir()` is a `/var → /private/var` symlink —
 * so callers pass a `fs.realpathSync`-resolved cwd.
 */
function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Root the CLI writes transcripts under. Honours `CLAUDE_CONFIG_DIR` because
 *  `subscriptionOnlyEnv` passes it through to the child unchanged. Not
 *  relocated here: the control needs the real credentials a redirected config
 *  dir would hide. */
function transcriptDirFor(cwd: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects', encodeCwd(cwd));
}

/** Read a session's transcript into the string the pure parser expects, or
 *  `null` when the file does not exist (which the parser scores as missing). */
function readTranscript(cwd: string, sessionId: string): string | null {
  const file = path.join(transcriptDirFor(cwd), `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
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
      if (typeof anyMsg.session_id === 'string' && anyMsg.session_id) sessionId = anyMsg.session_id;
      if (anyMsg.type === 'result') {
        answer = typeof anyMsg.result === 'string' ? anyMsg.result.trim() : null;
      }
    }
  } finally {
    await q.close?.();
  }
  return { sessionId, answer };
}

type ProbeObservation = {
  initArrived: boolean;
  requestingObserved: boolean;
  streamReadPastInit: boolean;
  sessionId: string | null;
};

/**
 * Spawn with the SAME options `probeSessionStarted` uses (`runner/probe.ts`),
 * but instead of returning at init and aborting, keep reading past init for a
 * bounded window so the stream itself can be observed — the production function
 * returns at init and hides everything after it. Aborting at init versus a
 * moment later does not change what the CLI dispatches (that is the whole
 * finding: the SDK's close grace lets the already-sent request complete), so
 * this is a faithful observation of the probe's spawn, not a different one.
 */
async function observeProbeSpawn(cwd: string): Promise<ProbeObservation> {
  const ac = new AbortController();
  const runner = pickRunner({
    cwd,
    prompt: 'probe',
    permissionMode: 'default',
    settingSources: ['user'],
    abortController: ac,
    maxTurns: 1,
    canUseTool: async () => ({ behavior: 'deny' as const, message: 'authority probe: read-only' }),
  });
  const unregister = registerQuery(runner);
  let initArrived = false;
  let requestingObserved = false;
  // The two signals that make "we read past init" a CLAIM rather than a
  // restatement of `initArrived`: either we watched the whole window, or the
  // stream ended on its own. A throw after init sets neither, which is the
  // point — see `resolveStreamSignals`.
  let windowElapsed = false;
  let naturalEnd = false;
  let sessionId: string | null = null;
  let stopTimer: NodeJS.Timeout | undefined;
  try {
    for await (const msg of runner as AsyncIterable<SDKMessage>) {
      const m = msg as unknown as {
        type?: string;
        subtype?: string;
        status?: string;
        session_id?: string;
      };
      if (typeof m.session_id === 'string' && m.session_id) sessionId = m.session_id;
      if (m.type === 'system' && m.subtype === 'init') {
        initArrived = true;
        // Read a bounded window past init, then stop — mirrors the probe's
        // abort, just later, so `'requesting'` (and any reply) can be seen.
        stopTimer = setTimeout(() => {
          windowElapsed = true;
          ac.abort();
        }, PROBE_OBSERVE_MS);
      }
      if (m.type === 'system' && m.subtype === 'status' && m.status === 'requesting') {
        requestingObserved = true;
      }
    }
    // Reached only when the iteration ends WITHOUT throwing.
    naturalEnd = true;
  } catch {
    // An aborted iteration lands here; we still read past init if init arrived.
  } finally {
    if (stopTimer) clearTimeout(stopTimer);
    ac.abort();
    try {
      runner.close?.();
    } catch {
      // Closing an already-aborted runner is not worth surfacing.
    }
    unregister();
  }
  // `resolveStreamSignals` decides whether the absence of `'requesting'` is
  // meaningful or whether we merely stopped looking. It is deliberately NOT
  // `initArrived`: a throw a millisecond after init would otherwise score as
  // positive proof that no request was sent.
  return {
    ...resolveStreamSignals({ initArrived, requestingObserved, windowElapsed, naturalEnd }),
    sessionId,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  // Resolve symlinks up front: the CLI keys its transcript on the canonical
  // cwd, and encoding the unresolved path would look in a directory the CLI
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
        '  FAILED (control): no session id, so its transcript cannot be located. Nothing ' +
          'below is a measurement. Is `claude` authenticated?',
      );
      process.exitCode = 2;
      return;
    }
    await wait(2_000); // give the durable write a moment, same as the probe read
    const controlCounts = parseTranscript(readTranscript(cwd, control.sessionId));
    console.log(`  control answer=${JSON.stringify(control.answer)} session=${control.sessionId}`);
    console.log(
      `  control transcript → present=${controlCounts.present} ` +
        `realAssistant=${controlCounts.realAssistant} user=${controlCounts.userEntries} ` +
        `outputTokens=${controlCounts.outputTokens}`,
    );

    // ---- THE PROBE: same spawn options, same cwd-encoded transcript path. ----
    console.log('\n[probe-turn] probe: spawning + reading past init…');
    const obs = await observeProbeSpawn(cwd);
    console.log(
      `  probe stream → init=${obs.initArrived} requesting=${obs.requestingObserved} ` +
        `readPastInit=${obs.streamReadPastInit} session=${obs.sessionId}`,
    );
    // If aborting at init did not stop the turn, the reply lands during this
    // wait and the transcript read below catches it.
    await wait(4_000);
    const probeCounts = parseTranscript(obs.sessionId ? readTranscript(cwd, obs.sessionId) : null);
    console.log(
      `  probe transcript → present=${probeCounts.present} ` +
        `realAssistant=${probeCounts.realAssistant} error=${probeCounts.errorAssistant} ` +
        `user=${probeCounts.userEntries} outputTokens=${probeCounts.outputTokens}`,
    );

    // ---- SCORE (pure; the same function the unit test pins). ----
    const result = classifyProbeTurn({
      control: controlCounts,
      probe: probeCounts,
      stream: {
        initArrived: obs.initArrived,
        requestingObserved: obs.requestingObserved,
        streamReadPastInit: obs.streamReadPastInit,
      },
    });

    console.log('\n[probe-turn] verdict');
    console.log(
      `  request sent   : ${result.requestSent === null ? 'unknown' : result.requestSent ? 'yes' : 'no'}`,
    );
    console.log(`  reply recorded : ${result.replyRecorded ? 'yes' : 'no'}`);
    console.log(`  verdict        : ${result.verdict}`);
    console.log(`  ${result.summary}`);

    if (result.exitCode === 1) {
      console.error(
        '\n  FINDING: the probe spent a billed model turn. `runner/probe.ts` no longer claims ' +
          'otherwise; selection-time probing (Cebab-ws0.7) and probe_schedule.ts were sized ' +
          'against the old "no model turn" reading and are the maintainer decision in ' +
          'Cebab-lh24. Do NOT relax this assertion — the red IS the result.',
      );
    } else if (result.exitCode === 2) {
      console.error(
        '\n  INCONCLUSIVE / measurement failure — this is NOT a confirmation of the claim. ' +
          'Increase the waits, check `claude` is authenticated, or measure a different way ' +
          'before believing any row above.',
      );
    } else {
      console.log(
        '\n  The "no model turn" claim positively held for this run (a request was proven ' +
          'NOT sent). If the SDK changed, re-check probe.ts and the tracked claim sites.',
      );
    }
    process.exitCode = result.exitCode;
  } finally {
    // Remove both the temp cwd and the transcripts it produced under the real
    // config dir — the encoded dir is unique to this run, so removing it cannot
    // touch the operator's own project transcripts.
    fs.rmSync(transcriptDirFor(cwd), { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

await main();
