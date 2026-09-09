/**
 * Live measurement, in two parts:
 *
 *   PART 1  which `settingSources` actually load a project's own `.mcp.json`
 *   PART 2  whether an `mcpServers` key in a `.claude/settings*.json` layer
 *           loads at all
 *
 *   npm --workspace server exec tsx src/mcp_scope_smoke.ts
 *
 * WHY THIS IS A SMOKE AND NOT A TEST. It spawns the real `claude` CLI, which
 * needs the operator's credentials; CI has none. It is the same reason
 * `live_smoke.ts` is a script. Costs no model turn — `probeSessionStarted`
 * breaks at `system/init`, before the CLI contacts the API.
 *
 * WHY IT EXISTS AT ALL. `repo/project_authority.ts` gates `.mcp.json` reads on
 * `scopes.includes('project')`, and cites a hand-run measurement against SDK
 * 0.3.201 as the reason. That rule decides whether an operator's MCP servers
 * load, the SDK has moved many versions since, and the loading is done by an
 * externally installed CLI this repo cannot pin — so the measurement needs to
 * be re-runnable rather than remembered. Run this when the SDK or the CLI is
 * upgraded, and when a project's MCP servers are missing and you need to know
 * whether the scope rule still holds.
 *
 * Re-run 2026-09-05 on SDK 0.3.251 (dependabot #541) — every row identical to
 * the 0.3.220 record below, so the rule has held across 31 SDK releases. That
 * gap had been open and flagged unmeasured since the lockfile moved past
 * 0.3.220; running this is what closed it, and it is why the header says to run
 * it on an SDK bump rather than trusting the sentence.
 *
 * Measured 2026-08-19, SDK 0.3.220, CLI 2.1.212:
 *
 *   ['user','project','local'] → probeserver PRESENT   (status 'failed' — the
 *                                declared command is not a real MCP server,
 *                                which is the point: it was LOADED, and a
 *                                loaded-but-broken server is the state this
 *                                whole file exists to make visible)
 *   ['project']                → probeserver PRESENT
 *   ['user']                   → probeserver ABSENT
 *   []                         → probeserver ABSENT
 *
 * So the rule still holds on 0.3.220 and on 0.3.251: a project's own
 * `.mcp.json` loads iff the scopes include 'project' — i.e. iff the project is
 * Trusted.
 *
 * READ ONLY THE `probeserver` COLUMN. `mcp_servers` also carries whatever
 * claude.ai cloud connectors the ambient `~/.claude/settings.json` pulls in,
 * and those rows MOVED between two runs of this same script that differed
 * only in their data directory. They are supplied by the environment rather
 * than by the input under test, so treating them as part of the result would
 * be reading noise as signal. The probe server is the controlled variable.
 *
 * ---------------------------------------------------------------------------
 * PART 2 (`Cebab-6fax.42` item 3). The three "NOT loaded" rows in
 * `readMcpJsonServers`' header table — settings-layer `mcpServers` keys —
 * were pinned by a comment recording ONE 0.3.201 run and restated verbatim in
 * a unit test that only ever asserted `.mcp.json` behaviour. Nothing executed
 * re-measured them, and this file wrote only `.mcp.json`. That matters because
 * the table is what a live TOFU prompt is about to be retired on: if those
 * rows are right, Cebab is parking spawns to ask about servers the CLI never
 * starts; if they are wrong, the prompt is the only brake on a server that
 * really does load.
 *
 * Each Part 2 case carries its OWN positive control — a second server declared
 * in a `.mcp.json` beside the settings file, in the same temp project. "Probe
 * absent" and "the CLI never read this directory" are the same observation
 * otherwise, and the second is what a wrong path or a mis-spelled key looks
 * like. A case whose control is absent reports MEASURED NOTHING, not a result.
 *
 * PART 3 measures the user-scope row, which the first draft of this file
 * declared unmeasurable. `~/.claude/settings.json` is the operator's real file
 * and a smoke may not write to it — but `CLAUDE_CONFIG_DIR` relocates the whole
 * user scope, `subscriptionOnlyEnv` copies every non-credential key through to
 * the child, and the standing "a redirected HOME cannot run an authenticated
 * turn" limit does not bind here: this probe breaks at `system/init`, before
 * the CLI contacts the API, so it never needs the credentials the redirect
 * hides. Two controls run in the same spawn, because a redirected config dir
 * is also exactly what "the CLI read nothing" looks like.
 *
 * Measured 2026-09-09, SDK 0.3.251, CLI 2.1.212 — every settings-layer row,
 * each with its own positive control in the same spawn:
 *
 *   <proj>/.claude/settings.json        mcpServers → not loaded
 *   ...the same + enableAllProjectMcpServers      → not loaded
 *   <proj>/.claude/settings.local.json  mcpServers → not loaded
 *   <cfg>/settings.json  (user scope)   mcpServers → not loaded
 *
 *   controls, same spawns: <proj>/.mcp.json      → PRESENT
 *                          <cfg>/.claude.json    → PRESENT at every scope
 *
 * The `settings.local.json` row was never in the table at all — the `'local'`
 * scope was assumed to behave like `'project'` and had never been run. The
 * `<cfg>/.claude.json` control independently reproduces `readClaudeJsonServers`'
 * "loads at EVERY scope" claim, which is what makes the settings-file negative
 * beside it a measurement rather than a silence.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SettingSource } from './runner/claude.js';

// Must be set BEFORE anything pulls in ./db.js: `config.ts` reads
// CEBAB_DATA_DIR once at module init, and a static import would be hoisted
// above this assignment. The probe reaches the DB (translate() looks up the
// session's mock flag), and `db.ts` refuses outright to open the operator's
// real `~/.cebab` from a script — correctly: this one runs on a developer
// machine by definition. `smoke.ts` is the same pattern, and the dynamic
// import below is the load-bearing half of it.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mcp-scope-home-'));
process.env.CEBAB_DATA_DIR = path.join(tmpRoot, '.cebab');
const { probeSessionStarted } = await import('./runner/probe.js');

const PROBE_SERVER = 'probeserver';
/** Parts 2-3: declared in a `.mcp.json` that Part 1 proves the CLI loads. */
const CONTROL_SERVER = 'projctl';
/** Part 3: declared in `<cfg>/.claude.json`, which loads at every scope. */
const USER_CONTROL = 'userctl';

