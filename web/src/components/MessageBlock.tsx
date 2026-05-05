import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ContentBlock } from "@cebab/shared/protocol";
import type { MessageView } from "../store";

export function MessageBlock(props: {
  message: MessageView;
  onPermissionDecide?: (requestId: string, decision: "allow" | "deny") => void;
}) {
  const { message: m, onPermissionDecide } = props;

  if (m.kind === "user") {
    return (
      <div className="msg user">
        <div className="role">you</div>
        <pre>{m.text}</pre>
      </div>
    );
  }

  if (m.kind === "assistant") {
    return (
      <div className="msg assistant">
        <div className="role">claude</div>
        {m.blocks.map((b, i) => (
          <BlockRender key={i} block={b} />
        ))}
      </div>
    );
  }

  if (m.kind === "system") {
    return null;
  }

  if (m.kind === "result") {
    return (
      <div className={`msg result ${m.subtype === "success" ? "ok" : "err"}`}>
        <div className="role">
          {m.subtype} · ${m.cost.toFixed(4)}
        </div>
        {m.errors && m.errors.length > 0 && <pre>{m.errors.join("\n")}</pre>}
      </div>
    );
  }

  if (m.kind === "error") {
    return (
      <div className="msg error">
        <div className="role">error · {m.errorKind}</div>
        <pre>{m.message}</pre>
      </div>
    );
  }

  if (m.kind === "permission_request") {
    return (
      <div className="msg permission">
        <div className="role">permission · {m.toolName}</div>
        <pre>{JSON.stringify(m.input, null, 2)}</pre>
        {m.decided ? (
          <div className="decided">decided: {m.decided}</div>
        ) : (
          <div className="actions">
            <button onClick={() => onPermissionDecide?.(m.requestId, "allow")}>Allow</button>
            <button onClick={() => onPermissionDecide?.(m.requestId, "deny")}>Deny</button>
          </div>
        )}
      </div>
    );
  }

  return null;
}

function BlockRender({ block }: { block: ContentBlock }) {
  if (block.type === "text") return <Markdown text={block.text} />;
  if (block.type === "tool_use")
    return (
      <div className="block-tool-use">
        <div className="tool-name">→ {block.name}</div>
        <pre>{JSON.stringify(block.input, null, 2)}</pre>
      </div>
    );
  if (block.type === "tool_result")
    return (
      <div className="block-tool-result">
        <pre>{typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2)}</pre>
      </div>
    );
  if (block.type === "thinking")
    return (
      <details className="block-thinking">
        <summary>thinking</summary>
        <Markdown text={block.text} />
      </details>
    );
  return null;
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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

/** Live streaming buffer rendered while text deltas are still arriving. */
export function StreamingPlaceholder({ text }: { text: string }) {
  return (
    <div className="msg assistant streaming">
      <div className="role">claude…</div>
      <Markdown text={text} />
    </div>
  );
}
