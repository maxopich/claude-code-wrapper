import { useEffect, useRef } from 'react';
import type { StopReasonCode } from '@cebab/shared/protocol';
import { pendingToolName, sessionPhase, type SessionView } from '../store';
import { MessageBlock, StreamingPlaceholder } from './MessageBlock';
import { StoppedMarker } from './StoppedMarker';
import { ThinkingIndicator } from './ThinkingIndicator';

export function ChatView(props: {
  session: SessionView | null;
  isLive: boolean;
  onPermissionDecide: (requestId: string, decision: 'allow' | 'deny') => void;
  /**
   * Cluster C Phase 2: callbacks for the inline reason-for-stop prompt.
   * Optional — when absent the StoppedMarker still renders the marker
   * but the prompt buttons short-circuit (Skip silently no-ops).
   */
  onSubmitStopReason?: (
    sessionId: string,
    interruptAckId: string,
    reasonCode: StopReasonCode,
    reasonText?: string,
  ) => void;
  onSkipStopReason?: (sessionId: string) => void;
  /**
   * Cluster F Phase A1b (UI-A1): per-session counter of how many times
   * the operator has clicked Extend on a max-turns result card. Drives
   * the soft-cap warning tooltip. Threaded into MessageBlock so the
   * MaxTurnsResultCard can render it.
   */
  extensionsUsed?: number;
  /**
   * Cluster F Phase A1b (UI-A1): Extend handler. Receives the bump
   * amount (+25 / +50); the parent (App.tsx) computes new cap = current
   * + bumpBy and re-issues send_message with that maxTurns. Optional
   * when no max-turns cards are expected (e.g. preview-only views).
   */
  onExtendMaxTurns?: (sessionId: string, bumpBy: number) => void;
  /**
   * Cluster F Phase A1b (UI-A1): "End session" handler. The session is
   * already done — this just lets App.tsx clear local state like the
   * extensions counter or scroll away.
   */
  onEndMaxTurnsSession?: (sessionId: string) => void;
}) {
  const phase = props.session ? sessionPhase(props.session, props.isLive) : 'idle';
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [
    props.session?.messages.length,
    props.session?.streamingText,
    phase,
    // Re-scroll when the stopped marker arrives or its prompt collapses.
    props.session?.lastInterrupt?.interruptAckId,
    props.session?.lastInterrupt?.reasonSubmitted,
  ]);

  if (!props.session) {
    return (
      <div className="chat empty">
        <div>Select a project to start a conversation.</div>
      </div>
    );
  }

  const session = props.session;
  const lastInterrupt = session.lastInterrupt;

  return (
    <div className="chat" ref={scrollRef}>
      {session.messages.map((m) => (
        <MessageBlock
          key={m.id}
          message={m}
          onPermissionDecide={props.onPermissionDecide}
          extensionsUsed={props.extensionsUsed}
          onExtendMaxTurns={
            props.onExtendMaxTurns
              ? (bumpBy) => props.onExtendMaxTurns?.(session.id, bumpBy)
              : undefined
          }
          onEndMaxTurnsSession={
            props.onEndMaxTurnsSession ? () => props.onEndMaxTurnsSession?.(session.id) : undefined
          }
        />
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
      {/*
        Cluster C Phase 2 (UI-10 + spec §4.2): render the Stopped
        marker + inline reason-for-stop prompt after the last message
        block. Stays visible until the operator's next user_send
        clears `lastInterrupt` (reducer handles the wipe).
      */}
      {lastInterrupt && (
        <StoppedMarker
          ts={lastInterrupt.ts}
          ackLatencyMs={lastInterrupt.ackLatencyMs}
          reasonSubmitted={lastInterrupt.reasonSubmitted}
          onSubmit={(code, text) =>
            props.onSubmitStopReason?.(session.id, lastInterrupt.interruptAckId, code, text)
          }
          onSkip={() => props.onSkipStopReason?.(session.id)}
        />
      )}
    </div>
  );
}