/** A declaration the CLI can parse. Not a real MCP server — it does not need
 *  to be. Loading is observable at `system/init`, which reports a server that
 *  came up and failed; being ABSENT from that list is the negative. */
const DECL = { command: '/bin/echo', args: ['hi'] };

const CASES: { label: string; scopes: SettingSource[] }[] = [
  { label: "['user','project','local'] (trusted)", scopes: ['user', 'project', 'local'] },
  { label: "['project']", scopes: ['project'] },
  { label: "['user'] (untrusted)", scopes: ['user'] },
  { label: '[]', scopes: [] },
];

type SettingsCase = {
  label: string;
  /** Relative to the project root. */
  file: string;
  /** Merged into the settings object beside `mcpServers`. */
  extra?: Record<string, unknown>;
};

const SETTINGS_CASES: SettingsCase[] = [
  { label: '<proj>/.claude/settings.json', file: '.claude/settings.json' },
  {
    label: '  ...the same + enableAllProjectMcpServers',
    file: '.claude/settings.json',
    extra: { enableAllProjectMcpServers: true },
  },
  { label: '<proj>/.claude/settings.local.json', file: '.claude/settings.local.json' },
];

function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

/** PART 1 — the `.mcp.json` scope rule. Returns false if it measured nothing. */
async function probeMcpJsonScopes(): Promise<boolean> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mcp-scope-'));
  writeJson(path.join(dir, '.mcp.json'), { mcpServers: { [PROBE_SERVER]: DECL } });
  console.log(`[mcp-scope] PART 1: a .mcp.json in ${dir}\n`);

  let sawItOnce = false;
  try {
    for (const c of CASES) {
      const started = await probeSessionStarted({
        cwd: dir,
        projectId: 0,
        settingSources: c.scopes,
      });
      if (!started || started.type !== 'session_started') {
        console.log(`${c.label.padEnd(38)} → NO INIT (probe failed)`);
        continue;
      }
      const servers = started.mcpServers ?? [];
      const found = servers.some((s) => s.name === PROBE_SERVER);
      if (found) sawItOnce = true;
      console.log(
        `${c.label.padEnd(38)} → ${found ? 'PRESENT' : 'absent '}   mcp_servers=${JSON.stringify(servers)}`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // POSITIVE CONTROL. "Absent everywhere" is what a broken probe, a bad
  // fixture path or a CLI that never read the temp dir all look like, and it
  // would read as a clean, wrong result (`project_gates_pass_vacuously`). If
  // no scope set loaded the server, the measurement failed — say so loudly
  // rather than reporting four tidy negatives.
  if (!sawItOnce) {
    console.error(
      '\n[mcp-scope] FAILED: no scope set loaded the probe server. That is not a ' +
        'result — it means the probe measured nothing. Check that `claude` is on PATH ' +
        'and authenticated before believing any row above.',
    );
    return false;
  }
  return true;
}

/** PART 2 — settings-layer `mcpServers`. Returns false if any case measured
 *  nothing, or if a row contradicts the table (either is a reason to stop). */
async function probeSettingsLayers(): Promise<boolean> {
  console.log('\n[mcp-scope] PART 2: an mcpServers key in a settings layer\n');
  let ok = true;
  for (const c of SETTINGS_CASES) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mcp-settings-'));
    try {
      writeJson(path.join(dir, c.file), { mcpServers: { [PROBE_SERVER]: DECL }, ...c.extra });
      // The per-case control: a declaration in the file Part 1 just proved
      // loads, in this same directory, read under the same scopes.
      writeJson(path.join(dir, '.mcp.json'), { mcpServers: { [CONTROL_SERVER]: DECL } });
      const started = await probeSessionStarted({
        cwd: dir,
        projectId: 0,
        settingSources: ['user', 'project', 'local'],
      });
      if (!started || started.type !== 'session_started') {
        console.log(`${c.label.padEnd(42)} → NO INIT (probe failed)`);
        ok = false;
        continue;
      }
      const names = (started.mcpServers ?? []).map((s) => s.name);
      const control = names.includes(CONTROL_SERVER);
      const probe = names.includes(PROBE_SERVER);
      if (!control) {
        console.log(`${c.label.padEnd(42)} → MEASURED NOTHING (control absent)`);
        ok = false;
      } else if (probe) {
        console.log(`${c.label.padEnd(42)} → LOADED  ** table row is WRONG **`);
        ok = false;
      } else {
        console.log(`${c.label.padEnd(42)} → not loaded  (control present)`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return ok;
}

/**
 * PART 3 — the user-scope settings layer, under a relocated `CLAUDE_CONFIG_DIR`.
 *
 * Two controls, both in the same spawn as the negative, because a config dir
 * the CLI failed to read produces the same empty column as a key it ignores:
 *
 *   `userctl`  in `<cfg>/.claude.json`  — MUST be present. It proves the
 *              relocated directory is the user scope the CLI actually reads.
 *   `projctl`  in `<proj>/.mcp.json`    — MUST be present under scopes that
 *              include 'project'. It proves the project dir is read too.
 *
 * The second scope set is `['user']`, where `projctl` must DISAPPEAR: without
 * it, a run in which the CLI ignored `settingSources` wholesale would look
 * identical to one that honoured it.
 */
async function probeUserSettingsLayer(): Promise<boolean> {
  console.log('\n[mcp-scope] PART 3: an mcpServers key in the USER settings layer\n');
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mcp-cfg-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mcp-userscope-'));
  const priorCfg = process.env.CLAUDE_CONFIG_DIR;
  let ok = true;
  try {
    // Read by `subscriptionOnlyEnv(process.env)` at spawn time, so mutating it
    // between probes is what scopes the redirect to this part.
    process.env.CLAUDE_CONFIG_DIR = cfg;
    writeJson(path.join(cfg, '.claude.json'), { mcpServers: { [USER_CONTROL]: DECL } });
    writeJson(path.join(cfg, 'settings.json'), { mcpServers: { [PROBE_SERVER]: DECL } });
    writeJson(path.join(dir, '.mcp.json'), { mcpServers: { [CONTROL_SERVER]: DECL } });

    for (const scopes of [['user', 'project', 'local'], ['user']] as SettingSource[][]) {
      const started = await probeSessionStarted({ cwd: dir, projectId: 0, settingSources: scopes });
      const label = `<cfg>/settings.json under ${JSON.stringify(scopes)}`;
      if (!started || started.type !== 'session_started') {
        console.log(`${label.padEnd(56)} → NO INIT (probe failed)`);
        ok = false;
        continue;
      }
      const names = (started.mcpServers ?? []).map((s) => s.name);
      const wantProjectControl = scopes.includes('project');
      if (!names.includes(USER_CONTROL)) {
        console.log(`${label.padEnd(56)} → MEASURED NOTHING (user control absent)`);
        ok = false;
      } else if (names.includes(CONTROL_SERVER) !== wantProjectControl) {
        console.log(`${label.padEnd(56)} → MEASURED NOTHING (scope control wrong)`);
        ok = false;
      } else if (names.includes(PROBE_SERVER)) {
        console.log(`${label.padEnd(56)} → LOADED  ** table row is WRONG **`);
        ok = false;
      } else {
        console.log(`${label.padEnd(56)} → not loaded  (controls ${JSON.stringify(names)})`);
      }
    }
  } finally {
    if (priorCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = priorCfg;
    fs.rmSync(cfg, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return ok;
}

async function main(): Promise<void> {
  try {
    if (!(await probeMcpJsonScopes())) {
      process.exitCode = 1;
      return;
    }
    const settingsOk = await probeSettingsLayers();
    const userOk = await probeUserSettingsLayer();
    if (!settingsOk || !userOk) {
      console.error(
        '\n[mcp-scope] FAILED: a settings-layer row measured nothing or contradicted ' +
          "the table in readMcpJsonServers' header. That table is what retires the " +
          'TOFU prompt for these rows — do not trust the prompt-skip while it is red.',
      );
      process.exitCode = 1;
      return;
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log('\n[mcp-scope] done. A row that changed means the rule moved — update');
  console.log("[mcp-scope] readMcpJsonServers' doc block in repo/project_authority.ts.");
}

await main();
