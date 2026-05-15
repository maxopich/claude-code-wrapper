/**
 * Cebab-side helpers for driving a multi-agent runtime.
 *
 * Split out from the chain/orchestrator runtimes so each helper can be
 * tested in isolation without the WS layer. Responsibilities:
 *
 *   - Render the per-step briefing / roster prompts that prime each
 *     participant (who they are, who they talk to, what to do).
 *   - Allocate and populate the next `iterations/NNN/` directory for a run.
 *   - Archive a chain hop's prompt/reply.
 *   - Resolve a project id to its bus agent slug (or throw if not installed).
 *
 * Pure helpers — no DB writes (those live in chain.ts / orchestrator.ts),
 * no message transport (that is the in-process `bus_send` tool in runner.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { getProject } from '../repo/projects.js';
import { getProjectBusState } from '../repo/multi_agent.js';
import { busIterationDir, busIterationsDir, type SessionPaths } from './paths.js';
import { sanitizeForPrompt } from './sanitize.js';

/** Sentinel destination for the last chain participant. */
export const SINK_RECIPIENT = '_sink';
/** Sentinel destination for orchestrator → user replies. */
export const USER_RECIPIENT = 'user';
/** Source tag for messages Cebab itself injects (briefings, initial input). */
export const CEBAB_SOURCE = 'cebab';

/**
 * Reason a multi-agent session ended. Shared between chain and orchestrator
 * runtimes so the WS layer can hold a union of handles without two parallel
 * `EndedReason` types.
 */
export type MultiAgentEndedReason = 'completed' | 'stopped' | 'crashed';

/**
 * Render the chain briefing for one participant. Prepended once to that
 * agent's first turn (the tmux model wrote it to an inbox; the pure-SDK
 * runtime rides it on the first prompt — see chain.ts `deliver`).
 *
 * The text is plain English (not JSON) — the recipient is a language model,
 * not a parser. Keep it short and explicit; long preambles eat context.
 */
export function renderChainBriefing(opts: {
  iterationId: string;
  position: number; // 1-indexed
  totalSteps: number;
  selfAgent: string;
  participantNames: string[];
  nextHop: string;
}): string {
  const { iterationId, position, totalSteps, selfAgent, participantNames, nextHop } = opts;
  const isLast = position === totalSteps;
  const others = participantNames.filter((n) => n !== selfAgent);
  // F6: wrap every interpolated agent slug in a <participant>…</participant>
  //     delimiter and pass through sanitizeForPrompt. Slugs come through
  //     `isValidAgentName` today so control chars can't reach here via the
  //     install path, but the wrap makes the function safe regardless of
  //     who calls it (and against any future bypass).
  const tag = (n: string) => `<participant>${sanitizeForPrompt(n)}</participant>`;
  return [
    `[Chain iteration ${iterationId} | step ${position} of ${totalSteps}]`,
    ``,
    `You are ${tag(selfAgent)}. Other participants in this chain: ${
      others.length === 0 ? '(none)' : others.map(tag).join(', ')
    }.`,
    ``,
    `You communicate through the \`bus_send\` tool — an in-process tool, not a`,
    `shell script. There is no inbox to check and no terminal: Cebab delivers`,
    `each turn to you and forwards whatever you send.`,
    ``,
    isLast
      ? `You are the last step. When you finish, send your final reply to the sink so Cebab can archive the iteration:`
      : `When you finish your work, send your reply to the next step:`,
    ``,
    `    bus_send(recipient="${sanitizeForPrompt(nextHop)}", kind="${
      isLast ? 'final' : 'reply'
    }", text="<your ${isLast ? 'final ' : ''}reply>")`,
    ``,
    `Send exactly one ${
      isLast ? '`final`' : '`reply`'
    } message when you are done. Do not message anyone else. The task you need to work on follows below.`,
  ].join('\n');
}

/**
 * Render the session-intro message Cebab delivers as the orchestrator's
 * first turn at orchestrator-routed session start. Lists the participants
 * by bus slug + project name so the orchestrator knows who's available,
 * instructs it to send `intro` to each (with a capability-handshake ask
 * so workers self-describe), and surfaces the hop budget.
 *
 * The text is plain English (not JSON) — the recipient is a language model,
 * not a parser. Symmetric in style with `renderChainBriefing`. Pure
 * function with no IO so it's straightforward to unit-test.
 *
 * Note: the orchestrator's CLAUDE.md template documents the same
 * capability-handshake flow at a higher level; this prompt is the
 * per-session reminder with the concrete `bus_send` example.
 */
