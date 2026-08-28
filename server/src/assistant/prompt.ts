// Cebab-8x8.2.1: compose the help assistant's system prompt from three parts.
//
// A help turn's `systemPrompt` is Cebab-authored and mixes two on-disk files
// (the persona in `assistant/PROMPT.md`, the KB router in
// `assistant/kb/00-index.md`) with a per-turn RUNTIME SNAPSHOT of the app's
// live state. This module owns that composition. It is a sibling of the static
// `ASSISTANT_SYSTEM_PROMPT` in `identity.ts`: that string fills the blank while
// the KB does not exist; this composer is what a real help turn runs once it
// does.
//
// Three properties are load-bearing and each has its own reason:
//
//   1. It ships a PLAIN STRING, never the `{ type: 'preset', preset:
//      'claude_code' }` option. That preset is a coding-agent preamble (tool
//      guidance, working-directory/git sections) and is exactly wrong for a
//      three-read-tool help widget. `Cebab-ws0.15` measured that an omitted
//      `systemPrompt` is the empty override, so this string ADDS where there
//      was nothing rather than replacing a preset that was never there.
//
//   2. The two file bodies are MEMOIZED on their `mtimeMs`, so a warm turn does
//      not re-read and re-defang two files, but an edited KB doc is picked up
//      the moment either mtime moves. The snapshot is never memoized — it is a
//      fresh argument each call.
//
//   3. The whole thing is SIZE-CAPPED and DELIMITER-DEFANGED the way
//      `bus/runtime.ts` frames an injected CLAUDE.md. The runtime snapshot is a
//      Cebab-authored block a KB doc must not be able to forge or close early,
//      so the file bodies are broken against the snapshot delimiters before
//      composition, and the composed result is truncated at a fixed codepoint
//      cap with a visible marker.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readTextPrefixBounded } from '../safe_fs.js';
import { assistantKbRoot } from './identity.js';

/**
 * Hard codepoint cap on the composed prompt. Mirrors the old
 * `MAX_PROJECT_CLAUDE_MD = 16000` codepoint cap `bus/runtime.ts` used to apply
 * (see `MAX_PROJECT_CLAUDE_MD_BYTES` there for why the byte cap replaced it in
 * that path) — lower here because a help turn's budget is fixed and small: the
 * persona plus the router plus the snapshot is ~1800–2000 tokens, and a KB doc
 * that grows past that gets cut rather than crowding out the persona and the
 * live facts, which are placed FIRST for exactly this reason.
 */
export const ASSISTANT_PROMPT_MAX_CODEPOINTS = 12000;

/**
 * Byte cap on each individual file read. Bounds the allocation for a
 * pathologically large (or hostile) KB file before the codepoint cap runs —
 * same role `MAX_PROJECT_CLAUDE_MD_BYTES` plays for the injected CLAUDE.md. A
 * 5 MB `00-index.md` is read as its first 64 KiB and then truncated to the
 * codepoint cap.
 */
const FILE_READ_MAX_BYTES = 64 * 1024;

/**
 * Frame around the Cebab-authored runtime snapshot. The snapshot is the only
 * part of the prompt the assistant should treat as authoritative live state, so
 * it is fenced and the file bodies are defanged against these exact delimiters
 * — a KB doc that quotes `</cebab_runtime_snapshot>` (a troubleshooting page
 * might) must not be able to close the frame early and append its own "facts".
 *
 * The two are independent — `<cebab_runtime_snapshot>` is not a substring of
 * `</cebab_runtime_snapshot>` (the second char of the close is `/`) — so the
 * defang passes are order-free, exactly like `defangBusDelimiters`.
 */
export const RUNTIME_SNAPSHOT_OPEN = '<cebab_runtime_snapshot>';
export const RUNTIME_SNAPSHOT_CLOSE = '</cebab_runtime_snapshot>';

/**
 * Zero-width space built from its code point so this source never holds a
 * literal invisible character — the technique `bus/message_fence.ts` uses.
 */
const ZWSP = String.fromCharCode(0x200b);

