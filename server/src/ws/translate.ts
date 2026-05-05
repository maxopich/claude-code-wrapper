import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlock, ServerMsg, StreamDelta } from "@cebab/shared/protocol";

type AnyMsg = Record<string, unknown> & { type: string; subtype?: string };

/**
 * Translate one SDK message to a ServerMsg destined for the browser.
 * Returns null for messages the UI does not need to see (e.g. message_start /
 * content_block_start / message_stop), but the caller should still persist them.
 */
export function translate(msg: SDKMessage, projectId: number): ServerMsg | null {
  const m = msg as unknown as AnyMsg;
  const sessionId = String(m.session_id ?? "");

  switch (m.type) {
    case "system":
      if (m.subtype === "init") {
        const init = m as AnyMsg & {
          model: string;
          tools: string[];
        };
        return {
          type: "session_started",
          sessionId,
          projectId,
          model: init.model,
          tools: init.tools ?? [],
        };
      }
      return {
        type: "system_event",
        sessionId,
        subtype: String(m.subtype ?? "system"),
        payload: m,
      };

    case "rate_limit_event":
      return {
        type: "system_event",
        sessionId,
        subtype: "rate_limit",
        payload: (m as AnyMsg & { rate_limit_info?: unknown }).rate_limit_info ?? m,
      };

    case "assistant": {
      const a = m as AnyMsg & { uuid: string; message: { content: ContentBlock[] } };
      return {
        type: "assistant_message",
        sessionId,
        uuid: a.uuid,
        blocks: a.message.content,
      };
    }

    case "user": {
      const u = m as AnyMsg & { uuid?: string; message: { content: ContentBlock[] } };
      return {
        type: "user_message",
        sessionId,
        uuid: u.uuid ?? "",
        blocks: u.message.content,
      };
    }

    case "stream_event": {
      const s = m as AnyMsg & {
        uuid: string;
        event: { type: string; index?: number; delta?: { type: string; text?: string; partial_json?: string } };
      };
      const ev = s.event;
      if (ev.type !== "content_block_delta") return null;
      const idx = ev.index ?? 0;
      let delta: StreamDelta | null = null;
      if (ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        delta = { kind: "text", blockIndex: idx, text: ev.delta.text };
      } else if (ev.delta?.type === "input_json_delta" && typeof ev.delta.partial_json === "string") {
        delta = { kind: "input_json", blockIndex: idx, partialJson: ev.delta.partial_json };
      }
      if (!delta) return null;
      return { type: "stream_delta", sessionId, uuid: s.uuid, delta };
    }

    case "result": {
      const r = m as AnyMsg & {
        subtype: string;
        duration_ms: number;
        total_cost_usd: number;
        result?: string;
        errors?: string[];
      };
      return {
        type: "result",
        sessionId,
        subtype: r.subtype as ServerMsg & { type: "result" } extends infer X
          ? X extends { subtype: infer S }
            ? S
            : never
          : never,
        durationMs: r.duration_ms,
        totalCostUsd: r.total_cost_usd,
        result: r.result,
        errors: r.errors,
      };
    }

    default:
      // Forward-compat: unknown SDK message types render as a small system note client-side.
      return { type: "system_event", sessionId, subtype: `unknown:${m.type}`, payload: m };
  }
}