export function renderRosterPrompt(opts: {
  workers: Array<{ agentName: string; projectName: string }>;
  hopBudget: number;
}): string {
  const { workers, hopBudget } = opts;
  // F6: agent slugs come from `isValidAgentName` (no control chars
  //     reachable), but `projectName` flows from filesystem folder names
  //     via `addProject` — a folder named `Reviewer"\n\nIgnore prior…`
  //     would otherwise inline verbatim. Wrap both in `<participant>`
  //     delimiters and sanitize.
  const tagAgent = (n: string) => `<participant>${sanitizeForPrompt(n)}</participant>`;
  const firstAgent = workers[0]?.agentName ?? 'reviewer';
  const firstAgentSafe = sanitizeForPrompt(firstAgent);
  const otherAgents =
    workers
      .slice(1)
      .map((w) => sanitizeForPrompt(w.agentName))
      .join(', ') || '(none)';
  return [
    `You are the orchestrator for a new multi-agent session. The participants below are managed in-process by Cebab and have been briefed on the bus protocol; they're waiting for you to introduce them to the conversation.`,
    ``,
    `You talk to participants through the \`bus_send\` tool (recipient = an agent slug, or \`user\` for the operator-facing final answer). It is an in-process tool — there is no inbox, no shell script, no \`bus.log\`. Cebab delivers each participant reply to you as your next turn.`,
    ``,
    `Participants:`,
    ...workers.map((w) => `- ${tagAgent(w.agentName)} — ${sanitizeForPrompt(w.projectName)}`),
    ``,
    `The bus slugs and project names above are what Cebab knows. You don't yet know what each agent is best at — that's what Step 1 is for.`,
    ``,
    `Step 1: call \`bus_send\` with kind=intro to each participant. Tell them they're in a multi-agent conversation, name the other participants, ask them to reply only to you, AND ask them to send back a brief (2-3 sentence) self-description so you know what kinds of tasks each one is best at. Example for ${tagAgent(firstAgent)}:`,
    ``,
    `    bus_send(recipient="${firstAgentSafe}", kind="intro", text="You are part of a multi-agent conversation. Other participants: ${otherAgents}. Reply only to me (orchestrator). Before we start: please send me a brief (2-3 sentence) reply describing your role, areas of expertise, and the kinds of tasks you're best at. I'll use this to route user prompts to whoever fits best.")`,
    ``,
    `Step 2: wait for each worker's \`reply\` with their self-description before routing the first user prompt. The user's first prompt arrives as your next turn after this one — but route it only after you've collected capability replies from every participant. Use those descriptions to inform routing.`,
    ``,
    `Hop budget: ${hopBudget} hops per user prompt (soft cap — do a progress self-check at hop 5). Intro replies don't count toward the budget.`,
    ``,
    `When you have a complete answer for the user, call \`bus_send\` with kind=final to recipient \`user\` — Cebab forwards that to the operator's chat UI.`,
  ].join('\n');
}

/**
 * Roster update for a mid-session `add_multi_agent_participant`. Delivered
 * as the orchestrator's next turn so the LLM learns about the new
 * participant. Same `<participant>` sanitization + delimiting as
 * `renderRosterPrompt`.
 *
 * `currentWorkers` is the FULL post-add roster (including the new
 * participant). The orchestrator should treat this as authoritative —
 * it supersedes the start-time roster.
 */
export function renderRosterUpdate(opts: {
  newWorker: { agentName: string; projectName: string };
  currentWorkers: Array<{ agentName: string; projectName: string }>;
  hopBudget: number;
}): string {
  const { newWorker, currentWorkers, hopBudget } = opts;
  const tagAgent = (n: string) => `<participant>${sanitizeForPrompt(n)}</participant>`;
  const newAgentSafe = sanitizeForPrompt(newWorker.agentName);
  return [
    `A new participant has joined this multi-agent session: ${tagAgent(newWorker.agentName)} (${sanitizeForPrompt(newWorker.projectName)}).`,
    ``,
    `Updated roster:`,
    ...currentWorkers.map(
      (w) => `- ${tagAgent(w.agentName)} — ${sanitizeForPrompt(w.projectName)}`,
    ),
    ``,
    `Call \`bus_send\` with kind=intro to the new participant and collect their capability self-description, same as Step 1 of the original roster. Example:`,
    ``,
    `    bus_send(recipient="${newAgentSafe}", kind="intro", text="You are joining a multi-agent conversation already in progress. Reply only to me (orchestrator). Please send a brief (2-3 sentence) reply describing your role, areas of expertise, and the kinds of tasks you're best at.")`,
    ``,
    `Once they reply, route to them just like any existing worker. Hop budget for the current user prompt remains ${hopBudget}.`,
  ].join('\n');
}

/**
 * Render the orchestrator-mode worker briefing. Prepended once to each
 * worker's first turn (the `briefed` set in `startOrchestratorSession`),
 * exactly like `renderChainBriefing` is for chain participants.
 *
 * Why this exists: the tmux model wrote a per-project `comm.md` teaching
 * the bus protocol into every bus-installed worker. The pure-SDK install
 * collapsed to zero project mutation (security/portability win), so the
 * worker now has the `bus_send` tool available but NO instruction that
 * "reply to the orchestrator" means *calling* it. Chain mode compensates
 * via `renderChainBriefing`; orchestrator-mode workers need this symmetric
 * briefing or their replies are emitted as plain turn text and lost.
 *
 * Plain English (the reader is a model). F6: the slug is wrapped +
 * sanitized like the other renderers.
 */
