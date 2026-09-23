// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MessageView } from '../store';
import { MessageBlock } from './MessageBlock';

// Cebab-6nmo — a `cancelled` message (operator Stop, or a declined
// trust/env/MCP prompt) renders as a QUIET, NEUTRAL row: `.msg.cancelled`,
// deliberately NOT the red `.msg.error` one, because nothing failed. The
// process_crashed control below is what keeps that a real distinction rather
// than a rename of the error row.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render(m: MessageView) {
  act(() => {
    root.render(<MessageBlock message={m} />);
  });
}

describe('MessageBlock cancelled row — Cebab-6nmo', () => {
  test('a cancelled message renders the neutral row, not the error class', () => {
    render({ kind: 'cancelled', id: 'm1', message: 'Stopped by you' });

    expect(container.querySelector('.msg.cancelled')).not.toBeNull();
    // The whole point: it is NOT the red error row.
    expect(container.querySelector('.msg.error')).toBeNull();
    // And it shows the copy.
    expect(container.querySelector('.msg.cancelled .role')?.textContent).toBe('Stopped by you');
  });

  test('CONTROL: an error message still renders the red error row', () => {
    render({ kind: 'error', id: 'm2', errorKind: 'process_crashed', message: 'boom' });

    expect(container.querySelector('.msg.error')).not.toBeNull();
    expect(container.querySelector('.msg.cancelled')).toBeNull();
  });
});
