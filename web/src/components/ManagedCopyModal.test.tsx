// @vitest-environment jsdom
//
// The modal's job is to make a click informed. Two things carry that: the
// measured size, which is the whole reason the copy has a preflight at all,
// and what will NOT be copied — a snapshot that quietly dropped a symlink is
// not the snapshot it claims to be.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { ManagedCopyModal, formatSize, skipLabel, type ManagedCopyState } from './ManagedCopyModal';

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

function state(overrides: Partial<ManagedCopyState> = {}): ManagedCopyState {
  return {
    projectId: 1,
    status: 'ready',
    preflight: {
      projectId: 1,
      bytes: 1024 * 1024 * 12,
      files: 340,
      dirs: 20,
      symlinks: 0,
      largest: [{ name: 'node_modules', bytes: 1024 * 1024 * 11 }],
      skips: [],
      skipsTruncated: 0,
      credentialFiles: [],
      credentialFilesTruncated: 0,
      overCap: false,
      maxBytes: 5 * 1024 * 1024 * 1024,
      maxFiles: 300_000,
    },
    progress: null,
    result: null,
    ...overrides,
  };
}

function render(s: ManagedCopyState, onConfirm = () => {}): void {
  act(() => {
    root.render(
      <ManagedCopyModal projectName="Cebab" state={s} onConfirm={onConfirm} onClose={() => {}} />,
    );
  });
}

const copyBtn = () =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === 'Copy' || b.textContent === 'Copying…',
  );

describe('ManagedCopyModal — what the operator is agreeing to', () => {
  test('shows the measured size and file count before the Copy button is usable', () => {
    render(state());
    const text = container.textContent ?? '';
    expect(text).toContain('12 MB');
    expect(text).toContain('340');
    expect(copyBtn()?.disabled).toBe(false);
  });

  test('while measuring there is no size and no Copy', () => {
    // A modal that offered Copy before it knew the size would be asking for
    // consent to something it had not described.
    render(state({ status: 'measuring', preflight: null }));
    expect(container.textContent).toContain('Measuring');
    expect(copyBtn()?.disabled).toBe(true);
  });

  test('names the heaviest directory, so a surprising size is explainable', () => {
    render(state());
    expect(container.textContent).toContain('node_modules');
  });

  test('over the cap: Copy is refused and the limit is stated', () => {
    render(
      state({
        preflight: { ...state().preflight!, overCap: true, bytes: 6 * 1024 * 1024 * 1024 },
      }),
    );
    expect(copyBtn()?.disabled).toBe(true);
    const text = container.textContent ?? '';
    expect(text).toContain('More than');
    expect(text).toContain('past the limit');
    expect(text).toContain('Nothing has been written');
  });
});

describe('ManagedCopyModal — skips are named, not counted away', () => {
  test('an escaping symlink is listed with its path and a reason', () => {
    render(
      state({
        preflight: {
          ...state().preflight!,
          skips: [{ rel: 'vendor/link', reason: 'symlink_escapes' }],
        },
      }),
    );
    const skips = container.querySelector('[data-testid="managed-copy-skips"]');
    expect(skips?.textContent).toContain('vendor/link');
    expect(skips?.textContent).toContain('link out of the project');
  });

  test('a truncated list still says how many more there were', () => {
    // The count survives when the list does not; otherwise a tree with
    // thousands of skips would read as having a handful.
    render(
      state({
        preflight: {
          ...state().preflight!,
          skips: [{ rel: 'a', reason: 'not_regular' }],
          skipsTruncated: 999,
        },
      }),
    );
    expect(container.textContent).toContain('999');
  });

  test('control: a clean project renders no skip list at all', () => {
    render(state());
    expect(container.querySelector('[data-testid="managed-copy-skips"]')).toBeNull();
  });

  test('every skip reason has operator-facing wording', () => {
    for (const reason of [
      'symlink_escapes',
      'not_regular',
      'symlink_unsupported',
      'excluded_vcs',
      'permissions_unenforced',
    ] as const) {
      expect(skipLabel(reason).length).toBeGreaterThan(10);
    }
  });
});

