import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ContentBlock } from '@cebab/shared/protocol';
import type { MessageView } from '../store';

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

const SAFE_URL_SCHEMES = /^(?:https?|mailto|tel|#|\/)/i;
const UNSAFE_URL_SCHEMES = /^(?:javascript|data|vbscript|file):/i;

/**
 * Block dangerous schemes that an agent could be tricked into emitting.
 * Returning empty string causes react-markdown to render the link as plain text.
 */
function safeUrl(url: string): string {
  if (!url) return '';
  const trimmed = url.trim();
  if (UNSAFE_URL_SCHEMES.test(trimmed)) return '';
  if (SAFE_URL_SCHEMES.test(trimmed)) return trimmed;
  // Bare relative paths or fragments are fine; reject anything else.
  if (/^[a-zA-Z][\w+.-]*:/.test(trimmed)) return '';
  return trimmed;
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Smooth a stream of incoming text by drip-feeding characters at a steady
 * cadence rather than rendering whatever chunk just arrived. Keeps the
 * displayed string ~lagging the target by a frame or two so the eye sees
 * even motion. If `target` shrinks (e.g. session swap), reset to it.
 */
function useTypewriter(target: string, cps = 140): string {
  const [displayed, setDisplayed] = useState(target);
  const stateRef = useRef({ target, lastTs: 0, raf: 0 });

  useEffect(() => {
    const s = stateRef.current;
    s.target = target;
    // If the target retracted (new session, replay, etc.), snap to it.
    if (target.length < displayed.length) {
      setDisplayed(target);
      return;
    }
    // Already caught up.
    if (displayed.length >= target.length) return;

    let cancelled = false;
    s.lastTs = 0;
    const step = (ts: number) => {
      if (cancelled) return;
      if (s.lastTs === 0) s.lastTs = ts;
      const dt = (ts - s.lastTs) / 1000;
      const advance = Math.max(1, Math.ceil(dt * cps));
      s.lastTs = ts;
      setDisplayed((prev) => {
        if (prev.length >= s.target.length) return prev;
        return s.target.slice(0, Math.min(prev.length + advance, s.target.length));
      });
      if (s.target.length > displayed.length + advance) {
        s.raf = requestAnimationFrame(step);
      } else {
        // One more frame to catch any final tail.
        s.raf = requestAnimationFrame((ts2) => {
          if (cancelled) return;
          setDisplayed(s.target);
          s.lastTs = ts2;
        });
      }
    };
    s.raf = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(s.raf);
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
