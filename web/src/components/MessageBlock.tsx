import { memo, useEffect, useRef, useState } from 'react';
import type { ContentBlock } from '@cebab/shared/protocol';
import type { MessageView } from '../store';
import { rendersAnything } from '../quietChat';
import { formatResultDuration, messageCopyText } from '../format';
import { Markdown } from './Markdown';
import { ClaudeMark } from './ClaudeMark';
import { CopyButton } from './CopyButton';
import { badgeTooltip, PermissionActions, renderPermissionBody } from './PermissionCards';
import { MaxTurnsResultCard } from './MaxTurnsResultCard';
import { AskUserQuestionAnswered, AskUserQuestionCard } from './AskUserQuestionCard';

function MessageBlockImpl(props: {
  message: MessageView;
  onPermissionDecide?: (requestId: string, decision: 'allow' | 'deny') => void;
  /**
   * Cluster F Phase A1b (UI-A1): how many times the operator has clicked
   * Extend in this session. Threaded through so MaxTurnsResultCard can
   * render the soft-cap warning at >= EXTENSION_SOFT_CAP. Optional —
   * MessageBlock callers that don't render result cards can omit it.
   * `Cebab-ibb4`: that caller is `AssistantTranscript` (the built-in help
   * popover), NOT the multi-agent transcript as this said — MultiAgentTab
   * imports no MessageBlock and renders its own `EventRow`.
   */
  extensionsUsed?: number;
  /**
   * Cluster F Phase A1b (UI-A1): handler for the Extend +N buttons. The
   * parent computes the new cap (current + bumpBy) and re-issues
   * `send_message` with the bumped maxTurns. Optional so callers that
   * don't show error_max_turns cards (e.g. replays without the
   * resolver) don't need to wire a no-op.
   */
  onExtendMaxTurns?: (bumpBy: number) => void;
  /**
   * Cluster F Phase A1b (UI-A1): handler for the "End session" button
   * on the max-turns card. Default no-op = dismiss visually only; App
   * can hook teardown (clearing the per-session extensions counter,
   * scrolling away, etc.).
   */
  onEndMaxTurnsSession?: () => void;
  /**
   * `Cebab-uhn2`: the operator answered a parked `AskUserQuestion`. Optional
   * for the same reason the two above are — the help-assistant popover renders
   * MessageBlocks with no callbacks at all, and the multi-agent tab (which the
   * comment here used to name) answers its questions through its own path
   * without going near this component.
   */
  onAskUserAnswer?: (toolUseId: string, answers: Record<string, string>) => void;
}) {
  const { message: m, onPermissionDecide } = props;
  // Hover-revealed per-message copy (single-chat parity with the multi-agent
  // transcript). `null` for kinds with nothing worth copying — system
  // separators, the result footer, the interactive permission card.
  const copyText = messageCopyText(m);

  if (m.kind === 'user') {
    const isCommand = m.text.trimStart().startsWith('/');
    return (
      <div className={`msg user msg-group${isCommand ? ' user-command' : ''}`}>
        <div className="avatar user" aria-hidden="true">
          {isCommand ? '/' : 'U'}
        </div>
        <div className="msg-body">
          <div className="role">{isCommand ? 'command' : 'you'}</div>
          <pre>{m.text}</pre>
        </div>
        {copyText && <CopyButton text={copyText} className="msg-copy" label="Copy message" />}
      </div>
    );
  }

  if (m.kind === 'assistant') {
    return (
      <div className="msg assistant msg-group">
        <div className="avatar assistant" aria-hidden="true">
          <ClaudeMark />
        </div>
        <div className="msg-body">
          <div className="role">claude</div>
          {m.blocks.map((b, i) => (
            <BlockRender key={i} block={b} />
          ))}
        </div>
        {copyText && <CopyButton text={copyText} className="msg-copy" label="Copy message" />}
      </div>
    );
  }

  // Cebab-003: tool output is the one system message with something to say.
  // Everything else that lands as `kind: 'system'` — the `init` banner, the
  // `system_event` summaries — still renders nothing, exactly as before.
  //
  // `Cebab-ibb4`: the "renders nothing" half is now a shared predicate, because
  // the quiet view counts the messages it hides and puts the number on a
  // toggle. A second copy of this rule would be wrong in a way nothing could
  // see: the toggle would offer to reveal rows that expand into blank space.
  if (m.kind === 'system') {
    if (!rendersAnything(m)) return null;
    return <ToolResultCard message={m} />;
  }

  if (m.kind === 'command_output') {
    return (
      <div className="msg command-output msg-group">
        <div className="avatar tool" aria-hidden="true">
          /
        </div>
        <div className="msg-body">
          <div className="role">command output</div>
          <Markdown text={m.text} />
        </div>
        {copyText && <CopyButton text={copyText} className="msg-copy" label="Copy output" />}
      </div>
    );
  }

  if (m.kind === 'result') {
    // Cluster F Phase A1b (UI-A1): error_max_turns gets its own card
    // with Extend +N actions. The generic card below stays for all
    // other subtypes (success / error_during_execution / error_max_budget_usd
    // / error_max_structured_output_retries). The Extend handlers are
    // optional so a context that doesn't surface them (e.g. read-only
    // replay) degrades to just the body copy without buttons.
    if (m.subtype === 'error_max_turns' && props.onExtendMaxTurns && props.onEndMaxTurnsSession) {
      return (
        <MaxTurnsResultCard
          message={m}
          extensionsUsed={props.extensionsUsed ?? 0}
          onExtend={props.onExtendMaxTurns}
          onEnd={props.onEndMaxTurnsSession}
        />
      );
    }
    // Cluster H B5: assemble the per-turn footer as discrete spans so each
    // metadatum is independently styleable and the visible-text order
    // matches the accessible label. Duration is appended only when
    // `m.durationMs` is present — older replays / forward-compat envelopes
    // degrade to just `subtype · $cost`.
    const durationLabel =
      typeof m.durationMs === 'number' ? formatResultDuration(m.durationMs) : null;
    const ariaParts: string[] = [`turn metadata: ${m.subtype}`, `$${m.cost.toFixed(4)}`];
    if (durationLabel !== null) ariaParts.push(durationLabel);
    return (
      <div className={`msg result msg-group ${m.subtype === 'success' ? 'ok' : 'err'}`}>
        <div className="avatar tool" aria-hidden="true">
          Σ
        </div>
        <div className="msg-body">
          <div className="role" aria-label={ariaParts.join(', ')}>
            <span>{m.subtype}</span>
            <span aria-hidden="true"> · </span>
            <span>${m.cost.toFixed(4)}</span>
            {durationLabel !== null && (
              <>
                <span aria-hidden="true"> · </span>
                <span className="result-duration">{durationLabel}</span>
              </>
            )}
          </div>
          {m.errors && m.errors.length > 0 && <pre>{m.errors.join('\n')}</pre>}
        </div>
      </div>
    );
  }

  if (m.kind === 'error') {
    return (
      <div className="msg error msg-group">
        <div className="avatar system" aria-hidden="true">
          !
        </div>
        <div className="msg-body">
          <div className="role">error · {m.errorKind}</div>
          <pre>{m.message}</pre>
        </div>
        {copyText && <CopyButton text={copyText} className="msg-copy" label="Copy error" />}
      </div>
    );
  }

  if (m.kind === 'ask_user_question') {
    // `Cebab-uhn2`. Styled as a permission card, because that is what it is
    // from the operator's side: the turn is parked at the same gate and will
    // not move until they act. The difference is that a question is answered
    // rather than allowed — hence the shared card instead of Allow/Deny.
    const handler = props.onAskUserAnswer;
    return (
      <div className="msg permission msg-group">
        <div className="avatar tool" aria-hidden="true">
          ?
        </div>
        <div className="msg-body">
          <div className="role">
            <span>question · {m.agent}</span>
          </div>
          {m.resolved || !handler ? (
            <AskUserQuestionAnswered
              questions={m.questions}
              {...(m.answers !== undefined ? { answers: m.answers } : {})}
            />
          ) : (
            <AskUserQuestionCard
              pending={{ agent: m.agent, toolUseId: m.toolUseId, questions: m.questions }}
              onSubmit={(_agent, toolUseId, answers) => handler(toolUseId, answers)}
            />
          )}
        </div>
      </div>
    );
  }

  if (m.kind === 'permission_request') {
    // Item #5: per-tool dispatch. Server enrichment lets us pick the right
    // subcomponent + badge color; pre-Item-5 messages without `category`
    // render via the JSON-blob fallback in `renderPermissionBody`.
    const category = m.category;
    const body = renderPermissionBody({
      toolName: m.toolName,
      input: m.input,
      summary: m.summary,
      cwd: m.cwd,
      projectName: m.projectName,
    });
    return (
      <div
        className={`msg permission msg-group${category === 'dangerous' ? ' permission-dangerous' : ''}`}
      >
        <div className="avatar tool" aria-hidden="true">
          ?
        </div>
        <div className="msg-body">
          <div className="role">
            <span>permission · {m.toolName}</span>
            {category && (
              <span
                className={`permission-badge permission-badge-${category}`}
                title={badgeTooltip(category)}
              >
                {category.toUpperCase()}
              </span>
            )}
          </div>
          {(m.projectName || m.cwd) && (
            <div className="permission-context">
              {m.projectName && <code>{m.projectName}</code>}
              {m.projectName && m.cwd && ' · '}
              {m.cwd && <code className="permission-cwd">{m.cwd}</code>}
            </div>
          )}
          {body}
          {m.decided ? (
            <div className="decided">
              decided: {m.decided}
              {/* Register S06: a drained request denies without the operator.
                  Saying so is the difference between "you refused this" and
                  "this was refused for you while you were gone". */}
              {m.decidedReason === 'client_disconnected' && ' — automatic, you had disconnected'}
              {m.decidedReason === 'interrupted' && ' — automatic, the turn was interrupted'}
              {m.decidedReason === 'turn_ended' &&
                ' — automatic, the turn ended before you decided'}
            </div>
          ) : (
            <PermissionActions
              toolName={m.toolName}
              category={category}
              onDecide={(decision) => onPermissionDecide?.(m.requestId, decision)}
            />
          )}
        </div>
      </div>
    );
  }

  return null;
}

