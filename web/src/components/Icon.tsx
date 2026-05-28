import type { ReactNode } from 'react';

/**
 * Tiny inline-SVG icon set — stroke paths lifted verbatim from the
 * cebab-redesign.html mockup. Decorative (aria-hidden); sized via the
 * global `.ic` / `.ic-lg` rules in styles.css and tinted by `currentColor`.
 */
export type IconName = 'chat' | 'agents' | 'chain' | 'send' | 'stop';

const PATHS: Record<IconName, ReactNode> = {
  chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  agents: (
    <>
      <circle cx="12" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M12 8v6M12 14l-6 4M12 14l6 4" />
    </>
  ),
  chain: (
    <>
      <path d="M9 17H7a4 4 0 0 1 0-8h2" />
      <path d="M15 7h2a4 4 0 0 1 0 8h-2" />
      <path d="M8 12h8" />
    </>
  ),
  send: (
    <>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4z" />
    </>
  ),
  // Cluster C Phase 1 (UI-9): 12×12 filled square at the 24-viewport
  // center, rendered via stroke+fill currentColor so the button's
  // --err token colors it identically to the existing icons.
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />,
};

export function Icon(props: { name: IconName; className?: string }) {
  return (
    <svg
      className={props.className ?? 'ic'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[props.name]}
    </svg>
  );
}
