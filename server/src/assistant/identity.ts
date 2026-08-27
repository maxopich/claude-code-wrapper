// Cebab-8x8.1.1: the Cebab-owned help-assistant's server-side identity.
//
// The assistant runs through the existing single-agent path as an ordinary
// `projects` row, so Trust, sessions, replay and interrupt all work on it
// unchanged — but it must NEVER be mistaken for one of the operator's workspace
// projects. That distinction is the `projects.kind` column (migration 040): a
// fail-closed discriminator read positively everywhere, not a path comparison
// that could normalise wrong. This module owns the constants and the one writer
// that mints/repairs the assistant row.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db.js';
import { findProjectByPath, getProject, type ProjectRow } from '../repo/projects.js';
import type { SettingSource } from '../runner/claude.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The assistant row's `name`. The `/` is load-bearing: a slash cannot appear in
 * a scanned directory's basename, so `projects.name`'s UNIQUE constraint can
 * never collide the assistant with a workspace project the operator happens to
 * have named "assistant". The collision is structurally unreachable, not merely
 * unlikely.
 */
export const ASSISTANT_PROJECT_NAME = 'cebab/assistant';

/**
 * The assistant's per-session turn cap. Smaller than a workspace project's
 * budget because a help answer is a few reads plus a reply, and an unbounded
 * assistant turn spends subscription quota with no operator watching.
 */
export const ASSISTANT_MAX_TURNS = 12;

/**
 * The assistant's own system prompt. Cebab sets no system prompt on any other
 * turn (Cebab-ws0.15), so this fills a blank rather than replacing a preset —
 * measured, and the one claim `src/system_prompt_smoke.ts` keeps honest.
 *
 * It states the identity and the hard boundary the posture below enforces
 * mechanically: read-only, answers from the bundled knowledge base, never
 * touches the operator's files. The prompt is advice; `assistantSpawnPosture`
 * is the brake.
 */
export const ASSISTANT_SYSTEM_PROMPT = [
  'You are the Cebab help assistant, built in to the Cebab app.',
  'Your job is to answer the operator’s questions about Cebab — what it does,',
  'how its projects, Trust model, permissions, and multi-agent bus work — using',
  'the knowledge-base files in your working directory.',
  '',
  'You are strictly read-only. You may Read, Glob, and Grep the knowledge base to',
  'find answers. You cannot and must not edit, create, delete, or run anything,',
  'and you have no access to the operator’s own projects. If a question needs an',
  'action you cannot take, say so and explain what the operator would do instead.',
  'If the knowledge base does not cover something, say you do not know rather than',
  'guessing.',
].join('\n');

/**
 * The built-in tools an assistant turn may use: read-only inspection of the KB
 * and nothing else. Passed as SDK `Options.tools`, which is the base-set filter.
 */
export const ASSISTANT_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep'];

/**
 * Belt to the `ASSISTANT_TOOLS` suspenders: every mutating / executing built-in
 * named explicitly in `disallowedTools` so it is stripped from context even if a
 * future SDK default or a stray setting would otherwise surface it. Deliberately
 * disjoint from `ASSISTANT_TOOLS` — Read/Glob/Grep are the only survivors.
 */
export const ASSISTANT_DISALLOWED_TOOLS: readonly string[] = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Task',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
];

/**
 * The complete spawn posture for an assistant turn, as a plain data object so a
 * unit test pins the values rather than reading them out of the giant
 * `runOneTurn` switch arm. Pure: give it the `cwd` (the KB directory), get back
 * every option that differs from an ordinary single-agent run.
 *
 * What the caller still owns, because it is not expressible here: forcing
 * `trusted` false (a source-scanned line in `runOneTurn`, since
 * `shouldAutoAllow` treats a trusted project as auto-allow-everything), gating
 * with an empty scope set, a meta-less `registerQuery`, and skipping the
 * session-start cache. Those touch live connection state; this object is the
 * part that is pure.
 */
export type AssistantPosture = {
  cwd: string;
  permissionMode: 'default';
  settingSources: SettingSource[];
  maxTurns: number;
  systemPrompt: string;
  tools: string[];
  skills: string[];
  disallowedTools: string[];
};

export function assistantSpawnPosture(cwd: string): AssistantPosture {
  return {
    cwd,
    // Never auto-allow: the assistant is not Trusted, so every tool routes
    // through the permission gate.
    permissionMode: 'default',
    // Empty scope set: no ~/.claude, no project settings, no CLAUDE.md, no
    // project-declared MCP servers or env injections layered into the turn.
    settingSources: [],
    maxTurns: ASSISTANT_MAX_TURNS,
    systemPrompt: ASSISTANT_SYSTEM_PROMPT,
    tools: [...ASSISTANT_TOOLS],
    // `[]`, not omitted: omitting leaves the CLI's skills on (per SDK docs),
    // and a help turn should see none.
    skills: [],
    disallowedTools: [...ASSISTANT_DISALLOWED_TOOLS],
  };
}

