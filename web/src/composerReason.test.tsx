// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { composerDisabledReason, workspaceLabel } from './App';
import { InputBox } from './components/InputBox';
import { HELD_MESSAGES_CAP } from './store';

/**
 * A disabled composer must say why (register U33), and the sidebar's workspace
 * label must survive Windows (register U41).
 *
 * Both live here because both are pure-ish App-level string decisions that
 * would otherwise need all of `App.tsx` driven through jsdom to observe.
 *
 * U33's shape is the interesting part. The reason and the disabled state are
 * one value: `InputBox` takes `{ reason }` rather than a boolean, so "disabled
 * with no explanation" is not expressible, and the tests below check the pair
 * in BOTH directions — a reason present implies a dead composer that explains
 * itself, and no reason implies a live one with no stray explanation hanging
 * around. A one-directional test would pass on a component that rendered the
 * reason line permanently.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

const REASON_SEL = '.input-box-disabled-reason';

function textarea(): HTMLTextAreaElement {
  return container.querySelector('textarea') as HTMLTextAreaElement;
}

describe('composerDisabledReason', () => {
  const usable = {
    hasActiveProject: true,
    workspaceReady: true,
    rateLimited: false,
    heldCount: 0,
  };

  test('nothing wrong → no reason, so the composer stays live', () => {
    expect(composerDisabledReason(usable)).toBeNull();
  });

  test('no project selected → names the sidebar, which is where the fix is', () => {
    const reason = composerDisabledReason({ ...usable, hasActiveProject: false });
    expect(reason).not.toBeNull();
    expect(reason).toContain('sidebar');
  });

  test('workspace not set → points at Settings', () => {
    // Unreachable through today's layout (that state swaps the whole chat
    // column for the "Choose a folder" screen), and kept deliberately: this
    // PR changes what the composer SAYS, never which states disable it.
    const reason = composerDisabledReason({ ...usable, workspaceReady: false });
    expect(reason).toContain('Settings');
  });

  test('rate limited with a full queue → names the cap and the way out', () => {
    const reason = composerDisabledReason({
      ...usable,
      rateLimited: true,
      heldCount: HELD_MESSAGES_CAP,
    });
    expect(reason).not.toBeNull();
    // The cap itself, so the operator can see the queue is full rather than
    // inferring it, and Drop — the banner's per-row escape hatch, which was
    // the one thing nothing on screen connected to the dead composer.
    expect(reason).toContain(String(HELD_MESSAGES_CAP));
    expect(reason).toContain('Drop');
  });

  test('rate limited BELOW the cap → still usable, messages just queue', () => {
    expect(
      composerDisabledReason({ ...usable, rateLimited: true, heldCount: HELD_MESSAGES_CAP - 1 }),
    ).toBeNull();
  });

  test('a full queue without a rate limit does not disable anything', () => {
    expect(composerDisabledReason({ ...usable, heldCount: HELD_MESSAGES_CAP + 5 })).toBeNull();
  });
});

describe('InputBox — a disable always carries its reason', () => {
  test('reason present → textarea disabled, line rendered, and the two are linked', () => {
    act(() => {
      root.render(<InputBox onSend={() => {}} disabled={{ reason: 'Pick a project first.' }} />);
    });
    const line = container.querySelector(REASON_SEL);
    expect(line).not.toBeNull();
    expect(line?.textContent).toBe('Pick a project first.');
    expect(textarea().disabled).toBe(true);
    // aria-describedby actually resolves — a dangling id is the silent way
    // this association breaks.
    const describedBy = textarea().getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toBe(line);
  });

  test('no reason → composer live and no orphaned explanation on screen', () => {
    act(() => {
      root.render(<InputBox onSend={() => {}} />);
    });
    expect(container.querySelector(REASON_SEL)).toBeNull();
    expect(textarea().disabled).toBe(false);
    expect(textarea().getAttribute('aria-describedby')).toBeNull();
  });

  test('running is not disabled — the textarea stays usable for the next prompt', () => {
    // UI-6. Guards against "explain the disable" being implemented by
    // disabling more than before.
    act(() => {
      root.render(<InputBox onSend={() => {}} isRunning onStop={() => {}} />);
    });
    expect(container.querySelector(REASON_SEL)).toBeNull();
    expect(textarea().disabled).toBe(false);
  });

  test('the reason is not a live region — it must not announce a third time', () => {
    // Every transition into this state is either operator-initiated or
    // already announced by the rate-limit banner above. #288 fixed a toast
    // that announced twice; adding a third announcer here would re-open it.
    act(() => {
      root.render(<InputBox onSend={() => {}} disabled={{ reason: 'Pick a project first.' }} />);
    });
    const line = container.querySelector(REASON_SEL)!;
    expect(line.getAttribute('aria-live')).toBeNull();
    expect(line.getAttribute('role')).toBeNull();
  });
});

describe('workspaceLabel', () => {
  test('POSIX path → trailing folder name', () => {
    expect(workspaceLabel('/Users/foo/agents')).toBe('agents');
  });

  test('Windows path → trailing folder name, not the whole path', () => {
    // U41: this returned `C:\Users\foo\agents` entire, overflowing the rail on
    // a platform CI runs on every push.
    expect(workspaceLabel('C:\\Users\\foo\\agents')).toBe('agents');
  });

  test('trailing separators are trimmed in both dialects', () => {
    expect(workspaceLabel('/Users/foo/agents/')).toBe('agents');
    expect(workspaceLabel('C:\\Users\\foo\\agents\\')).toBe('agents');
  });

  test('a bare root falls back to the path rather than an empty button', () => {
    // Pre-existing, surfaced while writing the Windows cases: `/` trims to the
    // empty string, and the fallback returned the trimmed value — so the
    // sidebar button rendered blank. Falls back to the original now.
    expect(workspaceLabel('/')).toBe('/');
    expect(workspaceLabel('C:\\')).toBe('C:');
  });

  test('null → the call-to-action', () => {
    expect(workspaceLabel(null)).toBe('Set workspace');
  });
});
