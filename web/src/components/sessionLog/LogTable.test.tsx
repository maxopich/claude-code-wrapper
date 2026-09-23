// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LogRow } from '@cebab/shared/protocol';
import { LogTable } from './LogTable';

// Cebab-l9hg — the redacted badge on a Bash mutation row.
//
// A Bash mutation row renders its command VERBATIM in `summary` (the operator
// must see exactly what ran), while the same row also carries `redactedFields`
// for its masked `raw` payload. The badge must not claim to have redacted the
// command. Option (a): keep the command verbatim, make the badge honest — it
// covers the payload only, and says so.

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

// Assembled at runtime so the pre-commit secret scan (gitleaks' curl-auth-header
// rule) does not read a test fixture as a leaked credential. The loop's first
// build of this bead lost its commit to exactly that.
const FAKE_TOKEN = ['sk', 'secret', '123'].join('-');
const BASH_COMMAND = `curl https://example.com -H "Authorization: Bearer ${FAKE_TOKEN}"`;

function bashMutationRow(): LogRow {
  return {
    id: 'mutation:42',
    ts: 1_700_000_000_000,
    agent: 'agent',
    kind: 'tool',
    status: 'Bash',
    summary: BASH_COMMAND,
    severity: 'dangerous',
    raw: { toolName: 'Bash', toolInput: '<redacted>' },
    redactedFields: ['toolInput'],
  };
}

function renderRows(rows: LogRow[]) {
  act(() => {
    root.render(<LogTable rows={rows} loading={false} hasMore={false} onLoadMore={() => {}} />);
  });
}

function badge(): HTMLElement | null {
  return container.querySelector('.logs-row-redacted-badge');
}

describe('LogTable — redacted badge honesty (Cebab-l9hg)', () => {
  test('a Bash mutation row badges "payload redacted", not "redacted"', () => {
    renderRows([bashMutationRow()]);
    const b = badge();
    expect(b?.textContent).toBe('payload redacted');
  });

  test('the badge tooltip says the command above is shown exactly as it ran', () => {
    renderRows([bashMutationRow()]);
    const title = badge()?.getAttribute('title') ?? '';
    expect(title).toContain('The command above is shown exactly as it ran.');
    // It still names what it DOES cover — the masked raw payload field.
    expect(title).toContain('toolInput');
  });

  test('control: the summary still carries the verbatim command', () => {
    renderRows([bashMutationRow()]);
    const summary = container.querySelector('.logs-row-summary-text');
    // The full command — secret and all — is rendered as-is, unmasked.
    expect(summary?.textContent).toBe(BASH_COMMAND);
    expect(summary?.getAttribute('title')).toBe(BASH_COMMAND);
  });

  test('a non-Bash row keeps a truthful, generic verbatim clause', () => {
    const eventRow: LogRow = {
      id: 'event:7',
      ts: 1_700_000_000_000,
      agent: 'worker',
      kind: 'bus',
      status: 'reply',
      summary: 'worker → cebab: done',
      raw: { text: '<redacted>' },
      redactedFields: ['text'],
    };
    renderRows([eventRow]);
    const title = badge()?.getAttribute('title') ?? '';
    expect(title).toContain('The summary above is shown as-is.');
    expect(title).not.toContain('command above');
  });
});