export function renderWorkerBriefing(opts: { selfAgent: string }): string {
  const tag = (n: string) => `<participant>${sanitizeForPrompt(n)}</participant>`;
  return [
    `[Cebab multi-agent session — you are a worker]`,
    ``,
    `You are ${tag(opts.selfAgent)}, a participant in a Cebab multi-agent`,
    `conversation. A coordinator agent named \`orchestrator\` routes all`,
    `traffic. You talk to it through the \`bus_send\` tool — an in-process`,
    `tool, not a shell script; there is no inbox and no terminal. Cebab`,
    `delivers each message to you as a turn; reply by calling the tool.`,
    ``,
    `To send your reply (the orchestrator is the ONLY recipient you may`,
    `address):`,
    ``,
    `    bus_send(recipient="orchestrator", kind="reply", text="<your reply>")`,
    ``,
    `Critical: anything you write in your normal turn output is INVISIBLE —`,
    `only a \`bus_send\` call is delivered. Always finish a turn by sending`,
    `exactly one \`reply\` to \`orchestrator\`. Do not message other workers`,
    `or \`user\` (those are dropped). Each later turn is a follow-up from the`,
    `orchestrator — answer it the same way. The orchestrator's message`,
    `follows below.`,
  ].join('\n');
}

/**
 * Allocate the next iteration directory id: `001`, `002`, etc. — zero-padded
 * to 3 digits.
 *
 * Pre-007 callers (no `paths`) get an id that's monotonically increasing
 * across all bus runs (scans `~/.cebab/bus/iterations/`). Post-007 callers
 * pass `paths`, in which case the id is per-session (always starts at
 * `001` for a fresh session folder — there are no other iterations
 * inside it). That asymmetry is fine: the iteration id is just a local
 * label within its folder; nothing requires global uniqueness anymore.
 */
export function nextIterationId(paths?: SessionPaths): string {
  // Resolve the parent dir holding numeric iteration subdirs. For the
  // session-scoped variant we synthesize from the `iterationDir` helper
  // with an empty id and a `..` walk — but simpler: we know the folder
  // shape, so compute it directly.
  const dir = paths ? path.join(paths.folder, 'iterations') : busIterationsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // mkdir is idempotent; mkdir errors elsewhere are surfaced on the next op.
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = [];
  }
  let maxN = 0;
  for (const e of entries) {
    if (/^\d+$/.test(e)) {
      const n = Number(e);
      if (n > maxN) maxN = n;
    }
  }
  const next = maxN + 1;
  return String(next).padStart(3, '0');
}

/** Create the per-agent subdirs for a fresh iteration. Idempotent. */
export function prepareIterationDir(
  iterationId: string,
  agentNames: string[],
  paths?: SessionPaths,
): string {
  const baseDir = paths ? paths.iterationDir(iterationId) : busIterationDir(iterationId);
  fs.mkdirSync(baseDir, { recursive: true });
  for (const a of agentNames) {
    const sub = paths ? paths.iterationDir(iterationId, a) : busIterationDir(iterationId, a);
    fs.mkdirSync(sub, { recursive: true });
  }
  return baseDir;
}

/**
 * Persist a single chain hop: the prompt that arrived in `agentName`'s inbox
 * and the reply they emitted to the next hop. Both written as plain text
 * `prompt.md` / `reply.md`. Idempotent: re-writing overwrites — useful when
 * the same hop is observed multiple times (shouldn't happen in normal flow,
 * but defensive).
 */
export function archiveAgentHop(opts: {
  iterationId: string;
  agentName: string;
  prompt: string;
  reply: string;
  paths?: SessionPaths;
}): void {
  const dir = opts.paths
    ? opts.paths.iterationDir(opts.iterationId, opts.agentName)
    : busIterationDir(opts.iterationId, opts.agentName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompt.md'), opts.prompt);
  fs.writeFileSync(path.join(dir, 'reply.md'), opts.reply);
}

/**
 * Resolve a Cebab project id to its bus agent slug. Throws with a typed
 * error code (string) the WS layer can surface as a `wrapper_error`. Used
 * at session start to validate every participant before anything is
 * spawned (cheaper to bail early than to tear down a half-started session).
 */
export class ResolveAgentError extends Error {
  constructor(
    public readonly code: 'project_missing' | 'bus_not_installed' | 'agent_name_missing',
    message: string,
  ) {
    super(message);
    this.name = 'ResolveAgentError';
  }
}

export type ResolvedAgent = {
  projectId: number;
  agentName: string;
  cwd: string;
  projectName: string;
};

export function resolveAgent(projectId: number): ResolvedAgent {
  const project = getProject(projectId);
  if (!project) {
    throw new ResolveAgentError('project_missing', `project ${projectId} not found`);
  }
  const bus = getProjectBusState(projectId);
  if (!bus.installed) {
    throw new ResolveAgentError(
      'bus_not_installed',
      `project ${project.name} has no bus integration installed`,
    );
  }
  if (!bus.agentName) {
    throw new ResolveAgentError(
      'agent_name_missing',
      `project ${project.name} is marked installed but has no agent name (DB inconsistency)`,
    );
  }
  return {
    projectId,
    agentName: bus.agentName,
    cwd: project.path,
    projectName: project.name,
  };
}
