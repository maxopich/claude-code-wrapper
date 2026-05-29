import { useEffect, useRef, useState } from 'react';
import type { ContentBlock } from '@cebab/shared/protocol';
import type { MessageView } from '../store';
import { Markdown } from './Markdown';
import { ClaudeMark } from './ClaudeMark';
import { badgeTooltip, renderPermissionBody } from './PermissionCards';
import { MaxTurnsResultCard } from './MaxTurnsResultCard';

export function MessageBlock(props: {
  message: MessageView;
  onPermissionDecide?: (requestId: string, decision: 'allow' | 'deny') => void;
  /**
   * Cluster F Phase A1b (UI-A1): how many times the operator has clicked
   * Extend in this session. Threaded through so MaxTurnsResultCard can
   * render the soft-cap warning at >= EXTENSION_SOFT_CAP. Optional —
   * MessageBlock callers that don't render result cards (e.g. multi-
   * agent transcripts) can omit it.
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
}) {
  const { message: m, onPermissionDecide } = props;

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
      </div>
    );
  }

  if (m.kind === 'system') {
    return null;
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
    return (
      <div className={`msg result msg-group ${m.subtype === 'success' ? 'ok' : 'err'}`}>
        <div className="avatar tool" aria-hidden="true">
          Σ
        </div>
        <div className="msg-body">
          <div className="role">
            {m.subtype} · ${m.cost.toFixed(4)}
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
            <div className="decided">decided: {m.decided}</div>
          ) : (
            <div className="actions">
              <button onClick={() => onPermissionDecide?.(m.requestId, 'allow')}>Allow</button>
              <button onClick={() => onPermissionDecide?.(m.requestId, 'deny')}>Deny</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
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
  if (block.type === 'tool_result')
    return (
      <div className="block-tool-result">
        <pre>
          {typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content, null, 2)}
        </pre>
      </div>
    );
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
