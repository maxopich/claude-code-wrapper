/**
 * Live measurement: which `settingSources` actually load a project's own
 * `.mcp.json`, and what the SDK reports about the servers it finds.
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

const CASES: { label: string; scopes: SettingSource[] }[] = [
  { label: "['user','project','local'] (trusted)", scopes: ['user', 'project', 'local'] },
  { label: "['project']", scopes: ['project'] },
  { label: "['user'] (untrusted)", scopes: ['user'] },
  { label: '[]', scopes: [] },
];

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mcp-scope-'));
  fs.writeFileSync(
    path.join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { [PROBE_SERVER]: { command: '/bin/echo', args: ['hi'] } } }),
  );
  console.log(`[mcp-scope] probing a .mcp.json in ${dir}\n`);

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
    fs.rmSync(tmpRoot, { recursive: true, force: true });
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
    process.exitCode = 1;
    return;
  }
  console.log('\n[mcp-scope] done. A row that changed means the scope rule moved — update');
  console.log("[mcp-scope] readMcpJsonServers' doc block in repo/project_authority.ts.");
}

await main();
