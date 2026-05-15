import { useEffect, useRef, useState } from 'react';
import type { Project, SessionSummary } from '@cebab/shared/protocol';
import { ClaudeMark } from './ClaudeMark';

export function ProjectList(props: {
  projects: Project[];
  activeProjectId: number | null;
  activeSessionByProject: Record<number, string | undefined>;
  knownSessions: Record<number, SessionSummary[]>;
  liveSessions: Record<string, true>;
  onSelectProject: (id: number) => void;
  onSelectSession: (projectId: number, sessionId: string) => void;
  onNewSession: (projectId: number) => void;
  onToggleTrust: (id: number, trusted: boolean) => void;
  onUninstallBus: (projectId: number) => void;
  onRenameSession: (sessionId: string, title: string | null) => void;
}) {
  return (
    <ul className="project-list">
      {props.projects.map((p) => {
        const expanded = p.id === props.activeProjectId;
        const sessions = props.knownSessions[p.id] ?? [];
        const activeSessionId = props.activeSessionByProject[p.id];
        const projectIsLive = sessions.some((s) => props.liveSessions[s.id]);
        return (
          <li key={p.id} className={`project-row ${expanded ? 'expanded' : ''}`}>
            <div
              className={`project-header ${expanded ? 'active' : ''}`}
              title={
                p.hasClaudeMd
                  ? undefined
                  : `No CLAUDE.md found in ${p.path} — this folder doesn't look like an agent project. You can still run Claude here, but project-level instructions, skills, and MCP servers won't auto-load.`
              }
              draggable
              onDragStart={(e) => {
                // JSON payload with a kind tag so the Multi-Agent drop zone
                // can validate that it came from us rather than another app.
                e.dataTransfer.setData(
                  'application/json',
                  JSON.stringify({ kind: 'cebab-project', id: p.id }),
                );
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => props.onSelectProject(p.id)}
            >
              <span
                className={`project-live-dot ${projectIsLive ? 'on' : ''}`}
                title={projectIsLive ? 'session running' : ''}
              />
              {p.hasClaudeMd ? (
                <ClaudeMark className="claude-mark" title="Agent project (CLAUDE.md present)" />
              ) : (
                <span className="claude-mark-spacer" aria-hidden="true" />
              )}
              <span className="project-name">{p.name}</span>
              {p.busInstalled && (
                <button
                  className="bus-installed-pill"
                  title={`Bus integration installed (agent: ${p.busAgentName ?? '?'}).\nClick to uninstall: removes the @import line from CLAUDE.md and Cebab-owned entries from .claude/settings.json. Operator content is preserved. Inboxes and archive under the session folder are left in place.`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const ok = window.confirm(
                      `Uninstall bus integration from "${p.name}"?\n\nThis removes the @import line from CLAUDE.md and the Cebab-owned entries from .claude/settings.json. Operator content is preserved.`,
                    );
                    if (ok) props.onUninstallBus(p.id);
                  }}
                >
                  bus
                </button>
              )}
              <button
                className={`trust ${p.trusted ? 'on' : 'off'}`}
                title={p.trusted ? 'Trusted (auto-approve tools)' : 'Asks before tool use'}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onToggleTrust(p.id, !p.trusted);
                }}
              >
                {p.trusted ? 'trusted' : 'asks'}
              </button>
            </div>
            {expanded && (
              <ul className="session-list">
                <li
                  className={`session-row new ${!activeSessionId ? 'active' : ''}`}
                  onClick={() => props.onNewSession(p.id)}
                >
                  <span className="session-marker">+</span>
                  <span className="session-name">new chat</span>
                </li>
                {sessions.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    live={props.liveSessions[s.id] === true}
                    active={s.id === activeSessionId}
                    onSelect={() => props.onSelectSession(p.id, s.id)}
                    onRename={(title) => props.onRenameSession(s.id, title)}
                  />
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SessionRow(props: {
  session: SessionSummary;
  live: boolean;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string | null) => void;
}) {
  const { session: s } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus + select-all when entering edit mode so the user can immediately
  // type a new name or overwrite the existing one.
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function startEdit() {
    setDraft(s.title ?? '');
    setEditing(true);
  }
  function commit() {
    if (!editing) return;
    setEditing(false);
    const trimmed = draft.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    // Don't dispatch if the value hasn't actually changed — avoids a useless
    // server round-trip on the common "open edit, hit Esc by reflex" path.
    if (next !== (s.title ?? null)) props.onRename(next);
  }
  function cancel() {
    setEditing(false);
  }

  return (
    <li
      className={`session-row ${props.active ? 'active' : ''} ${editing ? 'editing' : ''}`}
      title={
        editing
          ? undefined
          : `${s.id}\n${formatRelative(s.lastEventAt)} • $${s.totalCostUsd.toFixed(4)}\nDouble-click name to rename`
      }
      onClick={() => {
        if (!editing) props.onSelect();
      }}
    >
      <span
        className={`session-marker ${props.live ? 'live' : ''}`}
        title={props.live ? 'running on this connection' : ''}
      />
      {editing ? (
        <input
          ref={inputRef}
          className="session-name-input"
          value={draft}
          maxLength={80}
          placeholder={s.id.slice(0, 8)}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={commit}
        />
      ) : (
        <span
          className="session-name"
          onDoubleClick={(e) => {
            e.stopPropagation();
            startEdit();
          }}
        >
          {s.title || s.id.slice(0, 8)}
        </span>
      )}
      {!editing && (
        <button
          className="session-rename-btn"
          title="Rename session"
          aria-label="Rename session"
          onClick={(e) => {
            e.stopPropagation();
            startEdit();
          }}
        >
          ✎
        </button>
      )}
      {!editing && <span className="session-meta">{formatRelative(s.lastEventAt)}</span>}
    </li>
  );
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}
