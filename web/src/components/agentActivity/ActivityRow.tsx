/**
 * One row inside a lane's activity feed. Represents the **bus hop** the
 * lane's agent participated in (either as sender or destination) — bus
 * hops are the only per-agent data currently on the wire. Tool calls
 * surface in two other places: classified mutations land in the Artifacts
 * tab (or, for scratch writes, the "Working files" subsection on this
 * row's expanded panel — Phase E).
 *
 * Collapsed: chevron + kind badge + the other peer's tag + first line of
 * the message + timestamp. Click / Enter / Space inline-expands.
 *
 * Expanded: full message body (Markdown), absolute timestamp, source and
 * destination tags, copy button. Focus stays on the row after collapse so
 * Tab/Shift+Tab traversal isn't interrupted. The expand transition is
 * disabled under `prefers-reduced-motion`.
 *
 * AC6 in the spec calls for "tool name, args, result, duration" in the
 * expanded panel — that's the v2 design for when individual tool calls
 * become wire-surface. For v1 we render what's actually available: the bus
 * message itself.
 */
import { useCallback, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';
import type { MultiAgentEventKind } from '@cebab/shared/protocol';
import { agentIdentity } from '../../agentIdentity';
import { Markdown } from '../Markdown';
import type { LaneRow } from './laneDerivation';

/** No-color-only: every hop kind carries an icon AND its word. Mirrors
 *  `KIND_MARK` in MultiAgentTab.tsx (kept local so the agentActivity
 *  folder is self-contained). */
const KIND_MARK: Record<MultiAgentEventKind, string> = {
  intro: '↪',
  prompt: '›',
  reply: '↩',
  final: '◼',
  error: '✕',
};

function formatTs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatAbsTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString();
}

/** First non-empty line of the message body, truncated for the row summary. */
function firstLine(text: string, max = 140): string {
  const trimmed = text.trim();
  if (!trimmed) return '(empty)';
  const nl = trimmed.indexOf('\n');
  const line = nl === -1 ? trimmed : trimmed.slice(0, nl);
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

export function ActivityRow(props: { row: LaneRow; laneAgentName: string }) {
  const { row, laneAgentName } = props;
  const { event, direction } = row;
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const rowRef = useRef<HTMLLIElement | null>(null);

  // The "other" peer in this hop, from the lane's perspective.
  const peerSlug = direction === 'incoming' ? event.source : event.destination;
  const peerId = agentIdentity(peerSlug);
  const laneId = agentIdentity(laneAgentName);

  // Toggle handles click + Enter + Space. Space must be consumed on keydown
  // to prevent the default page-scroll behavior.
  const toggle = useCallback(() => {
    setExpanded((e) => {
      const next = !e;
      // On collapse, restore focus to the row so Tab traversal isn't broken.
      if (!next && rowRef.current) {
        rowRef.current.focus();
      }
      return next;
    });
  }, []);

  const onClick = useCallback(
    (e: MouseEvent) => {
      // Ignore clicks on interactive children (copy button, links inside the body).
      const target = e.target as HTMLElement;
      if (target.closest('button, a, input, textarea, select')) return;
      toggle();
    },
    [toggle],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    },
    [toggle],
  );

  async function copyText() {
    try {
      await navigator.clipboard.writeText(event.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Non-secure-context / denied clipboard permission: silently leave
      // the affordance idle.
    }
  }

  return (
    <li
      ref={rowRef}
      className={`activity-row direction-${direction} event-kind-${event.kind}${
        expanded ? ' is-expanded' : ''
      }`}
      tabIndex={0}
      role="button"
      aria-expanded={expanded}
      aria-label={`${direction === 'incoming' ? 'incoming from' : 'outgoing to'} ${peerId.label}, ${event.kind}, ${formatTs(event.ts)}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      // Lane-agent hue stripe on the LEFT edge of the row (visual continuity
      // with the lane header monogram).
      data-agent-hue={laneId.hueVar ? '' : undefined}
      style={laneId.hueVar ? ({ '--agent-hue': laneId.hueVar } as CSSProperties) : undefined}
    >
      <div className="activity-row-head">
        <span className="activity-chev" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span className={`activity-kind kind-${event.kind}`}>
          <span className="activity-kind-mark" aria-hidden="true">
            {KIND_MARK[event.kind]}
          </span>
          {event.kind}
        </span>
        <span className="activity-direction">
          {direction === 'incoming' ? (
            <>
              <span aria-hidden="true">←</span>
              <span className="activity-peer">{peerId.label}</span>
            </>
          ) : direction === 'terminal' ? (
            <>
              <span aria-hidden="true">→</span>
              <span className="activity-peer is-chrome">
                {event.destination === 'user' ? 'user' : 'end'}
              </span>
            </>
          ) : (
            <>
              <span aria-hidden="true">→</span>
              <span className="activity-peer">{peerId.label}</span>
            </>
          )}
        </span>
        <span className="activity-summary">{firstLine(event.text)}</span>
        <span className="activity-ts" title={formatAbsTs(event.ts)}>
          {formatTs(event.ts)}
        </span>
      </div>
      {expanded && (
        <div className="activity-row-detail" role="region" aria-label="Message body">
          <div className="activity-row-detail-meta">
            <span className="activity-detail-stamp" title={formatAbsTs(event.ts)}>
              {formatAbsTs(event.ts)}
            </span>
            <span className="activity-detail-route">
              <code>{event.source}</code> <span aria-hidden="true">→</span>{' '}
              <code>{event.destination}</code>
            </span>
            <button
              type="button"
              className="ghost-btn activity-copy"
              onClick={copyText}
              title={copied ? 'Copied' : 'Copy message text'}
            >
              {copied ? '✓ copied' : '⧉ copy'}
            </button>
          </div>
          <div className="activity-row-detail-body">
            <Markdown text={event.text} />
          </div>
        </div>
      )}
    </li>
  );
}
