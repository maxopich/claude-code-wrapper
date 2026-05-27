import { useId, type ReactNode } from 'react';

// Cluster B Phase 6b (UI-B2 / spec §6.7): generic <details>-wrapped section
// header used by every list inside the AuthorityPanel — Tools, MCP servers,
// Hooks, Slash commands, Skills, Sub-agents, etc.
//
// Why native <details> rather than a custom open-state hook:
//   - Free `aria-expanded` semantics per spec §6.7
//   - Free keyboard support (Enter / Space on <summary> toggles)
//   - prefers-reduced-motion gates expansion animation in CSS — no JS
//   - Works without JS hydration on the initial paint (zero-config SSR-safe
//     for any future render-to-html case)
//
// The wrapper adds:
//   - Consistent header glyph (▾ closed, ▴ open via CSS `[open]` selector)
//   - Title + optional sublabel + count badge
//   - "changed" sr-only mirror (UI-B36) — when `changedHint` is set, an
//     sr-only `role="status" aria-live="polite"` element announces the
//     change so screen-reader operators learn an authority diff exists
//     without scanning the visual tree.
//   - Optional left-stripe accent (`accent` | `added` | `removed` | `none`)
//     reusing existing tokens per UI-B34. Defaults to `none`.

export type AuthoritySectionProps = {
  /** Title shown in the summary line. */
  title: string;
  /**
   * Numeric count rendered as a chip after the title. Pass `undefined` to
   * omit (e.g. for cards that aren't enumerable like ModelIdentity).
   */
  count?: number;
  /** Optional subtitle/posture text rendered under the title in muted ink. */
  sublabel?: string;
  /** Default open state. The user can still toggle once mounted. */
  defaultOpen?: boolean;
  /** Sr-only "this section changed since last paint" mirror — UI-B36. */
  changedHint?: string;
  /** Left-stripe accent for diff sections (UI-B30 / B47). */
  stripe?: 'none' | 'accent' | 'added' | 'removed';
  /**
   * Optional trailing slot for action buttons inside the summary row (e.g.
   * "Refresh" on the panel header). Pure ReactNode — caller owns layout.
   */
  trailing?: ReactNode;
  /** Body rendered inside the <details> when open. */
  children: ReactNode;
};

export function AuthoritySection(props: AuthoritySectionProps) {
  const {
    title,
    count,
    sublabel,
    defaultOpen = false,
    changedHint,
    stripe = 'none',
    trailing,
    children,
  } = props;

  // Stable id so the changedHint live-region announces against a known anchor
  // rather than a fresh node every render — screen readers re-announce on
  // node identity change.
  const liveRegionId = useId();

  const stripeClass =
    stripe === 'none' ? '' : `authority-section-stripe authority-section-stripe-${stripe}`;

  return (
    <details
      className={`authority-section ${stripeClass}`}
      open={defaultOpen}
      // Force consistent rendering even when CSS `details summary` overrides
      // miss. Defensive — older browsers without summary-list rendering use
      // the marker pseudo-element instead.
    >
      <summary className="authority-section-summary">
        <span className="authority-section-glyph" aria-hidden="true">
          ▸
        </span>
        <span className="authority-section-title">{title}</span>
        {typeof count === 'number' && (
          <span className="authority-section-count" aria-label={`${count} items`}>
            {count}
          </span>
        )}
        {sublabel && <span className="authority-section-sublabel">{sublabel}</span>}
        {/* Trailing slot — buttons sit on the right of the summary. */}
        {trailing && (
          <span
            className="authority-section-trailing"
            // Stop the click from toggling the <details>; trailing buttons
            // own their own click semantics (Refresh, View diff, etc.).
            onClick={(e) => e.stopPropagation()}
          >
            {trailing}
          </span>
        )}
      </summary>
      <div className="authority-section-body">{children}</div>
      {changedHint && (
        <span
          id={liveRegionId}
          role="status"
          aria-live="polite"
          className="authority-section-sr-mirror"
        >
          {changedHint}
        </span>
      )}
    </details>
  );
}