/**
 * Cebab-0u8x: memoised so a stream_delta (which produces a new session object
 * but preserves every existing message's identity) does not re-render and
 * re-parse the markdown of every message already on screen. The default shallow
 * compare is correct: every reducer path that changes a message rebuilds that
 * message object while leaving the untouched ones identical (`putSession` at
 * store.ts:1364, `permission_decided` at store.ts:3505, `drainPendingPermission
 * Cards` at store.ts:1480, `ask_user_answered`/`ask_user_resolved` at
 * store.ts:2264 and 3559), so a custom comparator would only risk missing one.
 * ChatView stabilises the callback props so this bailout actually fires.
 */
export const MessageBlock = memo(MessageBlockImpl);
MessageBlock.displayName = 'MessageBlock';

/**
 * Cebab-003: the tool-output card.
 *
 * Lines/chars, not bytes: four local `formatBytes` copies already exist in
 * this tree (ArtifactsView, PermissionCards, ManagedCopyModal, SettingsModal)
 * and a fifth buys nothing a line count doesn't say better for tool output.
 */
const PREVIEW_LINES = 8;
const PREVIEW_CHARS = 1000;
/**
 * Hard ceiling on characters handed to the DOM even when expanded. Real tool
 * results measured out at a 19 KB max, so this is a guard against the
 * pathological `Read` of a generated file, not the common case. The
 * CopyButton always carries the FULL string, so the cap can never hide output
 * the operator has no way to retrieve — and the note below says it was cut.
 */
