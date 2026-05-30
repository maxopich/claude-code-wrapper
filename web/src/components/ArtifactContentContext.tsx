import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ClientMsg, ServerMsg } from '@cebab/shared/protocol';

/**
 * Cluster I Phase H3 UI: context bridge handing the WS `send` + the
 * `subscribeServerMsg` side-channel to the ArtifactsView content disclosure.
 *
 * Why a context (vs prop-drilling): `ArtifactsView` is mounted deep inside the
 * MultiAgentTab tree (ActiveRunView → SessionSettingsPanel → ArtifactsDisclosure),
 * and `MultiAgentTab` receives `subscribeServerMsg` but NOT `send`. Threading a
 * raw WS `send` through four typed-callback layers would break the convention
 * those layers follow (each takes named `onX` callbacks, never a raw sink) and
 * bloat their prop types. The repo already solves this exact shape with the
 * RecoveryLog / ForensicViewer / Inbox provider bridges — this mirrors them, the
 * minimal version: no handlerRef (the `artifact_content` reply rides the
 * `subscribeServerMsg` side-channel directly, not the main onMessage route) and
 * no reducer (content is disclosure-local, owned by `useArtifactContent`).
 *
 * `ArtifactsView` itself keeps explicit `send` / `subscribeServerMsg` props so
 * it stays trivially unit-testable; only `ArtifactsDisclosure` (which has no
 * props path to them) reads this bridge.
 */
export type ArtifactContentBridge = {
  send: (msg: ClientMsg) => void;
  subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
};

const Ctx = createContext<ArtifactContentBridge | null>(null);

export function ArtifactContentProvider({
  children,
  send,
  subscribeServerMsg,
}: { children: ReactNode } & ArtifactContentBridge) {
  const value = useMemo<ArtifactContentBridge>(
    () => ({ send, subscribeServerMsg }),
    [send, subscribeServerMsg],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useArtifactContentBridge(): ArtifactContentBridge {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useArtifactContentBridge requires <ArtifactContentProvider>');
  return ctx;
}
