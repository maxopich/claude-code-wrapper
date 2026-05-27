// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SlashCommandsList } from './SlashCommandsList';

// Cluster B Phase 8 — UI-B41: SlashCommandsList contract.
//
// Tests:
//   - empty: explicit copy
//   - non-empty: alphabetical sort
//   - leading `/` is normalised — names with and without one render
//     consistently as `/name` and sort by the normalised form
//   - monospace rendering via .auth-name-list-item-name

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
  vi.useRealTimers();
});

describe('SlashCommandsList', () => {
  test('empty state copy', () => {
    act(() => {
      root.render(<SlashCommandsList commands={[]} />);
    });
    expect(container.querySelector('.auth-name-list-empty')).not.toBeNull();
    expect(container.textContent).toContain('No slash commands resolved');
  });

  test('alphabetical sort of the normalised /name form', () => {
    act(() => {
      root.render(<SlashCommandsList commands={['/help', 'context', '/compact']} />);
    });
    const names = Array.from(
      container.querySelectorAll<HTMLElement>('.auth-name-list-item-name'),
    ).map((el) => el.textContent);
    // `/compact`, `/context`, `/help` — even though `context` came in
    // without the slash and `/compact` came in with one.
    expect(names).toEqual(['/compact', '/context', '/help']);
  });

  test('prepends `/` for entries shipped without it', () => {
    act(() => {
      root.render(<SlashCommandsList commands={['foo']} />);
    });
    const name = container.querySelector('.auth-name-list-item-name')?.textContent;
    expect(name).toBe('/foo');
  });

  test('keeps `/` when already present', () => {
    act(() => {
      root.render(<SlashCommandsList commands={['/bar']} />);
    });
    const name = container.querySelector('.auth-name-list-item-name')?.textContent;
    expect(name).toBe('/bar');
  });

  test('renders names inside the monospace .auth-name-list-item-name slot', () => {
    act(() => {
      root.render(<SlashCommandsList commands={['/a']} />);
    });
    const code = container.querySelector('.auth-name-list-item-name');
    // The component renders the name via a `<code>` element with the class.
    expect(code?.tagName).toBe('CODE');
  });
});
