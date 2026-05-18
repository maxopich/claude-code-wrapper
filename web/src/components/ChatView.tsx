import { useEffect, useRef } from 'react';
import { pendingToolName, sessionPhase, type SessionView } from '../store';
import { MessageBlock, StreamingPlaceholder } from './MessageBlock';
import { ThinkingIndicator } from './ThinkingIndicator';

export function ChatView(props: {
  session: SessionView | null;
  isLive: boolean;
  onPermissionDecide: (requestId: string, decision: 'allow' | 'deny') => void;
}) {
  const phase = props.session ? sessionPhase(props.session, props.isLive) : 'idle';
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [props.session?.messages.length, props.session?.streamingText, phase]);

  if (!props.session) {
    return (
      <div className="chat empty">
        <div>Select a project to start a conversation.</div>
      </div>
    );
  }

  const session = props.session;

  return (
    <div className="chat" ref={scrollRef}>
      {session.messages.map((m) => (
        <MessageBlock key={m.id} message={m} onPermissionDecide={props.onPermissionDecide} />
      ))}
      {phase === 'streaming' ? (
        <StreamingPlaceholder text={session.streamingText} />
      ) : phase === 'thinking' || phase === 'tool-running' ? (
        <ThinkingIndicator
          variant="block"
          phase={phase}
          startedAt={session.runStartedAt}
          toolName={pendingToolName(session)}
        />
      ) : null}
    </div>
  );
}
