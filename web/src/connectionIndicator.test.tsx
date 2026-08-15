// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import stylesCss from './styles.css?raw';
import { ConnectionStatus } from './components/ConnectionStatus';

/**
 * Connection state is legible without seeing colour (register U11).
 *
 * It used to be a 6×6 `<span>` with a `title` and nothing else: green or red,
 * no text, no role. Three separate problems in one element — red/green is the
 * classic colour-blind failure pair, a `title` on an empty span is unreliable
 * for assistive tech, and six pixels is not glance-legible for anyone.
 *
 * The contract here is WCAG 1.4.1: colour is not the only visual means of
 * conveying the state. Two other channels have to carry it, and both are
 * asserted — text in the DOM, shape in the stylesheet.
 *
 * The last case pins a deliberate NON-fix. The register asks for a status
 * role; this does not have one, because both transitions are already
 * announced (disconnect by `ConnectionLostOverlay`, reconnect by the
 * "Reconnected" toast) and a third announcer for the same two events is the
 * double-announce defect being fixed elsewhere in the same change. Pinned as a
 * test so the decision is visible to whoever reads the finding next and
 * wonders why it was not done.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(connected: boolean) {
  act(() => root.render(<ConnectionStatus connected={connected} />));
}

/** Declaration block of a rule, with line endings normalised — the repo has no
 *  `.gitattributes`, so a Windows runner reads this file as CRLF. */
function ruleBody(selector: string): string {
  const css = stylesCss.replace(/\r\n/g, '\n');
  const at = css.indexOf(`\n${selector} {`);
  if (at === -1) throw new Error(`rule not found: ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}

describe('[a11y] the connection indicator names the state in text (U11)', () => {
  test.each([
    [true, 'Connected'],
    [false, 'Offline'],
  ])('connected=%s renders "%s"', (connected, word) => {
    render(connected);
    expect(container.textContent).toContain(word);
  });

  test('the disconnected label is visible, not screen-reader-only', () => {
    // The point of the visible half: "Offline" is the state worth noticing at
    // a glance, so it must not be hidden the way the connected label is.
    render(false);
    const wrapper = container.querySelector('.conn-status');
    expect(wrapper?.getAttribute('data-connected')).toBe('false');
    const visible = ruleBody(".conn-status[data-connected='false'] .conn-status-label");
    expect(visible).not.toContain('clip:');
    expect(visible).not.toContain('width: 1px');
  });

  test('the connected label is sr-only, so the header stays quiet', () => {
    render(true);
    expect(container.querySelector('.conn-status')?.getAttribute('data-connected')).toBe('true');
    const hidden = ruleBody(".conn-status[data-connected='true'] .conn-status-label");
    expect(hidden).toContain('clip: rect(0, 0, 0, 0)');
  });

  test('the disc itself is decorative, so it is not read out twice', () => {
    render(false);
    expect(container.querySelector('.dot')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('[a11y] the state is carried by shape, not only colour (WCAG 1.4.1)', () => {
  test('connected is filled and disconnected is a ring', () => {
    const on = ruleBody('.dot.on');
    const off = ruleBody('.dot.off');
    // Filled vs hollow — the difference survives a monochrome display and a
    // red/green colour-blind operator, which a swap of two hues does not.
    expect(on).toContain('background: var(--ok)');
    expect(off).toContain('background: transparent');
    expect(off).toContain('border: 2px solid var(--err)');
  });

  test('the label is normal ink, not the error colour', () => {
    // Measured: `--err` on `--panel` is 3.71:1 in the daylight gamma, under AA
    // for text this size. And answering a colour-only finding with coloured
    // text would keep leaning on the channel that failed. The ring carries the
    // colour; the word stays legible without it.
    expect(ruleBody(".conn-status[data-connected='false'] .conn-status-label")).toContain(
      'color: var(--fg-1)',
    );
  });
});

describe('[a11y] the indicator is not a live region — deliberately', () => {
  test.each([[true], [false]])('connected=%s announces nothing', (connected) => {
    render(connected);
    for (const el of Array.from(container.querySelectorAll('*'))) {
      const live = el.getAttribute('aria-live');
      const role = el.getAttribute('role');
      expect({ live, role }).toEqual({ live: null, role: null });
    }
  });

  test('the scan would notice if one were added', () => {
    // Anti-vacuity for the case above: prove the walk actually inspects
    // elements rather than iterating an empty list.
    render(false);
    expect(container.querySelectorAll('*').length).toBeGreaterThanOrEqual(3);
  });
});
