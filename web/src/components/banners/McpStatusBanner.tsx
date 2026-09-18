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
// WHY NO ACTIONS *HERE*, and the reason has changed (`Cebab-ormv`). The
// original said "there is nothing Cebab can do about a server that failed to
// come up: the SDK connects them at spawn, and a 'Retry' button that quietly
// does nothing is the same defect as the invented remedy, just wearing our
// name." The premise was measured and is now false: `Query` exposes
// `reconnectMcpServer`, `toggleMcpServer` and an OAuth trio, and Cebab drives
// them from the authority panel's live MCP section.
//
// The conclusion survives its premise, for a different reason. This banner
// reports a FROZEN reading — `session_started.mcpServers`, captured once at
// startup and never re-read — so an action button here would act on a fact
// that may already be stale, and would report its result into a banner with
// no way to refresh. Worse, the repair is per-server and this is a per-session
// summary. The live section owns the actions because it owns a current read;
// this stays what it always was, the thing that ends the guessing.
//
// The honest gap that remains: nothing yet routes an operator FROM this banner
// TO that section. Worth closing, and deliberately not smuggled into the
// change that made the section exist.
//
// IT WAS NON-DISMISSIBLE, AND THAT WAS WRONG (`Cebab-9fta`). The original
// reasoning is kept because the premise was right and only the conclusion was
// not: the banner "reflects a state that holds for as long as the session
// does, so hiding it would be hiding something still true".
//
// The same premise argues the other way. Precisely BECAUSE the reading cannot
// change mid-session, it says nothing new the second time it is read — and it
// is a large block above every message for the rest of the session. The
// reported case was two claude.ai connectors reporting `needs-auth` — which
// at the time the operator could not resolve from inside Cebab at all, and
// since `Cebab-ormv` can, from the authority panel's live MCP section. The
// dismissal argument does not depend on that: the banner named the state once,
// usefully, and then charged rent for the rest of the session.
//
// So the factory takes an optional `dismiss` and the shell's existing
// affordance renders it. What dismissal does NOT do is discard the facts: the
// servers stay in the session slice, the authority panel still reports their
// health, and a session whose servers recover and break again shows the banner
// again (`store.ts`, `mcp_status_dismissed`). Hiding is the operator's call;
// forgetting is not.
//
// `pending` IS NOT A VERDICT, AND SAYING IT WAS IS THIS BANNER'S ONE FALSE
// CLAIM (`Cebab-z9bh`). `notConnected` is right to be "anything but
// connected" — enumerating bad statuses would blind it to the first new
// failure mode the SDK adds, which is the whole reason it reads that way. But
// the banner INTERPRETS that set, and one member of it means something else.
//
// Measured on SDK 0.3.251: the same claude.ai server read `pending` at init in
// one probe and `connected` in the next, and two prod sessions minutes apart
// disagree about the same server on disk. `pending` at `system/init` is the
// handshake still in flight at the earliest and least settled moment Cebab
// could have looked — not a server that failed to come up.
//
// So the split lives HERE, at the interpreting site, and `notConnected` is
// untouched: the slice still carries every non-connected server, nothing is
// forgotten, and the status string is still printed verbatim. What changes is
// the SENTENCE. A server that was mid-handshake is reported as mid-handshake,
// at `info` rather than `warn`, because a warning that usually resolves itself
// is how an operator learns to ignore warnings. `Cebab-cqd` fixed the
// model-facing half of this (the system-prompt note defers to the tool list);
// this is the operator-facing half its close reason left open.
//
// THE STATUS IS PRINTED, NEVER INTERPRETED. Whatever string the SDK sent is
// what the row shows. That is what keeps the banner honest for a status this
// code has never heard of, and it is why nothing here maps an unknown value
// onto "failed".

import React from 'react';
import type { McpServerStatus } from '@cebab/shared';
import type { BannerStackItem } from './BannerStack.js';

export type BuildMcpStatusBannerItemArgs = {
  sessionId: string;
  /** The servers that did not report `connected`, from the session's
   *  `mcpStatus` slice. Never empty — the caller mounts on the slice being
   *  present, and a present-but-empty slice cannot occur (the reducer deletes
   *  it instead). */
  servers: readonly McpServerStatus[];
  arrivedAt?: number;
  /**
   * `Cebab-9fta`: hide this banner for the rest of the session.
   *
   * Optional, and absence means non-dismissible — so a caller that has no
   * business offering the affordance (a preview, a test) gets the old
   * behaviour by writing nothing, and only the live session wires it.
   */
  dismiss?: () => void;
};

