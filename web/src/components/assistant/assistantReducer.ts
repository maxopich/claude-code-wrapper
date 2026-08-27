import type { ContentBlock, ServerMsg } from '@cebab/shared/protocol';
import type { MessageView, SessionView } from '../../store';

/**
 * Cebab-8x8.3.2: the message reducer for the floating assistant widget.
 *
 * A pure `(SessionView | null, ServerMsg) => SessionView | null`. It produces a
 * value typed as {@link SessionView} — with the seven fields `sessionPhase()` /
 * `pendingToolName()` read (`id`, `projectId`, `status`, `messages`,
 * `streamingText`, `runStartedAt`, `heldMessages`) — so the panel reuses those
 * two functions verbatim and duplicates none of the subtle `tool_use` →
 * `tool_result` pairing logic that encodes the activity phase.
 *
 * The assistant deliberately lives OUTSIDE the main Redux store: its project id
 * is filtered out of `listProjects()`, so `reduceServer`'s `case 'projects'`
 * would wipe its session map on every boot / workspace switch (see
 * `routesToAssistant` in store.ts). This reducer owns the assistant session
 * alone, keyed by the single session id the server hands back.
 *
 * Gating: the caller (AssistantProvider) checks a `session_started`'s
 * `projectId` against the assistant id before dispatching. Every OTHER message
 * is session-keyed, so this reducer self-gates on `msg.sessionId === state.id`
 * and returns the SAME reference for anything that isn't the assistant's — the
 * provider dispatches every ServerMsg, and an unrelated session's stream must
 * not rerender the panel.
 *
 * The cases mirror store.ts one-for-one (the `store.ts:` anchors name the
 * originals) so the two stay honest about the same wire contract.
 */

// Synthetic ids for messages the wire doesn't id itself (`tool_result` arrives
// inside a `user_message`; `permission_request` / `result` carry no uuid). A
// module-local monotonic counter keeps them unique and deterministic for tests
// — mirrors store.ts's `nextId()`, which we can't import (module-private).
let msgSeq = 0;
function nextId(): string {
  msgSeq += 1;
  return `assistant-msg-${msgSeq}`;
}

/** store.ts:3789 — flatten a tool_result block to display text. */
function toolResultText(b: ContentBlock): string {
  if (b.type === 'tool_result') {
    const c = b.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const parts = c as Array<{ type?: string; text?: string }>;
      if (parts.every((p) => p?.type === 'text' && typeof p.text === 'string')) {
        return parts.map((p) => p.text).join('\n');
      }
    }
    return JSON.stringify(c, null, 2);
  }
  if (b.type === 'text') return b.text;
  return JSON.stringify(b);
}

/** store.ts:3814 — name the tool a batch of tool_result blocks answers. */
function resolveToolName(messages: MessageView[], blocks: ContentBlock[]): string | undefined {
  const first = blocks.find(
    (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
  );
  if (!first) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind !== 'assistant') continue;
    for (const b of m.blocks) {
      if (b.type === 'tool_use' && b.id === first.tool_use_id) return b.name;
    }
  }
  return undefined;
}

export function assistantReducer(state: SessionView | null, msg: ServerMsg): SessionView | null {
  if (msg.type === 'session_started') {
    // The provider only routes a `session_started` whose projectId is the
    // assistant's, so we adopt it unconditionally here. When a session already
    // exists (the optimistic pending session from a first send, or a reconnect
    // to the same id) migrate it: keep the scrollback, adopt the server id,
    // flip to running. Mirrors the pending-session migration in store.ts:2705.
    if (state) {
      return { ...state, id: msg.sessionId, projectId: msg.projectId, status: 'running' };
    }
    return {
      id: msg.sessionId,
      projectId: msg.projectId,
      status: 'running',
      messages: [],
      streamingText: '',
      runStartedAt: Date.now(),
      heldMessages: [],
    };
  }

  // Everything below is session-keyed. Ignore anything that isn't for the
  // adopted session (or that arrives before one exists) — same reference out,
  // so React bails and the panel doesn't rerender on other sessions' traffic.
  if (!state) return state;
  if (!('sessionId' in msg) || msg.sessionId !== state.id) return state;

  switch (msg.type) {
    case 'stream_delta': {
      // store.ts:2885 — only text deltas accumulate; input_json deltas are the
      // streamed tool arguments, not visible chat text.
      if (msg.delta.kind !== 'text') return state;
      return { ...state, streamingText: state.streamingText + msg.delta.text };
    }

    case 'assistant_message': {
      // store.ts:2897 — finalized turn text clears the rolling stream buffer.
      return {
        ...state,
        streamingText: '',
        messages: [...state.messages, { kind: 'assistant', id: msg.uuid, blocks: msg.blocks }],
      };
    }

    case 'user_message': {
      // store.ts:2927 — tool_result blocks arrive as a user_message. Flatten to
      // text, flag errors (`is_error` on the wire → `isError` on the view), and
      // resolve the tool name. The panel MUST render these: the CLI blocks some
      // calls itself with no Cebab-side permission_request, so a tool_result
      // error is the only record of that failure.
      const text = msg.blocks.map(toolResultText).join('\n');
      const isError = msg.blocks.some((b) => b.type === 'tool_result' && b.is_error === true);
      const toolName = resolveToolName(state.messages, msg.blocks);
      const m: MessageView = {
        kind: 'system',
        id: nextId(),
        subtype: 'tool_result',
        text,
        ...(isError ? { isError: true } : {}),
        ...(toolName !== undefined ? { toolName } : {}),
      };
      return { ...state, messages: [...state.messages, m] };
    }

    case 'command_output': {
      // store.ts:2909 — a locally-handled slash command; ends the turn.
      return {
        ...state,
        status: 'done',
        runStartedAt: null,
        streamingText: '',
        messages: [...state.messages, { kind: 'command_output', id: msg.uuid, text: msg.text }],
      };
    }

    case 'permission_request': {
      // store.ts:2949 — recorded for fidelity. The assistant runs trusted, so
      // this is not expected; the transcript renders it WITHOUT an approval
      // card (no `onPermissionDecide` wired) so there's nothing to answer.
      const m: MessageView = {
        kind: 'permission_request',
        id: nextId(),
        requestId: msg.requestId,
        toolName: msg.toolName,
        input: msg.input,
        ...(msg.category !== undefined ? { category: msg.category } : {}),
        ...(msg.summary !== undefined ? { summary: msg.summary } : {}),
        ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}),
        ...(msg.projectName !== undefined ? { projectName: msg.projectName } : {}),
      };
      return { ...state, messages: [...state.messages, m] };
    }

    case 'result': {
      // store.ts:3002 — turn end. Success → done, anything else → error.
      const m: MessageView = {
        kind: 'result',
        id: nextId(),
        subtype: msg.subtype,
        cost: msg.totalCostUsd,
        ...(msg.result !== undefined ? { result: msg.result } : {}),
        ...(msg.errors !== undefined ? { errors: msg.errors } : {}),
        ...(msg.numTurns !== undefined ? { numTurns: msg.numTurns } : {}),
        ...(msg.effectiveMaxTurns !== undefined
          ? { effectiveMaxTurns: msg.effectiveMaxTurns }
          : {}),
        ...(typeof msg.durationMs === 'number' ? { durationMs: msg.durationMs } : {}),
      };
      return {
        ...state,
        status: msg.subtype === 'success' ? 'done' : 'error',
        runStartedAt: null,
        streamingText: '',
        messages: [...state.messages, m],
      };
    }

    default:
      return state;
  }
}
