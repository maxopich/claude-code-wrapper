// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ModeToggle } from './ModeToggle';
import { acceptEditsCopy, permissionModeOptions } from './PermissionModePicker';

/**
 * `Cebab-5tjb`: what `acceptEdits` means depends on Trust, and this control
 * asserted one fixed sentence that was wrong in BOTH reachable configurations,
 * in opposite directions.
 *
 * `shouldAutoAllow` (`server/src/ws/permission.ts`) is the authority:
 *   default            -> false
 *   trusted            -> true for EVERY tool
 *   untrusted          -> only Edit / Write / NotebookEdit
 *
 * So on a trusted project the old copy UNDERSTATED (Bash, WebFetch and every
 * MCP tool also run uncarded), and on an untrusted one it OVERSTATED — it named
 * "common shell commands" as auto-allowed when Bash is precisely what still
 * asks. Understating what runs without a card is the dangerous direction.
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

function tip(trusted: boolean, mode: 'default' | 'acceptEdits' = 'acceptEdits', disabled = false) {
  act(() => {
    root.render(
      <ModeToggle mode={mode} trusted={trusted} disabled={disabled} onChange={() => {}} />,
    );
  });
  return container.querySelector('.mode-toggle')?.getAttribute('title') ?? '';
}

describe('ModeToggle describes acceptEdits truthfully per Trust (Cebab-5tjb)', () => {
  test('TRUSTED: says every tool runs without a card', () => {
    const t = tip(true);
    expect(t).toContain('Bash, edits, network');
    expect(t).toContain('all run without a card');
    // The old sentence's shape. It understated a trusted project, which is the
    // dangerous direction — the operator reads "just edits" and Bash runs.
    expect(t).not.toContain('Auto-allowing file edits + common shell commands');
  });

  test('UNTRUSTED: names the three tools, and says Bash still ASKS', () => {
    const t = tip(false);
    expect(t).toContain('Edit, Write and NotebookEdit');
    expect(t).toContain('Bash and other tools still ask');
    // The specific falsehood this bead is about: Bash is not in FILE_EDIT_TOOLS,
    // so shell commands must never be described as auto-allowed here.
    expect(t).not.toContain('common shell commands');
  });

  test('ANTI-VACUITY: the two Trust states actually produce different copy', () => {
    // Without this, a fix that branched on nothing — or threaded the flag and
    // ignored it — passes both cases above as long as one sentence happens to
    // contain every asserted fragment.
    expect(tip(true)).not.toBe(tip(false));
  });

  test('ONE vocabulary: the toggle reuses the picker’s sentence verbatim', () => {
    // The whole cause of this defect was two hand-maintained copies of a safety
    // sentence drifting apart. Pin them to one source in BOTH states, and pin it
    // through the picker's own options list so neither consumer can fork it.
    for (const trusted of [true, false]) {
      const shared = acceptEditsCopy(trusted).description;
      expect(tip(trusted)).toContain(shared);
      const fromPicker = permissionModeOptions(trusted).find((o) => o.key === 'acceptEdits');
      expect(fromPicker?.description).toBe(shared);
    }
  });

  test('CONTROL: the ask-mode sentence is Trust-independent, because the behaviour is', () => {
    // `shouldAutoAllow` returns false for `default` BEFORE it looks at trust, so
    // a branch here would be inventing a distinction the server does not make.
    expect(tip(true, 'default')).toBe(tip(false, 'default'));
    expect(tip(true, 'default')).toContain('Asking for each tool use');
  });

  test('CONTROL: the disabled explanation still wins over both branches', () => {
    for (const trusted of [true, false]) {
      expect(tip(trusted, 'acceptEdits', true)).toContain('read-only for past sessions');
    }
  });
});
