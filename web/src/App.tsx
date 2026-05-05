import { useEffect, useReducer, useRef } from "react";
import { connectWs, type WsHandle } from "./ws";
import { activeSession, initialState, isSessionPending, reduce } from "./store";
import { ProjectList } from "./components/ProjectList";
import { ChatView } from "./components/ChatView";
import { InputBox } from "./components/InputBox";

const SERVER_PORT = import.meta.env.VITE_SERVER_PORT ?? "4319";
const WS_URL = `ws://${window.location.hostname}:${SERVER_PORT}`;

export function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const wsRef = useRef<WsHandle | null>(null);

  useEffect(() => {
    const ws = connectWs({
      url: WS_URL,
      onOpen: () => {
        dispatch({ type: "ws_open" });
        ws.send({ type: "list_projects" });
      },
      onClose: () => dispatch({ type: "ws_close" }),
      onMessage: (msg) => dispatch({ type: "server", msg }),
    });
    wsRef.current = ws;
    return () => ws.close();
  }, []);

  function selectProject(projectId: number) {
    dispatch({ type: "select_project", projectId });
    wsRef.current?.send({ type: "open_project", projectId });
  }

  function selectSession(projectId: number, sessionId: string) {
    const alreadyHydrated = !!state.sessionsByProject[projectId]?.[sessionId];
    dispatch({ type: "select_session", projectId, sessionId });
    if (!alreadyHydrated) {
      wsRef.current?.send({ type: "load_session", projectId, sessionId });
    }
  }

  function newSession(projectId: number) {
    dispatch({ type: "new_session", projectId });
  }

  function toggleTrust(projectId: number, trusted: boolean) {
    wsRef.current?.send({ type: "set_trusted", projectId, trusted });
  }

  const session = activeSession(state);
  const resumeSessionId =
    session && !isSessionPending(session.id) ? session.id : undefined;

  function sendMessage(text: string) {
    if (!state.activeProjectId) return;
    dispatch({ type: "user_send", text });
    wsRef.current?.send({
      type: "send_message",
      projectId: state.activeProjectId,
      sessionId: resumeSessionId,
      text,
    });
  }

  function decidePermission(requestId: string, decision: "allow" | "deny") {
    wsRef.current?.send({ type: "permission_decision", requestId, decision });
  }

  const running = session?.status === "running";

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>cebab</h1>
          <span className={state.connected ? "dot on" : "dot off"} title={state.connected ? "connected" : "disconnected"} />
        </header>
        <ProjectList
          projects={state.projects}
          activeProjectId={state.activeProjectId}
          activeSessionByProject={state.activeSessionByProject}
          knownSessions={state.knownSessions}
          liveSessions={state.liveSessions}
          onSelectProject={selectProject}
          onSelectSession={selectSession}
          onNewSession={newSession}
          onToggleTrust={toggleTrust}
        />
      </aside>
      <main className="main">
        <ChatView session={session} onPermissionDecide={decidePermission} />
        <InputBox disabled={!state.activeProjectId || running} onSend={sendMessage} />
      </main>
    </div>
  );
}