const RENDER_CAP = 20_000;

function ToolResultCard({ message: m }: { message: Extract<MessageView, { kind: 'system' }> }) {
  const [open, setOpen] = useState(false);
  const full = m.text;
  const lines = full.split('\n');
  const preview = lines.slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS);
  const hasMore = preview.length < full.length;
  const capped = open && full.length > RENDER_CAP;
  const shown = open ? full.slice(0, RENDER_CAP) : preview;
  const label = `${m.toolName ?? 'tool'} ${m.isError ? 'error' : 'output'}`;

  return (
    <div className={`msg tool-result msg-group${m.isError ? ' has-error' : ''}`}>
      <div className="avatar tool" aria-hidden="true">
        ⎿
      </div>
      <div className="msg-body">
        <div className="role">{label}</div>
        {full.trim() === '' ? (
          <pre className="tool-result-body is-empty">(no output)</pre>
        ) : (
          <pre className="tool-result-body">{shown}</pre>
        )}
        {capped && (
          <div className="tool-result-note">
            … truncated for display at {RENDER_CAP.toLocaleString()} characters — Copy takes the
            whole thing.
          </div>
        )}
        {hasMore && (
          <button
            type="button"
            className="ghost-btn tool-result-toggle"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open
              ? '▾ show less'
              : `▸ show all${lines.length > PREVIEW_LINES ? ` · ${lines.length} lines` : ` · ${full.length} characters`}`}
          </button>
        )}
      </div>
      <CopyButton text={full} className="msg-copy" label="Copy tool output" />
    </div>
  );
}

