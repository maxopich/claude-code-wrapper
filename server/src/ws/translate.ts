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
        // Cluster B Phase 2 (BE-B1): stop dropping the rich SDK init payload.
        // The SDK's SDKSystemMessage subtype 'init' carries cwd,
        // permission_mode, apiKeySource, slash_commands, skills, agents,
        // plugins, mcp_servers (with per-server status), output_style,
        // fast_mode_state, claude_code_version, memory_paths — all of which
        // Cebab silently dropped pre-Phase-2.
        //
        // We forward verbatim and let the AuthorityPanel (Phase 6+) render.
        // Missing fields on the SDK side stay undefined on the wire (the
        // schema is fully-optional); old clients ignore the extras.
        //
        // snake_case on the SDK → camelCase on the wire (Cebab convention
        // across the rest of protocol.ts).
        const init = m as AnyMsg & {
          model: string;
          tools: string[];
          cwd?: string;
          permission_mode?: string;
          apiKeySource?: string;
          claude_code_version?: string;
          output_style?: string;
          fast_mode_state?: string;
          memory_paths?: { auto?: string; [k: string]: string | undefined };
          mcp_servers?: { name: string; status: string }[];
          slash_commands?: string[];
          skills?: string[];
          agents?: string[];
          plugins?: { name: string; path: string }[];
        };
        return {
          type: 'session_started',
          sessionId,
          projectId,
          model: init.model,
          tools: init.tools ?? [],
          ...(init.cwd !== undefined && { cwd: init.cwd }),
          ...(init.permission_mode !== undefined && {
            // PermissionMode union is enforced at the protocol type, but the
            // SDK may add new variants — we cast and forward, the client
            // gracefully ignores unknowns.
            permissionMode: init.permission_mode as 'default' | 'acceptEdits' | 'bypassPermissions',
          }),
          ...(init.apiKeySource !== undefined && {
            apiKeySource: init.apiKeySource as 'user' | 'project' | 'org' | 'temporary' | 'oauth',
          }),
          ...(init.claude_code_version !== undefined && {
            claudeCodeVersion: init.claude_code_version,
          }),
          ...(init.output_style !== undefined && { outputStyle: init.output_style }),
          ...(init.fast_mode_state !== undefined && {
            fastModeState: init.fast_mode_state as 'off' | 'cooldown' | 'on',
          }),
          ...(init.memory_paths !== undefined && { memoryPaths: init.memory_paths }),
          ...(init.mcp_servers !== undefined && { mcpServers: init.mcp_servers }),
          ...(init.slash_commands !== undefined && { slashCommands: init.slash_commands }),
          ...(init.skills !== undefined && { skills: init.skills }),
          ...(init.agents !== undefined && { agents: init.agents }),
          ...(init.plugins !== undefined && { plugins: init.plugins }),
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
      // `system_event { subtype: 'rate_limit' }` fall-through so the
      // RateLimitBanner (Cluster D Phase 4c) can render a live countdown
      // and the dispatcher can fan out an operational warn toast. The
      // wire-level `rate_limit_info` payload is preserved verbatim for
      // forward-compat.
      //
      // Cluster D Phase 4a (spec §4.1, BE-D3): convert SDK's `resetsAt`
      // (raw SECONDS since epoch — a real-world bite-back the spec
      // explicitly calls out) to `resetsAtMs`. Every consumer wants ms
      // so they can do `Date.now() - resetsAtMs` for countdown math
      // without rediscovering the unit per call site. Legacy `resetsAt`
      // is preserved as raw-from-SDK seconds for forward-compat; new
      // code uses `resetsAtMs`.
      //
      // Overage fields (`overageStatus` / `overageResetsAt` /
      // `isUsingOverage`) are forwarded too so the banner can
      // distinguish "hard limit hit but overage available" from "fully
      // exhausted". Same seconds→ms conversion applies to
      // `overageResetsAt`.
      const info = (m as AnyMsg & { rate_limit_info?: Record<string, unknown> }).rate_limit_info;
      const status = typeof info?.status === 'string' ? info.status : undefined;
      const rateLimitType =
        typeof info?.rateLimitType === 'string' ? info.rateLimitType : undefined;
      const resetsAt = typeof info?.resetsAt === 'number' ? info.resetsAt : undefined;
      const resetsAtMs = resetsAt !== undefined ? resetsAt * 1000 : undefined;
      const overageStatus =
        typeof info?.overageStatus === 'string' ? info.overageStatus : undefined;
      const overageResetsAt =
        typeof info?.overageResetsAt === 'number' ? info.overageResetsAt : undefined;
      const overageResetsAtMs = overageResetsAt !== undefined ? overageResetsAt * 1000 : undefined;
      const isUsingOverage =
        typeof info?.isUsingOverage === 'boolean' ? info.isUsingOverage : undefined;
      return {
        type: 'rate_limit_event',
        sessionId,
        status,
        resetsAt,
        resetsAtMs,
        rateLimitType,
        overageStatus,
        overageResetsAtMs,
        isUsingOverage,
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
        // Cluster F Phase A1b (UI-A1): forward the SDK's num_turns so the
        // client's turn-counter chip + MaxTurnsResultCard have ground truth.
        // The synthetic-command short-circuit above already returns null
        // when num_turns === 0, so we never ship a misleading "0 turns" here.
        ...(typeof r.num_turns === 'number' && Number.isFinite(r.num_turns)
          ? { numTurns: r.num_turns }
          : {}),
      };
    }

    default:
      // Forward-compat: unknown SDK message types render as a small system note client-side.
      return { type: 'system_event', sessionId, subtype: `unknown:${m.type}`, payload: m };
  }
}