describe('ManagedCopyModal — running and finishing', () => {
  test('progress names files done out of the total the preflight measured', () => {
    render(
      state({
        status: 'copying',
        progress: { files: 120, bytes: 1, totalFiles: 340, totalBytes: 2 },
      }),
    );
    expect(container.textContent).toContain('120');
    expect(container.textContent).toContain('340');
    expect(copyBtn()?.disabled).toBe(true);
  });

  test('success names the copy so the operator can find it in the sidebar', () => {
    render(
      state({
        status: 'done',
        result: {
          ok: true,
          managedProjectId: 7,
          name: 'Cebab (2)',
          files: 340,
          bytes: 1,
          symlinks: 0,
          skips: [],
          skipsTruncated: 0,
        },
      }),
    );
    expect(container.textContent).toContain('Cebab (2)');
    // Nothing left to confirm.
    expect(copyBtn()).toBeUndefined();
  });

  test('failure shows the server error rather than a generic apology', () => {
    render(state({ status: 'done', result: { ok: false, error: 'the copy failed partway' } }));
    expect(container.textContent).toContain('the copy failed partway');
  });

  test('the confirm button fires onConfirm exactly once', () => {
    const onConfirm = vi.fn();
    render(state(), onConfirm);
    act(() => {
      copyBtn()?.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test('focus starts on the safe control, not on Copy', () => {
    // The primary action writes gigabytes. A Return keypress meant for whatever
    // had focus a moment ago must not start it.
    render(state());
    expect(document.activeElement?.textContent).toBe('Cancel');
  });
});

describe('formatSize', () => {
  test('reads as a person would say it', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(999)).toBe('999 B');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1024 * 1024 * 12)).toBe('12 MB');
    expect(formatSize(1024 * 1024 * 9.5)).toBe('9.5 MB');
    expect(formatSize(1024 * 1024 * 1024 * 3.5)).toBe('3.5 GB');
    // Past ten units the decimal is noise.
    expect(formatSize(1024 * 1024 * 250)).toBe('250 MB');
  });
});

describe('ManagedCopyModal — live credentials (Cebab-ws0.11)', () => {
  test('names the credential-bearing files it found', () => {
    render(
      state({
        preflight: { ...state().preflight!, credentialFiles: ['.mcp.json', 'app/.env'] },
      }),
    );
    const box = container.querySelector('[data-testid="managed-copy-credentials"]');
    expect(box?.textContent).toContain('.mcp.json');
    expect(box?.textContent).toContain('app/.env');
  });

  test('says what will happen to them, in words the operator can act on', () => {
    render({
      ...state({
        preflight: { ...state().preflight!, credentialFiles: ['.mcp.json'] },
      }),
    });
    const box = container.querySelector('[data-testid="managed-copy-credentials"]');
    expect(box?.textContent).toContain('live credentials');
    expect(box?.textContent).toContain('only your account can open');
    // The reassurance that matters and is true: Cebab classified by NAME.
    expect(box?.textContent).toContain('never reads what is in them');
  });

  test('a truncated list keeps the count', () => {
    render(
      state({
        preflight: {
          ...state().preflight!,
          credentialFiles: ['.env'],
          credentialFilesTruncated: 42,
        },
      }),
    );
    expect(
      container.querySelector('[data-testid="managed-copy-credentials"]')?.textContent,
    ).toContain('42');
  });

  test('control: a project with no credential files renders no such section', () => {
    render(state());
    expect(container.querySelector('[data-testid="managed-copy-credentials"]')).toBeNull();
  });

  test('.git is explained as a choice, not as a failure', () => {
    // It sits in the same list as the symlink skips, so the wording is the
    // only thing separating "we chose not to" from "we could not".
    render(
      state({
        preflight: { ...state().preflight!, skips: [{ rel: '.git', reason: 'excluded_vcs' }] },
      }),
    );
    const skips = container.querySelector('[data-testid="managed-copy-skips"]');
    expect(skips?.textContent).toContain('.git');
    expect(skips?.textContent).toContain('cannot push to the original');
  });

  test('a file that could not be tightened is reported', () => {
    render(
      state({
        preflight: {
          ...state().preflight!,
          skips: [{ rel: '.env', reason: 'permissions_unenforced' }],
        },
      }),
    );
    expect(container.querySelector('[data-testid="managed-copy-skips"]')?.textContent).toContain(
      'permissions could not be tightened',
    );
  });
});
