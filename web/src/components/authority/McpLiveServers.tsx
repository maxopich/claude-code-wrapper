/**
 * `Cebab-ormv`: what this project's MCP servers are doing NOW, and what the
 * operator can do about it.
 *
 * THIS IS NOT `McpServersList`, and the two must not be merged. That one
 * renders what a project DECLARES, from a file scan, with its TOFU trust state.
 * This one renders what a live session OBSERVES, from `mcpServerStatus()`. The
 * gap between them is the whole reason this feature exists: the operator's own
 * servers are claude.ai connectors with no on-disk declaration at all, so the
 * declared list is empty while six servers are live in every session — and one
 * of them has been sitting in `needs-auth`, contributing nothing, with Cebab
 * unable to say so or fix it.
 *
 * "Declared" and "effective" have been separate columns in this panel since
 * Cluster B; this is the effective half finally having a source.
 */
import type { McpServerLive } from '@cebab/shared';
import type { McpControlOp } from '@cebab/shared/protocol';
import { timeAgo } from '../../format.js';
import { AuthoritySection } from './AuthoritySection.js';
import { statusDotClass } from './McpServersList.js';
import { mcpActionsFor, useMcpActions, useMcpSlot } from './McpControlContext.js';

/** What each action's button says. Verbs, because every one of them DOES
 *  something to a live server rather than navigating anywhere. */
const ACTION_LABEL: Record<McpControlOp, string> = {
  status: 'Refresh',
  reconnect: 'Reconnect',
  authenticate: 'Authenticate',
  clear_auth: 'Sign out',
  toggle: 'Enable',
};

export type McpLiveServersProps = {
  projectId: number;
  /** Injected so tests can pin the relative timestamp instead of racing it. */
  now?: number;
};

export function McpLiveServers({ projectId, now = Date.now() }: McpLiveServersProps) {
  const slot = useMcpSlot(projectId);
  const { refresh, act } = useMcpActions();

  const refreshBtn = (
    <button
      type="button"
      className="ghost-btn authority-panel-refresh"
      onClick={() => refresh(projectId)}
      disabled={slot.status === 'loading' || (slot.status === 'ready' && slot.refreshing === true)}
    >
      {slot.status === 'loading' || (slot.status === 'ready' && slot.refreshing)
        ? 'Reading…'
        : 'Read live'}
    </button>
  );

  const count = slot.status === 'ready' ? slot.servers.length : undefined;

  return (
    <AuthoritySection
      title="Live MCP servers"
      {...(count !== undefined ? { count } : {})}
      sublabel={
        slot.status === 'ready'
          ? `read ${timeAgo(slot.receivedAt, now)}`
          : 'what a real session sees, not what the files declare'
      }
      trailing={refreshBtn}
    >
      <div className="mcp-live">
        {slot.status === 'idle' && (
          <p className="mcp-servers-empty">
            Not read yet. Reading spawns a short-lived session — it costs no model turn, but it does
            run this project&rsquo;s SessionStart hooks, so Cebab asks rather than polls.
          </p>
        )}
        {slot.status === 'loading' && <p className="mcp-servers-empty">Reading live MCP status…</p>}
        {slot.status === 'failed' && (
          <p className="mcp-servers-empty mcp-live-error">
            Could not read MCP status: {slot.error}
          </p>
        )}
        {slot.status === 'ready' && slot.servers.length === 0 && (
          <p className="mcp-servers-empty">
            This project loads no MCP servers. That is a real answer, not a failed read.
          </p>
        )}
        {slot.status === 'ready' && slot.error !== undefined && (
          // Beside the rows, never instead of them. A refused reconnect is
          // exactly when the list matters most.
          <p className="mcp-live-error">{slot.error}</p>
        )}
        {slot.status === 'ready' && slot.callbackUnsupported === true && (
          <p className="mcp-live-error">
            This server wants an OAuth callback delivered back to the session that started the flow.
            Cebab has not measured that path and will not pretend to support it — authorize this one
            from a terminal with <code>/mcp</code>.
          </p>
        )}
        {slot.status === 'ready' && slot.pendingAuth && (
          <p className="mcp-live-auth">
            Open this link to authorize <strong>{slot.pendingAuth.serverName}</strong>, then press
            Read live:{' '}
            <a href={slot.pendingAuth.authUrl} target="_blank" rel="noreferrer noopener">
              authorize
            </a>
          </p>
        )}
        {slot.status === 'ready' && slot.servers.length > 0 && (
          <ul className="mcp-servers-list">
            {slot.servers.map((server) => (
              <McpLiveRow
                key={server.name}
                server={server}
                busy={slot.busy && slot.busy.serverName === server.name ? slot.busy.op : null}
                onAct={(op) => act(projectId, op, server.name, op === 'toggle' ? true : undefined)}
              />
            ))}
          </ul>
        )}
      </div>
    </AuthoritySection>
  );
}

function McpLiveRow(props: {
  server: McpServerLive;
  busy: McpControlOp | null;
  onAct: (op: McpControlOp) => void;
}) {
  const { server, busy, onAct } = props;
  return (
    <li className="mcp-server-card mcp-live-row">
      <div className="mcp-server-header">
        <span className={`mcp-status-dot ${statusDotClass(server.status)}`} aria-hidden="true" />
        <span className="mcp-server-name">{server.name}</span>
        {/* The status STRING, printed. `mcp_status.ts` argues at length that
            Cebab must not translate these, and a panel that rendered "Broken"
            over an SDK value nobody has measured would be doing exactly that. */}
        <span className="mcp-scope-chip mcp-live-status">{server.status}</span>
        {server.scope && <span className="mcp-scope-chip">{server.scope}</span>}
        <span className="mcp-tool-count">
          {server.toolNames.length} tool{server.toolNames.length === 1 ? '' : 's'}
        </span>
      </div>
      {server.error && <p className="mcp-live-error">{server.error}</p>}
      <div className="mcp-live-actions">
        {mcpActionsFor(server.status).map((op) => (
          <button
            key={op}
            type="button"
            className="ghost-btn mcp-live-action"
            disabled={busy !== null}
            onClick={() => onAct(op)}
          >
            {busy === op ? '…' : ACTION_LABEL[op]}
          </button>
        ))}
      </div>
    </li>
  );
}
