import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// Mock the JSONL writer + the DB repos so persistMessage can be exercised
// without touching disk or SQLite — we only care about the onLogFailure wiring.
vi.mock('./logger.js', () => ({ logEvent: vi.fn() }));
vi.mock('../repo/events.js', () => ({ insertEvent: vi.fn(), nextSeq: vi.fn(() => 1) }));
vi.mock('../repo/sessions.js', () => ({ setSessionCost: vi.fn(), bumpSession: vi.fn() }));

import { logEvent } from './logger.js';
import { insertEvent } from '../repo/events.js';
import { persistMessage } from './orchestrator.js';

const mockLogEvent = vi.mocked(logEvent);
const mockInsertEvent = vi.mocked(insertEvent);

const assistantMsg = {
  type: 'assistant',
  uuid: 'u1',
  session_id: 's1',
  message: { content: [] },
} as unknown as SDKMessage;

beforeEach(() => {
  vi.clearAllMocks();
  mockLogEvent.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('persistMessage', () => {
  test('invokes onLogFailure with the reason when the JSONL write fails, and still writes the DB event', async () => {
    mockLogEvent.mockResolvedValue({ ok: false, reason: 'stream_error' });
    const onLogFailure = vi.fn();

    const seq = await persistMessage('s1', assistantMsg, onLogFailure);

    expect(onLogFailure).toHaveBeenCalledTimes(1);
    expect(onLogFailure).toHaveBeenCalledWith('stream_error');
    // The DB-event path is independent and MUST still run on a JSONL failure —
    // that asymmetry is exactly why the failure was invisible before.
    expect(mockInsertEvent).toHaveBeenCalledTimes(1);
    expect(seq).toBe(1);
  });

  test('does not invoke onLogFailure when the JSONL write succeeds', async () => {
    mockLogEvent.mockResolvedValue({ ok: true });
    const onLogFailure = vi.fn();

    await persistMessage('s1', assistantMsg, onLogFailure);

    expect(onLogFailure).not.toHaveBeenCalled();
    expect(mockInsertEvent).toHaveBeenCalledTimes(1);
  });

  test('tolerates a missing onLogFailure callback on failure', async () => {
    mockLogEvent.mockResolvedValue({ ok: false, reason: 'drain_timeout' });

    // No callback passed — the optional-chaining call must not throw.
    await expect(persistMessage('s1', assistantMsg)).resolves.toBe(1);
    expect(mockInsertEvent).toHaveBeenCalledTimes(1);
  });
});
