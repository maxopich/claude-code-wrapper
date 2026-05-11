/**
 * Anthropic Claude brand mark — 8 spokes radiating from a center point, drawn
 * as 4 rounded-cap strokes overlaid at 0/45/90/135 degrees. Renders at the
 * given size (default 14px) and inherits its color from CSS `color` (via
 * `currentColor`), so per-row tinting is easy.
 *
 * Used in the sidebar next to project names that contain a `CLAUDE.md` —
 * a positive indicator that the folder is an actual agent project.
 */
export function ClaudeMark(props: { className?: string; title?: string; size?: number }) {
  const size = props.size ?? 14;
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={props.className}
      role={props.title ? 'img' : undefined}
      aria-hidden={props.title ? undefined : true}
      focusable="false"
    >
      {props.title ? <title>{props.title}</title> : null}
      <g stroke="currentColor" strokeWidth="14" strokeLinecap="round">
        <line x1="50" y1="22" x2="50" y2="78" />
        <line x1="22" y1="50" x2="78" y2="50" />
        <line x1="30" y1="30" x2="70" y2="70" />
        <line x1="30" y1="70" x2="70" y2="30" />
      </g>
    </svg>
  );
}
