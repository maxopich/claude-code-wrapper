import type { Project, SessionSummary } from '@cebab/shared/protocol';

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
              onClick={() => props.onSelectProject(p.id)}
            >
              <span
                className={`project-live-dot ${projectIsLive ? 'on' : ''}`}
                title={projectIsLive ? 'session running' : ''}
              />
              <span className="project-name">{p.name}</span>
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
                {sessions.map((s) => {
                  const live = props.liveSessions[s.id] === true;
                  const isActive = s.id === activeSessionId;
                  return (
                    <li
                      key={s.id}
                      className={`session-row ${isActive ? 'active' : ''}`}
                      title={`${s.id}\n${formatRelative(s.lastEventAt)} • $${s.totalCostUsd.toFixed(4)}`}
                      onClick={() => props.onSelectSession(p.id, s.id)}
                    >
                      <span
                        className={`session-marker ${live ? 'live' : ''}`}
                        title={live ? 'running on this connection' : ''}
                      />
                      <span className="session-name">{s.title || s.id.slice(0, 8)}</span>
                      <span className="session-meta">{formatRelative(s.lastEventAt)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
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