/** Insert a ZWSP after the run's first character. Insertion, not deletion:
 *  every original byte survives, so a human reading the prompt still sees the
 *  delimiter they expect, but it no longer matches exactly. */
function breakRun(run: string): string {
  return `${run[0]}${ZWSP}${run.slice(1)}`;
}

/**
 * Break the runtime-snapshot delimiters inside untrusted-ish text (a KB file
 * body, or the operator-chosen workspace-root path). After this the string can
 * be QUOTED into the prompt but can never be STRUCTURAL: it cannot open or
 * close the snapshot frame.
 */
export function defangSnapshotDelimiters(text: string): string {
  let out = text;
  for (const d of [RUNTIME_SNAPSHOT_OPEN, RUNTIME_SNAPSHOT_CLOSE]) {
    out = out.split(d).join(breakRun(d));
  }
  return out;
}

/**
 * Collapse every whitespace/control/format character to a single space and
 * defang the snapshot delimiters, so an operator-chosen workspace root — which
 * can contain a newline on a hostile filesystem — becomes one structural-safe
 * token. Same shape as `quoteFlat` in `runner/mcp_status_note.ts`, minus the
 * JSON quoting: the value here is rendered on its own `key: value` line.
 */
function flattenForSnapshot(raw: string): string {
  const flat = raw.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim();
  return defangSnapshotDelimiters(flat);
}

/**
 * The live app state the assistant is allowed to know. COUNTS AND ENUMS ONLY —
 * no project names, no session content, and no path other than the workspace
 * root (which is flattened and defanged). This is what lets the assistant
 * answer "why is my project not showing up" from the counts without ever
 * reading a file the operator wrote.
 */
export type RuntimeSnapshot = {
  /** The configured workspace root, or null when none is set. Rendered
   *  flattened + defanged; it is the ONLY path the snapshot carries. */
  workspaceRoot: string | null;
  /** Whether that root resolves to an existing directory on disk. */
  workspaceRootResolves: boolean;
  /** Total projects the sidebar would list (workspace kind only). */
  projectCount: number;
  /** How many of those are Trusted. */
  trustedCount: number;
  /** Mock mode on/off (MOCK=1). */
  mock: boolean;
  /** The view the operator is currently on (an enum label, never free text). */
  activeView: string;
  /** The active theme gamma (an enum label). */
  theme: string;
  /** Cebab server version. */
  serverVersion: string;
  /** The `claude` CLI version, or null when it has not been probed yet. */
  cliVersion: string | null;
  /** Whether a multi-agent (bus) session is currently running. */
  multiAgentRunning: boolean;
};

const yn = (b: boolean): string => (b ? 'yes' : 'no');

/**
 * Render the runtime snapshot as a fenced, `key: value` block. Cebab-authored,
 * structured, and clearly delimited so the assistant can lean on it as live
 * state while never mistaking a KB doc's prose for it.
 */
export function renderRuntimeSnapshot(s: RuntimeSnapshot): string {
  return [
    RUNTIME_SNAPSHOT_OPEN,
    'The block below is written by Cebab itself — not by any file or user — and',
    'describes the running app right now. Trust it as authoritative live state.',
    'It is counts and settings only: no project names, no session content, no',
    'file contents, and no path other than the workspace root.',
    '',
    `workspace_root: ${s.workspaceRoot === null ? '(not set)' : flattenForSnapshot(s.workspaceRoot)}`,
    `workspace_root_resolves: ${yn(s.workspaceRootResolves)}`,
    `project_count: ${s.projectCount}`,
    `trusted_project_count: ${s.trustedCount}`,
    `mock_mode: ${s.mock ? 'on' : 'off'}`,
    `active_view: ${flattenForSnapshot(s.activeView)}`,
    `theme: ${flattenForSnapshot(s.theme)}`,
    `server_version: ${flattenForSnapshot(s.serverVersion)}`,
    `cli_version: ${s.cliVersion === null ? 'unknown' : flattenForSnapshot(s.cliVersion)}`,
    `multi_agent_session_running: ${yn(s.multiAgentRunning)}`,
    RUNTIME_SNAPSHOT_CLOSE,
  ].join('\n');
}

