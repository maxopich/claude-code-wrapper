import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  RESULT_SUBTYPES,
  type ContentBlock,
  type ResultSubtype,
  type ServerMsg,
  type StreamDelta,
} from '@cebab/shared/protocol';

let warnedUnknownResultSubtypes: Set<string> | null = null;
function coerceResultSubtype(raw: string): ResultSubtype {
  if (RESULT_SUBTYPES.has(raw as ResultSubtype)) return raw as ResultSubtype;
  warnedUnknownResultSubtypes ??= new Set();
  if (!warnedUnknownResultSubtypes.has(raw)) {
    warnedUnknownResultSubtypes.add(raw);
    console.warn(
      `[translate] unknown result.subtype "${raw}" — coercing to error_during_execution`,
    );
  }
  return 'error_during_execution';
}

type AnyMsg = Record<string, unknown> & { type: string; subtype?: string };

/**
 * Translate one SDK message to a ServerMsg destined for the browser.
 * Returns null for messages the UI does not need to see (e.g. message_start /
 * content_block_start / message_stop), but the caller should still persist them.
 */
export function translate(msg: SDKMessage, projectId: number): ServerMsg | null {
  const m = msg as unknown as AnyMsg;
  const sessionId = String(m.session_id ?? '');

  switch (m.type) {
    case 'system':
      if (m.subtype === 'init') {
        const init = m as AnyMsg & {
          model: string;
          tools: string[];
        };
        return {
          type: 'session_started',
          sessionId,
          projectId,
          model: init.model,
          tools: init.tools ?? [],
        };
      }
      return {
        type: 'system_event',
        sessionId,
        subtype: String(m.subtype ?? 'system'),
        payload: m,
      };

    case 'rate_limit_event': {
      // Cluster A Phase 3 (B2): typed event lifted out of the generic
      // `system_event { subtype: 'rate_limit' }` fall-through so a future
      // per-session banner can render a live countdown and the dispatcher
      // can fan out an operational warn toast. The wire-level
      // `rate_limit_info` payload is preserved verbatim for forward-compat.
      const info = (m as AnyMsg & { rate_limit_info?: Record<string, unknown> }).rate_limit_info;
      const status = typeof info?.status === 'string' ? info.status : undefined;
      const rateLimitType =
        typeof info?.rateLimitType === 'string' ? info.rateLimitType : undefined;
      const resetsAt = typeof info?.resetsAt === 'number' ? info.resetsAt : undefined;
      return {
        type: 'rate_limit_event',
        sessionId,
        status,
        resetsAt,
        rateLimitType,
        payload: info ?? m,
      };
    }

    case 'assistant': {
      const a = m as AnyMsg & {
        uuid: string;
        message: { content: ContentBlock[]; model?: string };
      };
      // Slash commands the CLI handles locally (e.g. `/context`, `/compact`,
      // `/skills`) come back as an assistant message with `model: "<synthetic>"`,
      // zero usage, and the rendered command output as a single text block.
      // Surface them as a distinct ServerMsg so the UI can render them as a
      // command-output card instead of a regular Claude reply.
      if (a.message?.model === '<synthetic>') {
        const text = (a.message.content ?? [])
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join('');
        return {
          type: 'command_output',
          sessionId,
          uuid: a.uuid,
          text,
        };
      }
      return {
        type: 'assistant_message',
        sessionId,
        uuid: a.uuid,
        blocks: a.message.content,
      };
    }

    case 'user': {
      const u = m as AnyMsg & { uuid?: string; message: { content: ContentBlock[] } };
      return {
        type: 'user_message',
        sessionId,
        uuid: u.uuid ?? '',
        blocks: u.message.content,
      };
    }

    case 'stream_event': {
      const s = m as AnyMsg & {
        uuid: string;
        event: {
          type: string;
          index?: number;
          delta?: { type: string; text?: string; partial_json?: string };
        };
      };
      const ev = s.event;
      if (ev.type !== 'content_block_delta') return null;
      const idx = ev.index ?? 0;
      let delta: StreamDelta | null = null;
      if (ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
        delta = { kind: 'text', blockIndex: idx, text: ev.delta.text };
      } else if (
        ev.delta?.type === 'input_json_delta' &&
        typeof ev.delta.partial_json === 'string'
      ) {
        delta = { kind: 'input_json', blockIndex: idx, partialJson: ev.delta.partial_json };
      }
      if (!delta) return null;
      return { type: 'stream_delta', sessionId, uuid: s.uuid, delta };
    }

    case 'wrapper': {
      // Wrapper events are synthesized by the WS layer (not the SDK) and round-trip
      // through the events table for replay. Map them back to UI-visible ServerMsgs.
      const w = m as AnyMsg & {
        requestId?: string;
        toolName?: string;
        input?: unknown;
        decision?: 'allow' | 'deny';
        kind?: string;
        message?: string;
      };
      if (m.subtype === 'permission_request' && w.requestId && w.toolName !== undefined) {
        return {
          type: 'permission_request',
          requestId: w.requestId,
          sessionId,
          toolName: w.toolName,
          input: w.input,
        };
      }
      if (m.subtype === 'permission_decided' && w.requestId && w.decision) {
        return {
          type: 'permission_decided',
          sessionId,
          requestId: w.requestId,
          decision: w.decision,
        };
      }
      // Wrapper-level errors land here too; the wrapper_error replay path
      // is best-effort — the original kind is in subtype.
      return null;
    }

    case 'result': {
      const r = m as AnyMsg & {
        subtype: string;
        duration_ms: number;
        total_cost_usd: number;
        result?: string;
        errors?: string[];
        num_turns?: number;
      };
      // Slash commands close out with a `num_turns: 0`, `total_cost_usd: 0`
      // result. The command_output card already shows the operator the
      // command completed; an extra "success · $0.0000" chip below it is
      // noise. Drop result rows for synthetic (zero-turn) commands.
      if (r.num_turns === 0) return null;
      return {
        type: 'result',
        sessionId,
        subtype: coerceResultSubtype(r.subtype),
        durationMs: r.duration_ms,
        totalCostUsd: r.total_cost_usd,
        result: r.result,
        errors: r.errors,
      };
    }

    default:
      // Forward-compat: unknown SDK message types render as a small system note client-side.
      return { type: 'system_event', sessionId, subtype: `unknown:${m.type}`, payload: m };
  }
}