function BlockRender({ block }: { block: ContentBlock }) {
  if (block.type === 'text') return <Markdown text={block.text} />;
  if (block.type === 'tool_use')
    return (
      <div className="block-tool-use">
        <div className="tool-name">→ {block.name}</div>
        <pre>{JSON.stringify(block.input, null, 2)}</pre>
      </div>
    );
  // No `tool_result` arm: BlockRender is only ever called with an assistant
  // message's blocks, and the API puts tool_result blocks in USER messages.
  // The arm that used to live here was unreachable from the day it was
  // written; tool output now renders through <ToolResultCard> (Cebab-003).
  if (block.type === 'thinking')
    return (
      <details className="block-thinking">
        <summary>thinking</summary>
        <Markdown text={block.text} />
      </details>
    );
  return null;
}

/**
 * Smooth a stream of incoming text by drip-feeding characters at a steady
 * cadence rather than rendering whatever chunk just arrived. Keeps the
 * displayed string ~lagging the target by a frame or two so the eye sees
 * even motion. If `target` shrinks (e.g. session swap), reset to it.
 *
 * The RAF loop reads `renderedLenRef` instead of `displayed` so the effect
 * doesn't need `displayed` in its deps — adding it would create a feedback
 * loop where each character-set restarted the effect.
 */
function useTypewriter(target: string, cps = 140): string {
  const [displayed, setDisplayed] = useState('');
  const renderedLenRef = useRef(0);

  useEffect(() => {
    // Target retracted (session swap, history replay): snap to it.
    if (target.length < renderedLenRef.current) {
      renderedLenRef.current = target.length;
      setDisplayed(target);
      return;
    }
    if (renderedLenRef.current >= target.length) return;

    let cancelled = false;
    let lastTs = 0;
    let raf = 0;
    const step = (ts: number) => {
      if (cancelled) return;
      if (lastTs === 0) lastTs = ts;
      const dt = (ts - lastTs) / 1000;
      lastTs = ts;
      const advance = Math.max(1, Math.ceil(dt * cps));
      setDisplayed((prev) => {
        if (prev.length >= target.length) return prev;
        const next = target.slice(0, Math.min(prev.length + advance, target.length));
        renderedLenRef.current = next.length;
        return next;
      });
      if (renderedLenRef.current < target.length) {
        raf = requestAnimationFrame(step);
      }
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [target, cps]);

  return displayed;
}

/** Live streaming buffer rendered while text deltas are still arriving. */
export function StreamingPlaceholder({ text }: { text: string }) {
  // Render a plain <pre> while streaming — markdown reparse per-frame is too
  // expensive. The full assistant_message replaces this block with <Markdown>.
  const displayed = useTypewriter(text);
  return (
    <div className="msg assistant streaming msg-group">
      <div className="avatar assistant" aria-hidden="true">
        <ClaudeMark />
      </div>
      <div className="msg-body">
        <div className="role">claude…</div>
        <pre className="streaming-text">
          {displayed}
          <span className="caret" />
        </pre>
      </div>
    </div>
  );
}
