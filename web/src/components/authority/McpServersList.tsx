import type { McpServerView } from '@cebab/shared/protocol';
import { useCopyFeedback } from '../../useCopyFeedback';

// Cluster B Phase 6c (UI-B13 / B15 / spec §4.2 F1): MCP servers section of
// the AuthorityPanel.
//
// One card per declared MCP server. Each card answers:
//   - WHO    — `name` + tools it exposes
//   - WHERE  — `scope` chip (user / project / local / mcp-json / claude-json /
//              cebab-injected) + `originPath` (which file declared it).
//              TWO of these describe servers that actually run: `mcp-json`
//              (project-root `.mcp.json`) and `claude-json` (`~/.claude.json`).
//              Measured against SDK 0.3.201, `mcpServers` in
//              `.claude/settings*.json` is not loaded at any scope — so a
//              `user`/`project`/`local` row describes a declaration the CLI
//              ignores, while those two describe live servers. See
//              `readClaudeJsonServers` in `server/src/repo/project_authority.ts`
//              for the full measured table.
//   - WHAT   — `command` + `args` from `config`
//   - TRUST  — `trust` chip from the mcp_trust JOIN (Phase 4):
//                trusted / pending_tofu / hash_changed / declaration_changed /
//                script_changed /
//                denied / unknown
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
  // Cebab-rxg: error tier alongside `hash_changed`. A server whose declaration
  // changed under an approved name is the more serious of the two — the
  // program itself was swapped, not merely rebuilt.
  declaration_changed: 'mcp-trust-err',
  // Cebab-1af: error tier for the same reason. A rewritten script under an
  // unchanged declaration is the swap `declaration_changed` catches, done in
  // the one place a `git diff` of the config shows nothing.
  script_changed: 'mcp-trust-err',
  denied: 'mcp-trust-err',
  unknown: 'mcp-trust-muted',
};

const TRUST_LABEL: Record<McpServerView['trust'], string> = {
  trusted: 'trusted',
  pending_tofu: 'pending TOFU',
  hash_changed: 'hash changed',
  declaration_changed: 'declaration changed',
  script_changed: 'script changed',
  denied: 'denied',
  unknown: 'unknown',
};

const SCOPE_CHIP_CLASS: Record<McpServerView['scope'], string> = {
  user: 'mcp-scope-user',
  project: 'mcp-scope-project',
  local: 'mcp-scope-local',
  // The project-root `.mcp.json` — the only project-scoped file the CLI
  // actually loads MCP servers from. Styled like `project` because that is
  // what an operator reads it as; the chip LABEL carries the distinction.
  'mcp-json': 'mcp-scope-project',
  // `~/.claude.json` — the CLI's own state file, and the OTHER location
  // measured to actually load servers (both its top-level `mcpServers` and its
  // per-project block). Styled like `user` because that is where an operator
  // reads a home-directory declaration as coming from; the chip LABEL carries
  // the distinction, same as `mcp-json` above.
  'claude-json': 'mcp-scope-user',
  'cebab-injected': 'mcp-scope-cebab',
  // Reported by the SDK but matching no settings layer Cebab read, and not a
  // Cebab injection. Shares the muted styling of an unresolved row — it is
  // deliberately NOT dressed as Cebab-managed, because that label carries an
  // automatic trust grant server-side.
  unknown: 'mcp-scope-unknown',
};

function statusDotClass(status: string): string {
  return STATUS_DOT_CLASS[status] ?? 'mcp-status-muted';
}

/* U42: a private `copyToClipboard` lived here — the ORIGINAL. `web/src/
 * clipboard.ts` says in its own header that it was "lifted from the local
 * helper in authority/McpServersList.tsx so … any future caller share one
 * implementation". The lift happened; the delete never did, so the file the
 * shared helper was extracted from went on using its own copy, and the
 * consolidation the comment described was never true. Deleted here, along
 * with the hand-rolled copied-state pair, in favour of `useCopyFeedback`. */

export function McpServersList(props: {
  servers: McpServerView[];
  projectScopeRead?: boolean;
  unloaded?: McpServerView[];
}) {
  const { servers, projectScopeRead = true } = props;
  const unloaded = props.unloaded ?? [];
  if (servers.length === 0) {
    // Cebab-66y: when the project's own files DO declare a server that this
    // (untrusted) scope set will not load, name it — the whole failure the
    // bead reports is the panel asserting a server does not exist when it
    // exists and merely will not load. This supersedes the older Cebab-ys9
    // "Not checked" copy below, which described the same servers as things
    // that "would not appear here": now they do.
    if (unloaded.length > 0) {
      return <UnloadedMcpServers unloaded={unloaded} />;
    }
    // Cebab-ys9: this used to read "No MCP servers declared in this project."
    // — a claim about the PROJECT from a scan that, on an untrusted project,
    // never opened the file that would declare them. A project-scoped
    // `.mcp.json` is exactly where an operator puts one, so the sentence was
    // most wrong in the case they were most likely to be reading it in.
    if (!projectScopeRead) {
      return (
        <div className="mcp-servers-empty">
          Not checked: this project&apos;s own files were not read, so a server declared in its
          .mcp.json would not appear here — and would not load for its sessions either. Turn Trust
          on in the sidebar to load them.
        </div>
      );
    }
    return (
      <div className="mcp-servers-empty">
        No MCP servers found in this project&apos;s declarations. (Cebab&apos;s in-process bus_send
        injects only inside multi-agent runs and won&apos;t appear here.)
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
    <div className="mcp-servers-block">
      <ul className="mcp-servers-list" aria-label="Declared MCP servers">
        {sorted.map((s) => (
          <McpServerCard key={`${s.scope}:${s.name}`} server={s} />
        ))}
      </ul>
      {unloaded.length > 0 && <UnloadedMcpServers unloaded={unloaded} />}
    </div>
  );
}

/**
 * Cebab-66y: MCP servers a project declares in a file its next run will NOT
 * load — the project-root `.mcp.json` (or `~/.claude.json`'s per-project block)
 * on an untrusted project. They are declared and inert; turning Trust on loads
 * them. Named explicitly so the panel never reports "none declared" for a
 * server that plainly is.
 */
function UnloadedMcpServers(props: { unloaded: McpServerView[] }) {
  const { unloaded } = props;
  const sorted = [...unloaded].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section className="mcp-servers-unloaded">
      <div className="mcp-servers-unloaded-note">
        {unloaded.length} {unloaded.length === 1 ? 'server is' : 'servers are'} declared in this
        project&apos;s own files but will <strong>not load</strong> while Trust is off. Turn Trust
        on in the sidebar to load {unloaded.length === 1 ? 'it' : 'them'}.
      </div>
      <ul
        className="mcp-servers-list mcp-servers-unloaded-list"
        aria-label="Declared but unloaded MCP servers"
      >
        {sorted.map((s) => (
          <McpServerCard key={`unloaded:${s.scope}:${s.name}`} server={s} />
        ))}
      </ul>
    </section>
  );
}

function McpServerCard(props: { server: McpServerView }) {
  const { server } = props;
  const { copied, copy } = useCopyFeedback();
  async function onCopy() {
    if (!server.originPath) return;
    await copy(server.originPath);
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
