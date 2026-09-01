import { describe, expect, test } from 'vitest';
import stylesCss from './styles.css?raw';

/**
 * Cebab-git: the toast dock (`.notif-stack`) must not overlay the transcript
 * with an unbounded column of non-dismissing cards.
 *
 * Safety-class notifications default `sticky: true` (server dispatcher) and are
 * in `NON_EVICTABLE` — deliberately, a security notice may not auto-vanish. But
 * the dock is `position: fixed` over the center pane, so a project with several
 * newly-declared hooks piled a full-height column of pinned cards up the right
 * edge, permanently over the transcript where the streaming reply lands.
 *
 * The fix keeps the info and its stickiness and instead bounds the dock: a
 * `max-height` in viewport units plus `overflow-y: auto`, so however many
 * sticky cards accumulate they scroll WITHIN the dock rather than climbing the
 * column and covering the top of the transcript.
 *
 * Asserted against the raw stylesheet (jsdom runs no layout, so a rendered
 * scroll/geometry read is always 0 — the `styles.css?raw` scan is the only
 * honest surface here, same as `railFocus.test.ts`).
 */

/** Body of the base `.notif-stack { … }` rule (the one that sets the fixed
 * anchor), CRLF-normalized. Selected by `position: fixed` so the media-query
 * duplicate `.notif-stack { … }` block can't stand in for it. */
function baseNotifStackBody(): string {
  const css = stylesCss.replace(/\r\n/g, '\n');
  // `\s*\{` after the selector excludes `.notif-stack > .notif {` and
  // `.notif-stack[data-empty='true'] {` — only the bare selector matches.
  const re = /\.notif-stack\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    if (/position:\s*fixed/.test(m[1])) return m[1];
  }
  throw new Error('base .notif-stack rule (position: fixed) not found');
}

describe('[a11y] the toast dock is bounded so sticky safety toasts cannot fill the transcript column (Cebab-git)', () => {
  const body = baseNotifStackBody();

  test('the scan found the real fixed-position dock rule', () => {
    // Anti-vacuity: prove we located the anchoring rule, not an empty match.
    expect(body).toMatch(/position:\s*fixed/);
    expect(body).toMatch(/pointer-events:\s*none/);
  });

  test('the dock has a viewport-relative max-height', () => {
    const maxHeight = /max-height:\s*([^;]+);/.exec(body);
    expect(maxHeight, '.notif-stack sets max-height').not.toBeNull();
    // A pixel or percentage cap would track content/parent, not the viewport;
    // the harm is measured against the viewport ("fills the right column"), so
    // the bound must be in viewport units (dvh/vh).
    expect(maxHeight![1]).toMatch(/\d(dvh|vh)\b/);
  });

  test('overflow beyond the cap scrolls inside the dock', () => {
    // Without this, a max-height would simply clip the newest sticky cards out
    // of sight; scrolling is what keeps every pinned notice reachable.
    expect(body).toMatch(/overflow-y:\s*auto/);
  });
});
