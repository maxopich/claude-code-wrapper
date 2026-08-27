import { useEffect, useRef } from 'react';
import { pendingToolName, sessionPhase, type SessionView } from '../../store';
import { MessageBlock, StreamingPlaceholder } from '../MessageBlock';
import { ThinkingIndicator } from '../ThinkingIndicator';

/**
 * Cebab-8x8.3.2: the assistant widget's scrollback.
 *
 * A trimmed cousin of {@link ChatView} — same message map + streaming
 * placeholder + block-variant thinking indicator, driven by the SAME
 * `sessionPhase()` / `pendingToolName()` so the activity phase can't drift
 * from the main chat. Deliberately NOT ChatView itself: ChatView needs far
 * more SessionView than a popup should carry (interrupt markers, max-turns
 * cards, live-session plumbing).
 *
 * `permission_request` messages are filtered OUT of the render: the assistant
 * runs trusted and emits none in the normal case, and rendering one would show
 * an approval card the operator can't meaningfully answer here. Tool failures
 * still surface — they arrive as `tool_result` error cards, which DO render.
 */
export function AssistantTranscript({ session }: { session: SessionView }) {
  const phase = sessionPhase(session, session.status === 'running');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest content in view. A popup transcript is short-lived and
  // rarely scrolled back through, so a plain pin-to-bottom (no follow
  // tracking) is enough here.
  useEffect(() => {
    const el = scrollRef.current;
    // `scrollTo` is absent under jsdom (no layout engine); guard so the effect
    // is a no-op in tests rather than throwing.
    if (el && typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [session.messages.length, session.streamingText, phase]);

  return (
    <div className="assistant-transcript" ref={scrollRef}>
      {session.messages
        .filter((m) => m.kind !== 'permission_request')
        .map((m) => (
          <MessageBlock key={m.id} message={m} />
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
