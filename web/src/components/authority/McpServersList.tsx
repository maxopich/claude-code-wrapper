import { useState } from 'react';
import type { McpServerView } from '@cebab/shared/protocol';

// Cluster B Phase 6c (UI-B13 / B15 / spec §4.2 F1): MCP servers section of
// the AuthorityPanel.
//
// One card per declared MCP server. Each card answers:
//   - WHO    — `name` + tools it exposes
//   - WHERE  — `scope` chip (user / project / local / cebab-injected) +
//              `originPath` (which settings.json declared it)
//   - WHAT   — `command` + `args` from `config`
//   - TRUST  — `trust` chip from the mcp_trust JOIN (Phase 4):
//                trusted / pending_tofu / hash_changed / denied / unknown
//   - STATUS — runtime status dot (gray "configured" by default — UI-B15:
//              never reads "running" without server confirmation)
//
// The originPath has a copy-to-clipboard button per UI-B13 — sysops want to
// open the file in their editor without hunting through nested `.claude/`
// directories.
//
// BE-B12 [security]: `config.envKeys` is rendered as a list of NAMES only,
// never values. The shape on the wire already enforces this — we just keep
// it visible at the render layer so a future contributor doesn't add a
// "reveal value" affordance without thinking about it.

const STATUS_DOT_CLASS: Record<string, string> = {
  connected: 'mcp-status-ok',
  'needs-auth': 'mcp-status-warn',
  failed: 'mcp-status-err',
  disabled: 'mcp-status-muted',
  // Anything else (including 'configured', 'unknown', or an unrecognised
  // SDK string) falls through to the gray muted default per UI-B15.
};

const TRUST_CHIP_CLASS: Record<McpServerView['trust'], string> = {
  trusted: 'mcp-trust-ok',
  pending_tofu: 'mcp-trust-warn',
  hash_changed: 'mcp-trust-err',
  denied: 'mcp-trust-err',
  unknown: 'mcp-trust-muted',
};

const TRUST_LABEL: Record<McpServerView['trust'], string> = {
  trusted: 'trusted',
  pending_tofu: 'pending TOFU',
  hash_changed: 'hash changed',
  denied: 'denied',
  unknown: 'unknown',
};

const SCOPE_CHIP_CLASS: Record<McpServerView['scope'], string> = {
  user: 'mcp-scope-user',
  project: 'mcp-scope-project',
  local: 'mcp-scope-local',
  'cebab-injected': 'mcp-scope-cebab',
};

function statusDotClass(status: string): string {
  return STATUS_DOT_CLASS[status] ?? 'mcp-status-muted';
}

/**
 * Copy `text` to the clipboard. Uses the modern API when available; falls
 * back to a `document.execCommand('copy')` shim for older browsers. The
 * return value lets the caller flash a "copied" state. We intentionally
 * swallow errors — the affordance is non-critical and a hard failure would
 * just confuse the operator.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function McpServersList(props: { servers: McpServerView[] }) {
  const { servers } = props;
  if (servers.length === 0) {
    return (
      <div className="mcp-servers-empty">
        No MCP servers declared in this project. (Cebab&apos;s in-process bus_send injects only
        inside multi-agent runs and won&apos;t appear here.)
      </div>
    );
  }
  // Sort alphabetically so the list is stable across renders. Cebab-injected
  // sorts to the bottom because it's not operator-declared and shouldn't lead.
  const sorted = [...servers].sort((a, b) => {
    if (a.scope === 'cebab-injected' && b.scope !== 'cebab-injected') return 1;
    if (a.scope !== 'cebab-injected' && b.scope === 'cebab-injected') return -1;
    return a.name.localeCompare(b.name);
  });
  return (
    <ul className="mcp-servers-list" aria-label="Declared MCP servers">
      {sorted.map((s) => (
        <McpServerCard key={`${s.scope}:${s.name}`} server={s} />
      ))}
    </ul>
  );
}

function McpServerCard(props: { server: McpServerView }) {
  const { server } = props;
  const [copied, setCopied] = useState(false);
  async function onCopy() {
    if (!server.originPath) return;
    const ok = await copyToClipboard(server.originPath);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }
  return (
    <li className={`mcp-server-card mcp-server-card-${server.scope}`}>
      <header className="mcp-server-header">
        <span
          className={`mcp-status-dot ${statusDotClass(server.status)}`}
          aria-label={`runtime status: ${server.status}`}
          title={`Runtime status: ${server.status}`}
        />
        <span className="mcp-server-name">{server.name}</span>
        <span className={`mcp-scope-chip ${SCOPE_CHIP_CLASS[server.scope]}`}>{server.scope}</span>
        <span className={`mcp-trust-chip ${TRUST_CHIP_CLASS[server.trust]}`}>
          {TRUST_LABEL[server.trust]}
        </span>
        <span className="mcp-tool-count" aria-label={`exposes ${server.tools.length} tools`}>
          {server.tools.length} {server.tools.length === 1 ? 'tool' : 'tools'}
        </span>
      </header>
      <dl className="mcp-server-facts">
        {server.originPath && (
          <div className="mcp-server-fact">
            <dt>Declared in</dt>
            <dd className="mcp-server-origin">
              <code className="mcp-server-path">{server.originPath}</code>
              <button
                type="button"
                className="ghost-btn mcp-copy-btn"
                onClick={onCopy}
                aria-label="Copy path to clipboard"
              >
                {copied ? '✓ copied' : '⧉ copy'}
              </button>
            </dd>
          </div>
        )}
        {server.config?.command && (
          <div className="mcp-server-fact">
            <dt>Command</dt>
            <dd>
              <code>{server.config.command}</code>
              {server.config.args && server.config.args.length > 0 && (
                <code className="mcp-server-args"> {server.config.args.join(' ')}</code>
              )}
            </dd>
          </div>
        )}
        {server.binarySha && (
          <div className="mcp-server-fact">
            <dt>Binary sha256</dt>
            <dd>
              <code className="mcp-server-sha">{server.binarySha}</code>
            </dd>
          </div>
        )}
        {server.config?.envKeys && server.config.envKeys.length > 0 && (
          <div className="mcp-server-fact">
            <dt>Env keys passed</dt>
            <dd>
              {/* BE-B12 [security] reminder: NAMES only, never values. */}
              <ul className="mcp-server-envkey-list">
                {server.config.envKeys.map((k) => (
                  <li key={k}>
                    <code>{k}</code>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {server.tools.length > 0 && (
          <div className="mcp-server-fact">
            <dt>Tools exposed</dt>
            <dd>
              <ul className="mcp-server-tool-list">
                {server.tools.map((t) => (
                  <li key={t}>
                    <code>{t}</code>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
    </li>
  );
}
