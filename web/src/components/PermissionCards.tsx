/**
 * Item #5 — per-tool permission card subcomponents.
 *
 * The single-agent permission card used to render a raw `JSON.stringify(input,
 * null, 2)` blob for every tool — Bash, Write, Edit, Read all looked the same.
 * The operator approving a `Bash("rm -rf node_modules")` had to read past the
 * JSON quoting to understand what they were about to allow.
 *
 * The server now classifies every `canUseTool` request via the shared
 * `classifyToolCall` and ships `category` / `summary` / `cwd` / `projectName`
 * alongside `toolName` / `input`. This module dispatches on `toolName` to a
 * tool-specific subcomponent so each kind of call renders the parts an
 * operator actually wants to see:
 *
 *   - Bash → monospace command + optional description
 *   - Write → file path + size badge
 *   - Edit → minimal diff (old → new, truncated)
 *   - NotebookEdit → notebook path + cell id + mode
 *   - Read → file path + optional line range (no mutation styling)
 *   - unknown / pre-Item-5 → JSON-blob fallback (today's behavior)
 *
 * Subcomponents share the card frame ({@link MessageBlock} draws it); they
 * only return the inner body. Renders into a `.msg-body` that already has the
 * badge + actions row injected by the parent.
 */
import type { ReactNode } from 'react';
import type { MutationCategory } from '@cebab/shared';

/** Subset of the permission_request MessageView used by all subcomponents. */
export type PermissionMessageView = {
  toolName: string;
  input: unknown;
  summary?: string;
  cwd?: string;
  projectName?: string;
};

/** Dispatch to the right tool-specific body renderer. Falls back to a
 *  pretty-printed JSON dump for unknown tools and pre-Item-5 replays. */
export function renderPermissionBody(m: PermissionMessageView): ReactNode {
  const inp = m.input && typeof m.input === 'object' ? (m.input as Record<string, unknown>) : {};
  switch (m.toolName) {
    case 'Bash':
      return <BashPermissionCard input={inp} summary={m.summary} />;
    case 'Write':
      return <FileWritePermissionCard input={inp} cwd={m.cwd} />;
    case 'Edit':
      return <FileEditPermissionCard input={inp} cwd={m.cwd} />;
    case 'NotebookEdit':
      return <NotebookEditPermissionCard input={inp} cwd={m.cwd} />;
    case 'Read':
      return <FileReadPermissionCard input={inp} cwd={m.cwd} />;
    case 'Glob':
    case 'Grep':
      return <SearchPermissionCard input={inp} cwd={m.cwd} kind={m.toolName} />;
    default:
      return <GenericPermissionCard input={m.input} summary={m.summary} />;
  }
}

/** Human-readable badge label + tooltip for each mutation category. */
export function badgeTooltip(category: MutationCategory): string {
  switch (category) {
    case 'read':
      return 'Read-only call — does not modify the filesystem.';
    case 'mutate':
      return 'Mutating call — will create, modify, or delete files / state.';
    case 'dangerous':
      return 'Dangerous call — destructive, privilege-escalating, or runs arbitrary code.';
  }
}

// ---------------------------------------------------------------------------
// Per-tool subcomponents
// ---------------------------------------------------------------------------

function BashPermissionCard(props: {
  input: Record<string, unknown>;
  summary?: string;
}): ReactNode {
  const command = typeof props.input.command === 'string' ? props.input.command : '';
  const description =
    typeof props.input.description === 'string' ? props.input.description : undefined;
  return (
    <div className="permission-bash">
      <code className="permission-bash-command">{command || '(empty command)'}</code>
      {description && <div className="permission-bash-description">{description}</div>}
    </div>
  );
}

function FileWritePermissionCard(props: {
  input: Record<string, unknown>;
  cwd?: string;
}): ReactNode {
  const filePath = typeof props.input.file_path === 'string' ? props.input.file_path : '';
  const content = typeof props.input.content === 'string' ? props.input.content : '';
  const sizeLabel = formatBytes(byteLength(content));
  const preview = content.split('\n').slice(0, 8).join('\n');
  const truncated = content.length > preview.length;
  return (
    <div className="permission-file">
      <div>
        <code className="permission-file-path">{relativizePath(filePath, props.cwd)}</code>
        <span className="permission-file-size">{sizeLabel}</span>
      </div>
      {preview && (
        <pre className="permission-content-preview">
          {preview}
          {truncated ? '\n…' : ''}
        </pre>
      )}
    </div>
  );
}

