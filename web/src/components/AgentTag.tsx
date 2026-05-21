/**
 * One participant's identity chip: hue swatch (peers only) + stable glyph +
 * fixed-width slug label. Identity survives loss of any single channel
 * (color / glyph / text). Chrome participants (orchestrator + sentinels)
 * render neutral — structural, not a colored peer.
 */
import type { CSSProperties } from 'react';
import { agentIdentity } from '../agentIdentity';

export function AgentTag(props: { slug: string }) {
  const id = agentIdentity(props.slug);
  return (
    <span
      className={`agent-tag${id.neutral ? ' is-chrome' : ''}`}
      style={id.hueVar ? ({ '--agent-hue': id.hueVar } as CSSProperties) : undefined}
    >
      {!id.neutral && <span className="agent-swatch" aria-hidden="true" />}
      <span className="agent-glyph" aria-hidden="true">
        {id.glyph}
      </span>
      <span className="agent-label">{id.label}</span>
    </span>
  );
}
