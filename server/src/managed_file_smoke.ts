/**
 * Live measurement: is an edit made through Cebab what the NEXT SPAWN loads?
 *
 *   npm --workspace server exec tsx src/managed_file_smoke.ts
 *
 * WHY THIS IS A SMOKE AND NOT A TEST. It spawns the real `claude` CLI, which
 * needs the operator's credentials; CI has none. Costs no model turn —
 * `probeSessionStarted` breaks at `system/init`, before the CLI contacts the
 * API. Same shape and same reason as `mcp_scope_smoke.ts` next door.
 *
 * WHY IT EXISTS. `Cebab-ws0.10`'s acceptance criterion is that an edit is what
 * the next spawn loads, "verified via the probe, not by reading the file back".
 * That distinction is the whole point of the script. Reading the file back
 * proves only that Cebab can write a file — a claim `managed_file.test.ts`
 * already covers, and one that would stay true if the bytes landed somewhere
 * the CLI never looks. Asking the CLI what it loaded is the only way to
 * measure the thing the operator actually cares about.
 *
 * THE BEFORE-PROBE IS NOT OPTIONAL. "The server is present after the edit"
 * means nothing on its own: it would read identically if the server had been
 * there all along, or if the probe were reporting some ambient declaration
 * from `~/.claude.json`. The control is the same project, the same scopes, and
 * the same probe, one edit earlier.
 *
 * Trusted scopes throughout, because a project's own `.mcp.json` loads iff
 * `settingSources` includes `'project'` — see `mcp_scope_smoke.ts`, which
 * measures exactly that and is the reason this one can assume it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Before anything pulls in `./db.js`: `config.ts` reads CEBAB_DATA_DIR once at
// module init, and a static import would hoist above this line. The managed
// root is derived from the data dir, so this also decides where the agent this
// script creates will live — nowhere near the operator's real one.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-managed-edit-'));
process.env.CEBAB_DATA_DIR = path.join(tmpRoot, '.cebab');
const { managedAgentsRoot } = await import('./managed_agent.js');
const { writeManagedFile } = await import('./managed_file.js');
const { upsertProject, setProjectTrusted } = await import('./repo/projects.js');
const { probeSessionStarted } = await import('./runner/probe.js');

const SERVER_NAME = 'ws010probe';
const SCOPES = ['user', 'project', 'local'] as const;

/** Names of the MCP servers the CLI reported loading, or null if no init. */
async function probeServers(cwd: string, projectId: number): Promise<string[] | null> {
  const started = await probeSessionStarted({ cwd, projectId, settingSources: SCOPES });
  if (!started || started.type !== 'session_started') return null;
  return (started.mcpServers ?? []).map((s) => s.name);
}

async function main(): Promise<void> {
  const dir = path.join(managedAgentsRoot(), 'ws010-probe-agent');
  fs.mkdirSync(dir, { recursive: true });
  const project = upsertProject('ws010-probe-agent', dir);
  setProjectTrusted(project.id, true);
  console.log(`[managed-edit] agent at ${dir}\n`);

  try {
    // CONTROL. Same project, same scopes, one edit earlier.
    const before = await probeServers(dir, project.id);
    if (before === null) {
      console.error(
        '[managed-edit] FAILED: the control probe produced no init. Nothing below is a ' +
          'result — check that `claude` is on PATH and authenticated.',
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `before edit: ${SERVER_NAME} ${before.includes(SERVER_NAME) ? 'PRESENT' : 'absent'}`,
    );
    if (before.includes(SERVER_NAME)) {
      console.error(
        `[managed-edit] FAILED: ${SERVER_NAME} was already loaded before the edit, so its ` +
          'presence afterwards would say nothing.',
      );
      process.exitCode = 1;
      return;
    }

    // THE EDIT — through the real write path, not `fs.writeFileSync`. A script
    // that wrote the file itself would be measuring the CLI and not Cebab.
    const w = writeManagedFile(
      project.id,
      'mcp',
      JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: '/bin/echo', args: ['hi'] } } }),
      0,
      () => {},
    );
    if (!w.ok) {
      console.error(`[managed-edit] FAILED: the write was refused (${w.refusal}).`);
      process.exitCode = 1;
      return;
    }

    const after = await probeServers(dir, project.id);
    const present = after !== null && after.includes(SERVER_NAME);
    console.log(`after edit:  ${SERVER_NAME} ${present ? 'PRESENT' : 'absent'}`);
    console.log(`\nmcp_servers after: ${JSON.stringify(after)}`);

    if (!present) {
      console.error(
        '\n[managed-edit] FAILED: the edit did not reach the next spawn. Either the bytes ' +
          'landed somewhere the CLI does not read, or the scope rule moved — re-run ' +
          'mcp_scope_smoke.ts before assuming this is a bug in the editor.',
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      '\n[managed-edit] PASS — a config edited through Cebab is what the next spawn loads.',
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

await main();