function FileEditPermissionCard(props: {
  input: Record<string, unknown>;
  cwd?: string;
}): ReactNode {
  const filePath = typeof props.input.file_path === 'string' ? props.input.file_path : '';
  const oldStr = typeof props.input.old_string === 'string' ? props.input.old_string : '';
  const newStr = typeof props.input.new_string === 'string' ? props.input.new_string : '';
  const replaceAll = props.input.replace_all === true;
  // Truncate each side independently — long strings are common in Edit calls.
  const oldDisplay = oldStr.length > 200 ? oldStr.slice(0, 200) + '…' : oldStr;
  const newDisplay = newStr.length > 200 ? newStr.slice(0, 200) + '…' : newStr;
  return (
    <div className="permission-file">
      <div>
        <code className="permission-file-path">{relativizePath(filePath, props.cwd)}</code>
        {replaceAll && <span className="permission-replace-all"> · replace ALL occurrences</span>}
      </div>
      <pre className="permission-diff">
        <del>{oldDisplay}</del>
        {'\n'}
        <ins>{newDisplay}</ins>
      </pre>
    </div>
  );
}

function NotebookEditPermissionCard(props: {
  input: Record<string, unknown>;
  cwd?: string;
}): ReactNode {
  const notebook = typeof props.input.notebook_path === 'string' ? props.input.notebook_path : '';
  const cell = typeof props.input.cell_id === 'string' ? props.input.cell_id : '';
  const mode = typeof props.input.edit_mode === 'string' ? props.input.edit_mode : 'replace';
  const newSource = typeof props.input.new_source === 'string' ? props.input.new_source : '';
  const preview = newSource.split('\n').slice(0, 6).join('\n');
  return (
    <div className="permission-file">
      <div>
        <code className="permission-file-path">{relativizePath(notebook, props.cwd)}</code>
        {cell && <span className="permission-cell-id"> · cell {cell}</span>}
        <span className="permission-replace-all"> · {mode}</span>
      </div>
      {preview && <pre className="permission-content-preview">{preview}</pre>}
    </div>
  );
}

function FileReadPermissionCard(props: {
  input: Record<string, unknown>;
  cwd?: string;
}): ReactNode {
  const filePath = typeof props.input.file_path === 'string' ? props.input.file_path : '';
  const offset = typeof props.input.offset === 'number' ? props.input.offset : undefined;
  const limit = typeof props.input.limit === 'number' ? props.input.limit : undefined;
  const range =
    offset !== undefined || limit !== undefined
      ? ` [lines ${offset ?? 1}${limit !== undefined ? `–${(offset ?? 1) + limit - 1}` : '+'}]`
      : '';
  return (
    <div className="permission-file">
      <code className="permission-file-path">
        {relativizePath(filePath, props.cwd)}
        {range}
      </code>
    </div>
  );
}

function SearchPermissionCard(props: {
  input: Record<string, unknown>;
  cwd?: string;
  kind: 'Glob' | 'Grep';
}): ReactNode {
  const pattern = typeof props.input.pattern === 'string' ? props.input.pattern : '';
  const path = typeof props.input.path === 'string' ? props.input.path : (props.cwd ?? '');
  return (
    <div className="permission-file">
      <code className="permission-file-path">
        {props.kind.toLowerCase()} "{pattern}" in {path || '(cwd)'}
      </code>
    </div>
  );
}

function GenericPermissionCard(props: { input: unknown; summary?: string }): ReactNode {
  return (
    <>
      {props.summary && <div className="permission-summary-line">{props.summary}</div>}
      <pre>{JSON.stringify(props.input, null, 2)}</pre>
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 2 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`;
}

function byteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  return s.length;
}

/** If `absPath` lives inside `cwd`, return the relative slice; else absolute. */
function relativizePath(absPath: string, cwd: string | undefined): string {
  if (!cwd) return absPath;
  if (!absPath.startsWith(cwd)) return absPath;
  const rest = absPath.slice(cwd.length);
  if (rest === '' || rest === '/') return '.';
  return rest.startsWith('/') ? rest.slice(1) : rest;
}
