/**
 * Cebab-side helpers for driving a multi-agent runtime.
 *
 * Split out from the chain orchestrator so each helper can be tested in
 * isolation without touching tmux or the WS layer. Responsibilities:
 *
 *   - Write a message into an agent's bus inbox (same on-disk format that
 *     `bus-send-msg.sh` writes, so the tailer cannot tell apart Cebab-
 *     originated traffic from agent-originated traffic).
 *   - Render the per-step briefing that primes each chain participant
 *     (who they are, who they forward to, what to do).
 *   - Allocate and populate the next `iterations/NNN/` directory for a run.
 *   - Resolve a project id to its bus agent slug (or throw if not installed).
 *
 * No tmux, no DB writes (those live in `chain.ts`).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getProject } from '../repo/projects.js';
import { getProjectBusState } from '../repo/multi_agent.js';
import {
  busArchiveDir,
  busInboxDir,
  busIterationDir,
  busIterationsDir,
  busLogPath,
  isValidBusRecipient,
  type SessionPaths,
} from './paths.js';
import { appendBusLogEvent, type BusLogEvent } from './log_tailer.js';
import { sanitizeForPrompt } from './sanitize.js';

/** Sentinel destination for the last chain participant. */
export const SINK_RECIPIENT = '_sink';
/** Sentinel destination for orchestrator → user replies. */
export const USER_RECIPIENT = 'user';
/** Source tag for messages Cebab itself injects (briefings, initial input). */
export const CEBAB_SOURCE = 'cebab';

/**
 * Shell command tmux launches in EVERY bus-runtime pane — both workers
 * and the orchestrator. The `--permission-mode bypassPermissions` flag
 * makes claude-code skip every per-tool permission prompt.
 *
 * Bypass is necessary because:
 *   1. Bus panes run headless — there's no human at the tmux terminal
 *      to dismiss claude-code's per-tool permission card.
 *   2. claude-code parses bash structurally. Even a narrow allow-list
 *      like `Bash(.../bus-send-msg.sh:*)` matches only flat command
 *      invocations; the moment the LLM reaches for `cat <<EOF |
 *      bus-send-msg.sh …` (which it routinely does for long messages),
 *      the AST node type is `pipeline`, the allow-list doesn't match,
 *      and the agent stalls on a permission prompt forever. Verified
 *      in session `e82d6912` where the orchestrator got stuck on
 *      exactly this prompt while routing a long worker query.
 *
 * Trust gate:
 *   - Workers: the operator's explicit "Install bus integration" click
 *     per project. Documented in CLAUDE.md's Trust section and
 *     surfaced in the install UI confirmation.
 *   - Orchestrator: its workspace is `<sessionFolder>/orchestrator/`,
 *     entirely Cebab-generated (CLAUDE.md, comm.md, settings.json), so
 *     there's no operator code inside it to protect.
 *
 * Bypass is launched alongside `dismissBypassPermissionsModal` (in
 * `tmux.ts`) which auto-accepts claude-code's per-launch "Bypass
 * Permissions mode" warning so neither workers nor the orchestrator
 * stall on the startup acknowledgement modal.
 *
 * Only `rm -rf /` and `rm -rf ~` still circuit-break under bypass; every
 * other tool runs unprompted. See plan
 * `~/.claude/plans/here-is-the-list-foamy-gem.md` (top section) for
 * the full rationale.
 */
export const BUS_CLAUDE_COMMAND = 'claude --permission-mode bypassPermissions';

/**
 * Reason a multi-agent session ended. Shared between chain and orchestrator
 * runtimes so the WS layer can hold a union of handles without two parallel
 * `EndedReason` types.
 */
export type MultiAgentEndedReason = 'completed' | 'stopped' | 'crashed';

/**
 * Write a message to a recipient's bus inbox and append the matching event
 * to bus.log. Mirrors `bus-send-msg.sh` exactly so the tailer's parser
 * doesn't need to distinguish the two paths.
 *
 * Idempotency: each call creates a fresh file with a `<ts>-<from>-<rand>.msg`
 * name, so consecutive calls don't collide. Atomic write (.tmp → rename)
 * so the consumer never sees a half-written body via fs.watch.
 *
 * If `paths` is provided, writes land in the per-session folder (post-007
 * sessions). Otherwise falls back to the legacy global `~/.cebab/bus/`
 * layout — kept so existing tests and any in-flight pre-007 callers keep
 * working without churn.
 */