export function mcpStatusBannerTitle(count: number): string {
  return count === 1
    ? 'One MCP server did not come up for this session'
    : `${count} MCP servers did not come up for this session`;
}

/**
 * The one status that means "not yet known" rather than "did not come up".
 *
 * A literal, not a list, and deliberately so: every OTHER unrecognised status
 * must keep falling through to the did-not-come-up side, because that side
 * prints the string verbatim and claims no cause. Widening this to a set is
 * how the blind spot `notConnected` closes would be reopened one status at a
 * time.
 */
const STILL_CONNECTING_STATUS = 'pending';

export type McpStatusPartition = {
  /** Reported `pending` at init — the handshake had not finished yet. */
  stillConnecting: readonly McpServerStatus[];
  /** Any other non-connected status. Printed verbatim, never translated. */
  didNotComeUp: readonly McpServerStatus[];
};

export function partitionMcpStatus(servers: readonly McpServerStatus[]): McpStatusPartition {
  const stillConnecting: McpServerStatus[] = [];
  const didNotComeUp: McpServerStatus[] = [];
  for (const server of servers) {
    (server.status === STILL_CONNECTING_STATUS ? stillConnecting : didNotComeUp).push(server);
  }
  return { stillConnecting, didNotComeUp };
}

export function mcpStillConnectingTitle(count: number): string {
  return count === 1
    ? 'One MCP server was still connecting when this session started'
    : `${count} MCP servers were still connecting when this session started`;
}

export function buildMcpStatusBannerItem(args: BuildMcpStatusBannerItemArgs): BannerStackItem {
  const { sessionId, servers, arrivedAt, dismiss } = args;
  const { stillConnecting, didNotComeUp } = partitionMcpStatus(servers);
  // Everything here keys off this. When nothing reported a definite
  // non-connected status, the banner is a NOTE about an unfinished handshake,
  // not a warning about a broken server — different sentence, different tier.
  const onlyStillConnecting = didNotComeUp.length === 0;

  const body = (
    <>
      {didNotComeUp.length > 0 && (
        <p>
          Loaded when this session started, then never reported as connected. Tools from a server in
          that state are not on this session&apos;s tool list, and the agent has no way to know they
          were meant to be — so if it says a capability does not exist, this is why.
        </p>
      )}
      {stillConnecting.length > 0 && (
        <p>
          {stillConnecting.length === 1 ? 'One server was' : 'Some servers were'} still completing
          the handshake at that moment, which is not the same as failing to come up — a server in
          that state usually finishes and works normally. Cebab read the status once, at the
          earliest point it could, and has not looked again.
        </p>
      )}
      <p>
        That was the reading at startup, not a live one. <strong>Live MCP servers</strong> in the
        authority panel re-reads it and can reconnect a server, or start authentication for one that
        needs it. A server that this project declares but that the session was never allowed to read
        is a different situation with a different fix, and it does not appear here at all — the
        sidebar reports that one.
      </p>
    </>
  );

  // Grouped, not merged. The two lists mean different things, and a single
  // flat list would put a server that is probably fine beside one that is
  // definitely not, under whichever heading happened to win.
  const detail = (
    <>
      {didNotComeUp.length > 0 && (
        <ul>
          {didNotComeUp.map((s) => (
            <li key={s.name}>
              <code>{s.name}</code> — reported <code>{s.status}</code>
            </li>
          ))}
        </ul>
      )}
      {stillConnecting.length > 0 && (
        <>
          {didNotComeUp.length > 0 && <p>Still connecting at startup:</p>}
          <ul>
            {stillConnecting.map((s) => (
              <li key={s.name}>
                <code>{s.name}</code> — reported <code>{s.status}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );

  return {
    id: `mcp-status-${sessionId}`,
    // `info` renders as a region with no aria-live, so an unfinished handshake
    // does not interrupt a screen reader mid-sentence for something that
    // usually resolves itself.
    tier: onlyStillConnecting ? 'info' : 'warn',
    title: onlyStillConnecting
      ? mcpStillConnectingTitle(stillConnecting.length)
      : mcpStatusBannerTitle(didNotComeUp.length),
    glyph: onlyStillConnecting ? 'ⓘ' : '⚠',
    body,
    detail,
    detailLabel: servers.length === 1 ? 'Which server' : 'Which servers',
    arrivedAt,
    // Spread rather than assigned: `SessionBanner` decides "dismissible" by the
    // prop being PRESENT, so writing `dismiss: undefined` would look identical
    // here and behave identically there — until someone changes that check to
    // `in`, at which point every caller silently gains a button that does
    // nothing.
    ...(dismiss ? { dismiss } : {}),
  };
}
