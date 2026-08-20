// Cebab-ws0.2: the in-session signal for an MCP server that loaded but did
// not report itself connected.
//
// WHAT THIS EXISTS FOR. A server in that state contributes zero tools, and
// from inside the session that is indistinguishable from a server that was
// never declared: the model simply has no such tools, cannot say why, and in
// the reported transcript it invented a remedy — restart, credential scope —
// that could not have worked. The status the SDK reported at startup is the
// one fact that ends the guessing, and it has been arriving on every
// `session_started` all along with nothing reading it.
//
// WHY A WARN TIER. The session is not blocked; it is short some tools. Danger
// steals focus once per banner id and is reserved for states the operator has
// to resolve before proceeding — misusing it here would train them to ignore
// the tier that matters.
//
// WHY NO ACTIONS. There is nothing Cebab can do about a server that failed to
// come up: the SDK connects them at spawn, and a "Retry" button that quietly
// does nothing is the same defect as the invented remedy, just wearing our
// name. The banner's whole job is to replace a guess with a measurement.
//
// WHY NON-DISMISSIBLE. Same convention as the other recovery banners — it
// reflects a state that holds for as long as the session does, so hiding it
// would be hiding something still true.
//
// THE STATUS IS PRINTED, NEVER INTERPRETED. Whatever string the SDK sent is
// what the row shows. That is what keeps the banner honest for a status this
// code has never heard of, and it is why nothing here maps an unknown value
// onto "failed".

import React from 'react';
import type { McpServerStatus } from '../../mcpStatus.js';
import type { BannerStackItem } from './BannerStack.js';

export type BuildMcpStatusBannerItemArgs = {
  sessionId: string;
  /** The servers that did not report `connected`, from the session's
   *  `mcpStatus` slice. Never empty — the caller mounts on the slice being
   *  present, and a present-but-empty slice cannot occur (the reducer deletes
   *  it instead). */
  servers: readonly McpServerStatus[];
  arrivedAt?: number;
};

export function mcpStatusBannerTitle(count: number): string {
  return count === 1
    ? 'One MCP server did not come up for this session'
    : `${count} MCP servers did not come up for this session`;
}

export function buildMcpStatusBannerItem(args: BuildMcpStatusBannerItemArgs): BannerStackItem {
  const { sessionId, servers, arrivedAt } = args;

  const body = (
    <>
      <p>
        Loaded when this session started, then never reported as connected. Tools from a server in
        that state are not on this session&apos;s tool list, and the agent has no way to know they
        were meant to be — so if it says a capability does not exist, this is why.
      </p>
      <p>
        That was the reading at startup, not a live one, and Cebab cannot bring a server back up
        mid-session. Starting a fresh session measures it again. A server that this project declares
        but that the session was never allowed to read is a different situation with a different
        fix, and it does not appear here at all — the sidebar reports that one.
      </p>
    </>
  );

  const detail = (
    <ul>
      {servers.map((s) => (
        <li key={s.name}>
          <code>{s.name}</code> — reported <code>{s.status}</code>
        </li>
      ))}
    </ul>
  );

  return {
    id: `mcp-status-${sessionId}`,
    tier: 'warn',
    title: mcpStatusBannerTitle(servers.length),
    glyph: '⚠',
    body,
    detail,
    detailLabel: servers.length === 1 ? 'Which server' : 'Which servers',
    arrivedAt,
  };
}