export function writeInboxMessage(opts: {
  recipient: string;
  source: string;
  text: string;
  kind: BusLogEvent['kind'];
  /** Override clock for tests; defaults to Date.now(). */
  ts?: number;
  /** Per-session paths bundle. Omit to use the legacy global layout. */
  paths?: SessionPaths;
}): BusLogEvent {
  // Defense-in-depth: internal callers pass resolved slugs or the
  // 'user'/'_sink' sentinels, but a future caller passing operator-
  // controlled input must not slip past. Mirrors the shell guards in
  // bus-send-msg.sh / bus-check-inbox.sh.
  if (!isValidBusRecipient(opts.recipient)) {
    throw new Error(`writeInboxMessage: invalid recipient ${JSON.stringify(opts.recipient)}`);
  }
  const ts = opts.ts ?? Date.now();
  const inbox = opts.paths ? opts.paths.busInbox(opts.recipient) : busInboxDir(opts.recipient);
  const archive = opts.paths
    ? opts.paths.busArchive(opts.recipient)
    : busArchiveDir(opts.recipient);
  const logPath = opts.paths ? opts.paths.busLog : busLogPath();
  fs.mkdirSync(inbox, { recursive: true });
  // Also pre-create the archive dir so bus-check-inbox.sh's mv doesn't have
  // to race the consumer.
  fs.mkdirSync(archive, { recursive: true });

  const rand = crypto.randomBytes(3).toString('hex');
  const filename = `${ts}-${opts.source}-${rand}.msg`;
  const tmp = path.join(inbox, `.tmp.${process.pid}.${rand}`);
  const final = path.join(inbox, filename);
  fs.writeFileSync(tmp, opts.text);
  fs.renameSync(tmp, final);

  return appendBusLogEvent(
    {
      ts,
      source: opts.source,
      destination: opts.recipient,
      kind: opts.kind,
      text: opts.text,
    },
    logPath,
  );
}

/**
 * Render the chain briefing message for one participant. Sent to each
 * worker's inbox at chain start, before any task input lands. Concatenated
 * with the first real message when the worker's Stop hook drains the inbox.
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
    isLast
      ? `You are the last step. When you finish, send your final reply to the sink so Cebab can archive the iteration:`
      : `When you finish your work, send your reply to the next step:`,
    ``,
    `    bus-send-msg.sh --kind ${isLast ? 'final' : 'reply'} ${sanitizeForPrompt(nextHop)} "<your reply>"`,
    ``,
    `Or pipe via stdin for a longer reply:`,
    ``,
    `    echo "<your reply>" | bus-send-msg.sh --kind ${isLast ? 'final' : 'reply'} ${sanitizeForPrompt(nextHop)}`,
    ``,
    `Do not message anyone else. Wait for further instructions; the next message in your inbox is the actual task input.`,
  ].join('\n');
}

/**
 * Render the session-intro message Cebab writes into the orchestrator's
 * inbox at orchestrator-routed session start. Lists the participants by
 * bus slug + project name so the orchestrator knows who's available,
 * instructs it to send `intro` to each (with a capability-handshake ask
 * so workers self-describe), and surfaces the hop budget.
 *
 * The text is plain English (not JSON) — the recipient is a language model,
 * not a parser. Symmetric in style with `renderChainBriefing`. Pure
 * function with no IO so it's straightforward to unit-test.
 *
 * Note: the orchestrator's CLAUDE.md template documents the same
 * capability-handshake flow at a higher level; this prompt is the
 * per-session reminder with the concrete `bus-send-msg.sh` example.
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
    `You are the orchestrator for a new multi-agent session. The participants below are running in their own tmux windows and have been briefed on the bus protocol; they're waiting for you to introduce them to the conversation.`,
    ``,
    `Participants:`,
    ...workers.map((w) => `- ${tagAgent(w.agentName)} — ${sanitizeForPrompt(w.projectName)}`),
    ``,
    `The bus slugs and project names above are what Cebab knows. You don't yet know what each agent is best at — that's what Step 1 is for.`,
    ``,
    `Step 1: send a \`kind=intro\` message to each participant. Tell them they're in a multi-agent conversation, name the other participants, ask them to reply only to you, AND ask them to send back a brief (2-3 sentence) self-description so you know what kinds of tasks each one is best at. Example for ${tagAgent(firstAgent)}:`,
    ``,
    `    bus-send-msg.sh --kind intro ${firstAgentSafe} "You are part of a multi-agent conversation. Other participants: ${otherAgents}. Reply only to me (orchestrator). Before we start: please send me a brief (2-3 sentence) reply describing your role, areas of expertise, and the kinds of tasks you're best at. I'll use this to route user prompts to whoever fits best."`,
    ``,
    `Step 2: wait for each worker's \`kind=reply\` with their self-description before routing the first user prompt. The user's first prompt is the next message in your inbox after this one — but route it only after you've collected capability replies from every participant. Use those descriptions to inform routing.`,
    ``,
    `Hop budget: ${hopBudget} hops per user prompt (soft cap — do a progress self-check at hop 5). Intro replies don't count toward the budget.`,
    ``,
    `When you have a complete answer for the user, send \`kind=final\` to recipient \`user\` — Cebab forwards that to the operator's chat UI.`,
  ].join('\n');
}

/**
 * Roster update for a mid-session `add_multi_agent_participant`. Sent
 * to the orchestrator's inbox so the LLM learns about the new
 * participant on its next turn. Same `<participant>` sanitization +
 * delimiting as `renderRosterPrompt`.
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
    `Send the new participant a \`kind=intro\` message and collect their capability self-description, same as Step 1 of the original roster. Example:`,
    ``,
    `    bus-send-msg.sh --kind intro ${newAgentSafe} "You are joining a multi-agent conversation already in progress. Reply only to me (orchestrator). Please send a brief (2-3 sentence) reply describing your role, areas of expertise, and the kinds of tasks you're best at."`,
    ``,
    `Once they reply, route to them just like any existing worker. Hop budget for the current user prompt remains ${hopBudget}.`,
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
 * at chain start to validate every participant before any tmux session is
 * spawned (cheaper to bail early than to tear down a half-spawned session).
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
