import { useEffect, useRef, useState } from 'react';
import type { ContentBlock } from '@cebab/shared/protocol';
import type { MessageView } from '../store';
import { Markdown } from './Markdown';

export function MessageBlock(props: {
  message: MessageView;
  onPermissionDecide?: (requestId: string, decision: 'allow' | 'deny') => void;
}) {
  const { message: m, onPermissionDecide } = props;

  if (m.kind === 'user') {
    return (
      <div className="msg user">
        <div className="role">you</div>
        <pre>{m.text}</pre>
      </div>
    );
  }

  if (m.kind === 'assistant') {
    return (
      <div className="msg assistant">
        <div className="role">claude</div>
        {m.blocks.map((b, i) => (
          <BlockRender key={i} block={b} />
        ))}
      </div>
    );
  }

  if (m.kind === 'system') {
    return null;
  }

  if (m.kind === 'result') {
    return (
      <div className={`msg result ${m.subtype === 'success' ? 'ok' : 'err'}`}>
        <div className="role">
          {m.subtype} · ${m.cost.toFixed(4)}
        </div>
        {m.errors && m.errors.length > 0 && <pre>{m.errors.join('\n')}</pre>}
      </div>
    );
  }

  if (m.kind === 'error') {
    return (
      <div className="msg error">
        <div className="role">error · {m.errorKind}</div>
        <pre>{m.message}</pre>
      </div>
    );
  }

  if (m.kind === 'permission_request') {
    return (
      <div className="msg permission">
        <div className="role">permission · {m.toolName}</div>
        <pre>{JSON.stringify(m.input, null, 2)}</pre>
        {m.decided ? (
          <div className="decided">decided: {m.decided}</div>
        ) : (
          <div className="actions">
            <button onClick={() => onPermissionDecide?.(m.requestId, 'allow')}>Allow</button>
            <button onClick={() => onPermissionDecide?.(m.requestId, 'deny')}>Deny</button>
          </div>
        )}
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
    <div className="msg assistant streaming">
      <div className="role">claude…</div>
      <pre className="streaming-text">
        {displayed}
        <span className="caret" />
      </pre>
    </div>
  );
}
