/**
 * Bus integration installer — pure-SDK model.
 *
 * "Installing" a project for the bus is now a pure metadata operation:
 *
 *   - choose (or reuse) a stable, collision-free bus agent slug, and
 *   - record `bus_installed` + `bus_agent_name` on the project row.
 *
 * That's it. Cebab no longer mutates the operator's project at all — no
 * `.claude/settings.json` merge, no CLAUDE.md `@import`, no copied shell
 * scripts, no Stop hook, no chmod. The bus protocol reaches a worker via
 * the per-turn briefing Cebab prepends (`renderChainBriefing` /
 * `renderRosterPrompt`), and message transport is the in-process
 * `bus_send` tool injected by the AgentRunner at run time. (Workers now run
 * with `settingSources: ['user', 'project', 'local']`, so a worker DOES load
 * its own project's `.claude/settings*.json` at run time — but Cebab still
 * writes nothing into the project; it just doesn't suppress what's there.)
 *
 * This is the security + portability win of the rewrite: opting a project
 * into the bus can no longer change how that project's own `claude`
 * behaves outside a bus session, and there is nothing platform-specific
 * (shell scripts, chmod) left to install.
 *
 * `installBusForProject` / `uninstallBusForProject` keep their names and
 * the `agentName` field on their result so the WS layer needs no edits.
 */
import fs from 'node:fs';
import { getProject } from '../repo/projects.js';
import {
  getProjectBusState,
  isAgentNameTaken,
  setProjectBusInstalled,
} from '../repo/multi_agent.js';
import { isValidAgentName, RESERVED_AGENT_NAMES, slugifyAgentName } from './paths.js';

export type InstallResult = {
  agentName: string;
  busRow: 'inserted' | 'updated' | 'unchanged';
};

export class InstallError extends Error {
  constructor(
    public readonly code:
      | 'project_not_found'
      | 'agent_name_empty'
      | 'agent_name_taken'
      | 'project_path_missing',
    message: string,
  ) {
    super(message);
    this.name = 'InstallError';
  }
}

/**
 * Opt a project into the bus. Idempotent: a second call with the same
 * derived slug returns `busRow: 'unchanged'` and makes no changes.
 *
 * Throws `InstallError` on:
 *   - missing project row
 *   - project directory has disappeared from disk
 *   - the derived agent slug is empty (project name had no alphanumerics)
 *   - the derived agent slug collides with another already-installed project
 */
export async function installBusForProject(projectId: number): Promise<InstallResult> {
  const project = getProject(projectId);
  if (!project) {
    throw new InstallError('project_not_found', `project ${projectId} not found`);
  }
  if (!fs.existsSync(project.path)) {
    throw new InstallError(
      'project_path_missing',
      `project path no longer exists: ${project.path}`,
    );
  }

  const existingState = getProjectBusState(projectId);
  let agentName: string;
  if (existingState.installed && existingState.agentName) {
    agentName = existingState.agentName;
  } else {
    agentName = chooseAgentName(project.name, project.id, projectId);
  }

  const busRow: InstallResult['busRow'] =
    existingState.installed && existingState.agentName === agentName
      ? 'unchanged'
      : existingState.installed
        ? 'updated'
        : 'inserted';
  setProjectBusInstalled(projectId, true, agentName);

  return { agentName, busRow };
}

export type UninstallResult = {
  agentName: string | null;
  busRow: 'cleared' | 'unchanged';
};

/**
 * Opt a project out of the bus. Clears the DB flag + agent name. Safe to
 * call when the project was never installed (everything is a no-op). No
 * filesystem state to undo — nothing was ever written into the project.
 */
export async function uninstallBusForProject(projectId: number): Promise<UninstallResult> {
  const project = getProject(projectId);
  if (!project) {
    throw new InstallError('project_not_found', `project ${projectId} not found`);
  }
  const state = getProjectBusState(projectId);
  if (!state.installed) {
    return { agentName: state.agentName, busRow: 'unchanged' };
  }
  setProjectBusInstalled(projectId, false, null);
  return { agentName: state.agentName, busRow: 'cleared' };
}

// ---- helpers ----

export function chooseAgentName(
  projectName: string,
  projectId: number,
  excludingProjectId?: number,
): string {
  const slug = slugifyAgentName(projectName);
  if (!slug) {
    // Fall back to `agent-<id>` for projects whose names have no usable
    // characters (e.g. all-emoji folder names). Still must be valid.
    const fallback = `agent-${projectId}`;
    if (!isValidAgentName(fallback)) {
      throw new InstallError('agent_name_empty', `cannot derive agent name from "${projectName}"`);
    }
    return fallback;
  }
  // System sentinels (orchestrator, user, cebab) take precedence — a project
  // named "Orchestrator" gets bumped to `orchestrator-<id>` so it can't
  // shadow the routing agent. Same fallback shape as the collision path
  // below, so the operator's experience is consistent.
  if (RESERVED_AGENT_NAMES.has(slug)) {
    const candidate = `${slug}-${projectId}`;
    if (isAgentNameTaken(candidate, excludingProjectId)) {
      throw new InstallError(
        'agent_name_taken',
        `agent name "${slug}" is reserved and fallback "${candidate}" already in use`,
      );
    }
    return candidate;
  }
  if (isAgentNameTaken(slug, excludingProjectId)) {
    // Suffix with project id for uniqueness — operator can rename the
    // project later if they want a cleaner name (uninstall + reinstall).
    const candidate = `${slug}-${projectId}`;
    if (isAgentNameTaken(candidate, excludingProjectId)) {
      throw new InstallError(
        'agent_name_taken',
        `agent name "${slug}" (and fallback "${candidate}") already in use`,
      );
    }
    return candidate;
  }
  return slug;
}
