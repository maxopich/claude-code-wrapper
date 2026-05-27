// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { ChatHeaderChip } from './ChatHeaderChip';
import { AuthorityProvider } from './authority/AuthorityContext';

// Cluster B Phase 6e — ChatHeaderChip wiring smoke.
//
// Tests:
//   - legacy shape (no projectId) renders only the chip span (no group / link)
//   - new shape (with projectId) renders chip + [Authority…] link
//   - clicking [Authority…] opens the preflight modal

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

describe('ChatHeaderChip — Phase 6e wiring', () => {
  test('legacy shape (no projectId) renders only the chip', () => {
    act(() => {
      root.render(<ChatHeaderChip trusted={false} mode="default" />);
    });
    expect(container.querySelector('.trust-chip')).not.toBeNull();
    expect(container.querySelector('.trust-chip-group')).toBeNull();
    expect(container.querySelector('.trust-chip-authority-link')).toBeNull();
  });

  test('with projectId renders chip + [Authority…] link', () => {
    act(() => {
      root.render(
        <AuthorityProvider send={() => {}}>
          <ChatHeaderChip trusted={false} mode="default" projectId={42} />
        </AuthorityProvider>,
      );
    });
    expect(container.querySelector('.trust-chip-group')).not.toBeNull();
    const link = container.querySelector('.trust-chip-authority-link') as HTMLButtonElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toContain('Authority');
  });

  test('clicking [Authority…] opens the preflight modal', () => {
    act(() => {
      root.render(
        <AuthorityProvider send={() => {}}>
          <ChatHeaderChip trusted={false} mode="default" projectId={42} />
        </AuthorityProvider>,
      );
    });
    expect(document.querySelector('.authority-preflight-modal')).toBeNull();
    const link = container.querySelector('.trust-chip-authority-link') as HTMLButtonElement;
    act(() => {
      link.click();
    });
    expect(document.querySelector('.authority-preflight-modal')).not.toBeNull();
    // Title is the single-project variant since we passed one id.
    const title = document.querySelector('.authority-preflight-modal .gate-modal-title');
    expect(title?.textContent).toBe('Authority preview');
  });
});