/**
 * The KB directory the assistant reads and runs its `cwd` inside, or `null`
 * when it is absent.
 *
 * Resolved by the same two-candidate walk `fixturesDir()` uses
 * (`runner/mock.ts:9-18`) so it works whether this module is running from
 * `src/` (tsx) or `dist/` (tsc build). tsc never copies `*.md` into
 * `server/dist/`, so the KB cannot live under `server/` — it sits at the repo
 * root beside `fixtures/`, at `assistant/kb/`.
 *
 * Returns `null` rather than throwing (unlike `fixturesDir`) because "the KB
 * is not on disk yet" is a supported state: the KB content ships in a later
 * slice, and until it does `ensureAssistantProject` mints nothing and the
 * client hides the assistant button.
 */
export function assistantKbRoot(): string | null {
  // src/assistant/identity.ts → ../../../assistant/kb
  // dist/assistant/identity.js → ../../../assistant/kb (or ../../assistant/kb)
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'assistant', 'kb'),
    path.resolve(__dirname, '..', '..', 'assistant', 'kb'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * The single reader of the discriminator. Positive by construction — a row is
 * the assistant iff it says so, and every other row (workspace or managed) is
 * not, with no path in the decision.
 */
export function isAssistantProject(p: Pick<ProjectRow, 'kind'>): boolean {
  return p.kind === 'assistant';
}

/**
 * Ensure exactly one `kind = 'assistant'` row exists, and return it — or `null`
 * when the KB is absent.
 *
 * Called lazily from `emitSettings`, gated on `assistantKbRoot()`. The `kbRoot`
 * parameter defaults to that resolver and is the row's `path` (the assistant's
 * `cwd` is the KB directory itself); tests pass an explicit directory for the
 * present case and `null` for the absent case.
 *
 * WHY IT NEVER BLIND-INSERTS. `emitSettings` is synchronous and its only error
 * handler is the `.catch()` on the connection: a throw here means the client
 * never receives the settings envelope AT ALL — on every connection,
 * permanently, recoverable only by hand-editing SQLite. So both ways an INSERT
 * could raise SQLITE_CONSTRAINT are eliminated BEFORE any INSERT:
 *
 *   1. Look up by `kind = 'assistant'` first — the row's stable identity, at
 *      most one thanks to `projects_kind_singleton`. If found, repair and
 *      return; the path may have drifted (a moved checkout) but the row stays.
 *   2. Otherwise look up by PATH. If a row already sits at the KB path — a scan
 *      that reached inside the repo, or a stale row from a prior checkout —
 *      repair it in place. A blind INSERT here would raise UNIQUE(projects.path).
 *   3. Only when NEITHER exists is a row inserted, which is therefore a guarded
 *      INSERT, not a blind one: both collision sources were just checked.
 *
 * Repairs `trusted=0, missing=0, bus_installed=0, bus_agent_name=NULL` so a row
 * that drifted (a scan flipped it to `missing=1`, an operator toggled Trust, a
 * bus install stamped it) is returned to the Cebab-owned posture every time.
 */
export function ensureAssistantProject(
  kbRoot: string | null = assistantKbRoot(),
): ProjectRow | null {
  if (!kbRoot) return null;
  const db = getDb();

  const byKind = db
    .prepare<[], ProjectRow>(`SELECT * FROM projects WHERE kind = 'assistant'`)
    .get();
  if (byKind) return repairAssistantRow(byKind, kbRoot);

  const byPath = findProjectByPath(kbRoot);
  if (byPath) return repairAssistantRow(byPath, kbRoot);

  const result = db
    .prepare(
      `INSERT INTO projects (name, path, kind, created_at, last_used_at)
       VALUES (?, ?, 'assistant', ?, NULL)`,
    )
    .run(ASSISTANT_PROJECT_NAME, kbRoot, Date.now());
  return getProject(Number(result.lastInsertRowid))!;
}

/**
 * Force an existing row to the Cebab-owned assistant posture and return it with
 * the SAME id. Every field a scan, a trust toggle or a bus install could have
 * moved is written back, unconditionally — a repair that only fixed the fields
 * it noticed drifting would leave the others as a slow-growing hazard.
 */
function repairAssistantRow(row: ProjectRow, kbRoot: string): ProjectRow {
  getDb()
    .prepare(
      `UPDATE projects
          SET kind = 'assistant',
              name = ?,
              path = ?,
              trusted = 0,
              missing = 0,
              bus_installed = 0,
              bus_agent_name = NULL
        WHERE id = ?`,
    )
    .run(ASSISTANT_PROJECT_NAME, kbRoot, row.id);
  return getProject(row.id)!;
}