/** The two on-disk source files. Overridable so a test drives the composer
 *  against fixtures without touching the shipped KB. */
export type PromptSources = {
  /** `assistant/PROMPT.md` — persona, scope, refusal rules, citation contract. */
  promptPath: string;
  /** `assistant/kb/00-index.md` — the doc router. */
  indexPath: string;
};

/**
 * Resolve the shipped source paths from `assistantKbRoot()`. `PROMPT.md` sits
 * beside `kb/` (one level up), `00-index.md` inside it. Returns null when the
 * KB is not on disk — the same "not yet shipped" state `assistantKbRoot`
 * encodes — so a caller can fall back to the static prompt.
 */
export function defaultPromptSources(): PromptSources | null {
  const kb = assistantKbRoot();
  if (!kb) return null;
  return {
    promptPath: path.join(kb, '..', 'PROMPT.md'),
    indexPath: path.join(kb, '00-index.md'),
  };
}

type FileCacheEntry = { mtimeMs: number; body: string };
/** Per-path memo of the DEFANGED body, keyed on `mtimeMs`. Module-level so it
 *  survives across turns; keyed by absolute path so the two files never
 *  collide. */
const fileCache = new Map<string, FileCacheEntry>();

/**
 * Read a source file's body, memoized on its `mtimeMs` and already defanged
 * against the snapshot delimiters. A missing/unreadable file yields '' and
 * clears any stale cache entry, so the composer degrades to whichever bodies
 * it can read rather than throwing on a KB that is mid-write.
 *
 * `mtimeMs` is stat-ed separately from the bounded read: the read caps the
 * allocation, the stat is the cache key. A changed mtime — even to a value in
 * the past, as an editor or a test's `utimesSync` can produce — is a miss.
 */
function readMemoizedBody(filePath: string): string {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    fileCache.delete(filePath);
    return '';
  }
  const hit = fileCache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.body;

  const read = readTextPrefixBounded(filePath, FILE_READ_MAX_BYTES);
  const body = read.ok ? defangSnapshotDelimiters(read.text) : '';
  fileCache.set(filePath, { mtimeMs, body });
  return body;
}

/** Truncate to a codepoint cap, appending a visible marker when it bites. The
 *  result is always ≤ `max` codepoints (the marker is counted). */
function truncateCodepoints(text: string, max: number): string {
  const cps = Array.from(text);
  if (cps.length <= max) return text;
  const marker = `\n\n[…truncated by Cebab at ${max} codepoints…]`;
  const keep = Math.max(0, max - Array.from(marker).length);
  return cps.slice(0, keep).join('') + marker;
}

/**
 * Compose the assistant's system prompt: persona, then the runtime snapshot,
 * then the KB router — persona and snapshot FIRST so a bloated router is what
 * the codepoint cap sacrifices, never the identity or the live facts.
 *
 * Returns a PLAIN STRING (acceptance: never a preset object). When `sources`
 * is omitted it resolves the shipped paths; when the KB is absent it composes
 * from whatever it can read, which for a missing persona/router is just the
 * snapshot — a degraded but honest prompt rather than a throw.
 */
export function assistantSystemPrompt(
  snapshot: RuntimeSnapshot,
  sources: PromptSources | null = defaultPromptSources(),
): string {
  const persona = sources ? readMemoizedBody(sources.promptPath) : '';
  const router = sources ? readMemoizedBody(sources.indexPath) : '';
  const parts = [persona, renderRuntimeSnapshot(snapshot), router].filter((p) => p.length > 0);
  return truncateCodepoints(parts.join('\n\n'), ASSISTANT_PROMPT_MAX_CODEPOINTS);
}

/**
 * The sha256 of a composed prompt, hex. The transcript persists one
 * `{ type: 'wrapper', subtype: 'assistant_prompt', promptSha256 }` record
 * before the stream loop so the on-disk history records WHICH prompt actually
 * ran without storing the (large, per-turn) bytes; `translate()` returns null
 * for that subtype, so it never becomes a stray bubble in the popup.
 */
export function assistantPromptSha256(prompt: string): string {
  return crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
}
