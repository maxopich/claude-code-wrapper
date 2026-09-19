import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { StopReasonCode } from '@cebab/shared/protocol';
import { isPinnedToBottom } from '../scrollAnchor';
import { groupTurns } from '../quietChat';
import { pendingToolCall, sessionPhase, type MessageView, type SessionView } from '../store';
import { MessageBlock, StreamingPlaceholder } from './MessageBlock';
import { QuietTurn } from './QuietTurn';
import { StoppedMarker } from './StoppedMarker';
import { ThinkingIndicator } from './ThinkingIndicator';

export function ChatView(props: {
  session: SessionView | null;
  isLive: boolean;
  onPermissionDecide: (requestId: string, decision: 'allow' | 'deny') => void;
  /** `Cebab-uhn2`: answer a parked AskUserQuestion card in the transcript. */
  onAskUserAnswer: (toolUseId: string, answers: Record<string, string>) => void;
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
  /**
   * `Cebab-ibb4`: collapse each finished turn to its answer. Defaulted here
   * rather than required, so the two test mounts and any future read-only
   * embedding keep today's full transcript without being asked.
   */
  quiet?: boolean;
}) {
  const phase = props.session ? sessionPhase(props.session, props.isLive) : 'idle';
  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * `Cebab-ibb4`: which collapsed turns the operator has opened. Per turn
   * rather than one global flag, because opening a turn is a question about
   * that turn ("what did it actually run?"), and a global flag would answer it
   * by re-expanding the whole conversation.
   *
   * Kept in the component, not the store: it is view state with no consequence
   * off-screen, and it is deliberately forgotten when the session changes —
   * `expandedTurns` is reset by the same effect that re-pins the scroll.
   */
  const [expandedTurns, setExpandedTurns] = useState<ReadonlySet<string>>(() => new Set());

  /**
   * Register W14: whether the operator is still following the tail. This used
   * to be assumed — the effect below re-scrolled to `scrollHeight` on every
   * streamed delta, and `store.ts` appends one per token, so reading back
   * through a running session was impossible.
   *
   * Tracked here on `scroll` rather than measured in the effect, because by the
   * time the effect runs `scrollHeight` has already grown: an operator pinned
   * to the bottom would read as "scrolled up by the height of the new content"
   * and one long tool result would un-stick the pane. See `scrollAnchor.ts`.
   *
   * Starts `true` so a fresh pane opens at the bottom.
   */
  const pinnedRef = useRef(true);

  useEffect(() => {
    if (!pinnedRef.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [
    props.session?.messages.length,
    props.session?.streamingText,
    phase,
    // Re-scroll when the stopped marker arrives or its prompt collapses.
    props.session?.lastInterrupt?.interruptAckId,
    props.session?.lastInterrupt?.reasonSubmitted,
  ]);

  // Switching sessions re-pins: the previous session's scroll position says
  // nothing about where the operator wants to be in this one, and a chat opens
  // at its newest message.
  const sessionId = props.session?.id;
  useEffect(() => {
    pinnedRef.current = true;
    setExpandedTurns(new Set());
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [sessionId]);

  /**
   * Cebab-0u8x: every streamed token produces a new session object, so ChatView
   * re-renders per token; without this the four callback props below would be
   * fresh identities on every one of those renders and `memo(MessageBlock)`
   * would never bail out — a token would re-render (and re-parse the markdown
   * of) every message already on screen.
   *
   * The callbacks come from AppShell, where all four are plain `function`
   * declarations recreated per render and two of them close over `session`,
   * whose identity also changes per token. Rather than wrap them in App.tsx
   * (which has no test file, so a wrong dependency array — a stale
   * `onPermissionDecide` approving the WRONG tool call — could not be pinned),
   * we hold the current closures in a ref refreshed on every render and hand
   * MessageBlock `useCallback(_, [])` wrappers that read `ref.current`. A ref
   * always holds AppShell's newest closure, so staleness is impossible by
   * construction and the wrapper identities never change.
   *
   * Hooks sit above the sessionless early return (`rules-of-hooks`), so the ref
   * tracks `props.session?.id`, not the `session` const bound after it.
   */
  const handlersRef = useRef({
    onPermissionDecide: props.onPermissionDecide,
    onAskUserAnswer: props.onAskUserAnswer,
    onExtendMaxTurns: props.onExtendMaxTurns,
    onEndMaxTurnsSession: props.onEndMaxTurnsSession,
    sessionId: props.session?.id,
  });
  // `useLayoutEffect` (no dependency array) so the ref is current before the
  // operator can see and click the freshly-painted frame.
  useLayoutEffect(() => {
    handlersRef.current = {
      onPermissionDecide: props.onPermissionDecide,
      onAskUserAnswer: props.onAskUserAnswer,
      onExtendMaxTurns: props.onExtendMaxTurns,
      onEndMaxTurnsSession: props.onEndMaxTurnsSession,
      sessionId: props.session?.id,
    };
  });
  const stableOnPermissionDecide = useCallback(
    (requestId: string, decision: 'allow' | 'deny') =>
      handlersRef.current.onPermissionDecide(requestId, decision),
    [],
  );
  const stableOnAskUserAnswer = useCallback(
    (toolUseId: string, answers: Record<string, string>) =>
      handlersRef.current.onAskUserAnswer(toolUseId, answers),
    [],
  );
  const stableOnExtendMaxTurns = useCallback((bumpBy: number) => {
    const { sessionId, onExtendMaxTurns } = handlersRef.current;
    if (sessionId) onExtendMaxTurns?.(sessionId, bumpBy);
  }, []);
  const stableOnEndMaxTurnsSession = useCallback(() => {
    const { sessionId, onEndMaxTurnsSession } = handlersRef.current;
    if (sessionId) onEndMaxTurnsSession?.(sessionId);
  }, []);

  if (!props.session) {
    // Cebab-ws0.5: this sentence used to render for BOTH sessionless cases,
    // and it was wrong in the commoner one — a selected project with no
    // conversation yet had a project selected. That case is now
    // `NewChatPreview`, mounted in its place; this stays for the case it
    // describes correctly, which is nothing selected at all.
    return (
      <div className="chat empty">
        <div>Select a project to start a conversation.</div>
      </div>
    );
  }

  const session = props.session;
  const lastInterrupt = session.lastInterrupt;
  const pending = pendingToolCall(session);

  // The four callbacks are the stable ref-backed wrappers built above, so
  // `memo(MessageBlock)`'s shallow compare bails out across a stream_delta. The
  // ternaries are preserved because the two max-turns props are optional and
  // other callers rely on `undefined` meaning "no card affordance"; a stable
  // wrapper inside a preserved ternary is still referentially stable while the
  // prop stays defined.
  const renderMessage = (m: MessageView) => (
    <MessageBlock
      key={m.id}
      message={m}
      onPermissionDecide={stableOnPermissionDecide}
      onAskUserAnswer={stableOnAskUserAnswer}
      extensionsUsed={props.extensionsUsed}
      onExtendMaxTurns={props.onExtendMaxTurns ? stableOnExtendMaxTurns : undefined}
      onEndMaxTurnsSession={props.onEndMaxTurnsSession ? stableOnEndMaxTurnsSession : undefined}
    />
  );

  // `Cebab-ibb4`: the quiet view is a REGROUPING of the same rows through the
  // same renderer, never a different reducer state. Six things read
  // `session.messages` — the tool-running phase, the live label, tool-name
  // resolution, the permission drain, the turn counter, Extend — so dropping a
  // message anywhere upstream of here would take the live window with it.
  const rows = props.quiet
    ? groupTurns(session.messages).map((turn) => (
        <QuietTurn
          key={turn.id}
          turn={turn}
          expanded={expandedTurns.has(turn.id)}
          onToggle={() =>
            setExpandedTurns((prev) => {
              const next = new Set(prev);
              if (!next.delete(turn.id)) next.add(turn.id);
              return next;
            })
          }
          render={renderMessage}
        />
      ))
    : session.messages.map(renderMessage);

  return (
    <div
      className="chat"
      ref={scrollRef}
      onScroll={(e) => {
        pinnedRef.current = isPinnedToBottom(e.currentTarget);
      }}
    >
      {rows}
      {phase === 'streaming' ? (
        <StreamingPlaceholder text={session.streamingText} />
      ) : phase === 'thinking' || phase === 'tool-running' ? (
        <ThinkingIndicator
          variant="block"
          phase={phase}
          startedAt={session.runStartedAt}
          toolName={pending?.name}
          toolInput={pending?.input}
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
