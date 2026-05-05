import { useEffect, useRef } from "react";
import type { SessionView } from "../store";
import { MessageBlock, StreamingPlaceholder } from "./MessageBlock";

export function ChatView(props: {
  session: SessionView | null;
  onPermissionDecide: (requestId: string, decision: "allow" | "deny") => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [props.session?.messages.length, props.session?.streamingText]);

  if (!props.session) {
    return (
      <div className="chat empty">
        <div>Select a project to start a conversation.</div>
      </div>
    );
  }

  return (
    <div className="chat" ref={scrollRef}>
      {props.session.messages.map((m) => (
        <MessageBlock
          key={m.id}
          message={m}
          onPermissionDecide={props.onPermissionDecide}
        />
      ))}
      {props.session.streamingText && (
        <StreamingPlaceholder text={props.session.streamingText} />
      )}
    </div>
  );
}
