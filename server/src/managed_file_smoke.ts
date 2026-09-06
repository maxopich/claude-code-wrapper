/**
 * Live measurement: is an edit made through Cebab what the NEXT SPAWN loads —
 * once the operator has approved what the edit declared?
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
 *
 * WHY THERE IS A TOFU STEP IN THE MIDDLE (Cebab-7u4x). This script shipped on
 * 2026-08-21 asserting that a freshly written `.mcp.json` server appears in the
 * very next spawn. Three days later #382 — "the authority probe starts only
 * trusted MCP servers" (Cebab-ygu.6, Cebab-ygu.17) — added
 * `refuseUnapprovedForProbe`, which refuses every server whose trust is not
 * `trusted`. A server the operator has just declared is `pending_tofu`. So the
 * old premise became exactly what that fix exists to prevent, and this script
 * failed on every run for twelve days: live smokes need the operator's
 * credentials, CI cannot run them, and nothing else re-runs them.
 *
 * It now asserts BOTH halves, which makes it a stronger measurement than it was
 * rather than merely a green one:
 *
 *   1. after the edit and BEFORE approval the server is refused — and the
 *      reason is measured (`trust === 'pending_tofu'`, and the name comes back
 *      from `refuseUnapprovedForProbe`), not inferred from its absence. That
 *      pins the #382 security property, which no other live check covers.
 *   2. after approval the next spawn loads it.
 *
 * Absence alone would be a weak assertion in step 1: a typo'd server name is
 * also absent. Reading the refusal out of the gate is what distinguishes
 * "refused, for this reason" from "never seen".
 *
 * The approval mirrors `applyDecision`'s `allow` case in `mcp_trust_gate.ts` —
 * every field is taken off the resolved `McpServerView`, the same object the
 * operator's click decides about. They share `TrustDecisionInput`, so a new
 * required field breaks both at compile time rather than silently here.
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
const { resolveProjectAuthority } = await import('./repo/project_authority.js');
const { refuseUnapprovedForProbe } = await import('./repo/mcp_trust_gate.js');
const { recordTrustDecision } = await import('./repo/mcp_trust.js');

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

    // ---- 1. REFUSED BEFORE APPROVAL, and for the stated reason ----
    const unapproved = await probeServers(dir, project.id);
    const leakedEarly = unapproved !== null && unapproved.includes(SERVER_NAME);
    console.log(
      `after edit, before approval: ${SERVER_NAME} ${leakedEarly ? 'PRESENT' : 'absent'}`,
    );

    const authority = resolveProjectAuthority({
      projectId: project.id,
      mode: 'cache',
      settingSources: SCOPES,
    });
    const view = authority?.mcpServers.find((s) => s.name === SERVER_NAME);
    if (!view) {
      console.error(
        `[managed-edit] FAILED: the resolver cannot SEE ${SERVER_NAME} after the edit. The ` +
          'bytes landed somewhere it does not read, or the scope rule moved — re-run ' +
          'mcp_scope_smoke.ts before assuming this is a bug in the editor.',
      );
      process.exitCode = 1;
      return;
    }
    const refused = refuseUnapprovedForProbe(project.id, authority?.mcpServers ?? []);
    console.log(`  resolver says trust=${view.trust}, gate refuses ${JSON.stringify(refused)}`);

    if (leakedEarly || view.trust !== 'pending_tofu' || !refused.includes(SERVER_NAME)) {
      console.error(
        '\n[managed-edit] FAILED: a newly declared MCP server was NOT held for approval. ' +
          'This is the #382 property (Cebab-ygu.6/ygu.17) — an edit must not be able to ' +
          'start a server the operator has never been asked about.',
      );
      process.exitCode = 1;
      return;
    }

    // ---- 2. APPROVE, exactly as the operator's click does ----
    // Mirrors `applyDecision`'s `allow` case in `mcp_trust_gate.ts`; every
    // field comes off the resolved view rather than being retyped here.
    recordTrustDecision({
      serverName: view.name,
      originPath: view.originPath ?? '',
      command: view.config?.command ?? '',
      args: view.config?.args ?? [],
      binarySha: view.binarySha ?? null,
      scriptShas: view.scriptShas ?? null,
      decision: 'trusted',
    });
    console.log(`  approved ${SERVER_NAME} (TOFU)`);

    // ---- 3. LOADED AFTER APPROVAL ----
    const after = await probeServers(dir, project.id);
    const present = after !== null && after.includes(SERVER_NAME);
    console.log(`after approval:              ${SERVER_NAME} ${present ? 'PRESENT' : 'absent'}`);
    console.log(`\nmcp_servers after: ${JSON.stringify(after)}`);

    if (!present) {
      console.error(
        '\n[managed-edit] FAILED: approved, and still not loaded. The bytes landed somewhere ' +
          'the CLI does not read, the scope rule moved (re-run mcp_scope_smoke.ts), or the ' +
          'trust row does not match the declaration it was written for.',
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      '\n[managed-edit] PASS — a config edited through Cebab is held for approval, ' +
        'and is what the next spawn loads once approved.',
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

await main();
