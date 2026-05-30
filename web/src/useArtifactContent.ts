import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArtifactContentError, ClientMsg, ServerMsg } from '@cebab/shared';

/**
 * Cluster I Phase H3 UI (UI_Findings spec §4.4 / §6): the data hook behind the
 * ArtifactsView "▸ View latest content" disclosure. Owns a single artifact's
 * lazy content fetch: it sends `get_artifact_content` only when `load()` is
 * called (on disclosure open — never on mount/select), and consumes the
 * `artifact_content` reply over the WS side-channel (`subscribeServerMsg`, NOT
 * the main store reducer — content is disclosure-local + ephemeral, same posture
 * as `useSessionSearch`'s `search_results`).
 *
 * **Lazy posture (H3-2 / R-I6).** The hook never fetches on its own — the
 * disclosure decides when to call `load()`. Subscribing to the side-channel on
 * mount is not a fetch; no `get_artifact_content` leaves until `load()` runs.
 *
 * Reply matching: keyed on the echoed `mutationId`. The hook is scoped to one
 * mutation, so it simply ignores replies for any other id (a sibling
 * disclosure's). No version counter needed — mutationId is stable for the
 * hook's lifetime (re-subscribes if the caller ever changes it).
 *
 * `send` / `subscribeServerMsg` are mirrored in refs so an unstable parent
 * closure doesn't churn the subscription.
 */

export type ArtifactContentStatus = 'idle' | 'loading' | 'loaded' | 'error';

export type ArtifactContentState = {
  status: ArtifactContentStatus;
  /** Redacted body (empty until loaded / on error). */
  content: string;
  /** File mtime, ms epoch (0 until loaded). */
  mtime: number;
  /** Bytes read, post-cap (0 until loaded). */
  size: number;
  /** True when the on-disk file exceeded the 1 MB cap (H3-4). */
  truncated: boolean;
  /** What the server masked (`['content']` or `['line:N', …]`); empty if none. */
  redactedFields: string[];
  /** Set when the read could not complete. */
  error?: ArtifactContentError;
  /** Trigger the fetch for this mutationId. Call on disclosure open (lazy). */
  load: () => void;
};

export type UseArtifactContentOpts = {
  mutationId: number;
  send: (msg: ClientMsg) => void;
  subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
};

export function useArtifactContent(opts: UseArtifactContentOpts): ArtifactContentState {
  const { mutationId } = opts;

  const sendRef = useRef(opts.send);
  sendRef.current = opts.send;
  const subscribeRef = useRef(opts.subscribeServerMsg);
  subscribeRef.current = opts.subscribeServerMsg;

  const [status, setStatus] = useState<ArtifactContentStatus>('idle');
  const [content, setContent] = useState('');
  const [mtime, setMtime] = useState(0);
  const [size, setSize] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [redactedFields, setRedactedFields] = useState<string[]>([]);
  const [error, setError] = useState<ArtifactContentError | undefined>(undefined);

  // Subscribe once; the closure reads the live refs. Accept only OUR mutationId.
  useEffect(() => {
    const unsub = subscribeRef.current((msg) => {
      if (msg.type !== 'artifact_content') return;
      if (msg.mutationId !== mutationId) return;
      setContent(msg.content);
      setMtime(msg.mtime);
      setSize(msg.size);
      setTruncated(msg.truncated === true);
      setRedactedFields(msg.redactedFields ?? []);
      setError(msg.error);
      setStatus(msg.error ? 'error' : 'loaded');
    });
    return unsub;
  }, [mutationId]);

  const load = useCallback(() => {
    setStatus('loading');
    setError(undefined);
    sendRef.current({ type: 'get_artifact_content', mutationId });
  }, [mutationId]);

  return { status, content, mtime, size, truncated, redactedFields, error, load };
}
