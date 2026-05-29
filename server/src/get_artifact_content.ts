/**
 * Cluster I Phase H3 (UI_Findings spec §4.4): the WS-facing delegate for the
 * `get_artifact_content` ClientMsg. Mirrors `search_sessions.ts`'s thin-executor
 * pattern so the handler in `ws/server.ts` is a one-liner and the read +
 * redaction core (`repo/artifact_content.ts`) stays unit-testable without a Conn.
 *
 * There is no privilege gate here (unlike C4's raw-search audit): an artifact
 * preview is always redacted, so there is nothing to authorize. The executor's
 * only job is to map the read outcome onto the `artifact_content` reply shape —
 * carrying `mutationId` so a late reply for a since-collapsed disclosure can be
 * ignored client-side, and folding a read failure into the reply's `error`
 * field (the UI shows "couldn't load" inline rather than a broken empty preview).
 */
import type { ClientMsg, ServerMsg } from '@cebab/shared';
import { readArtifactContent } from './repo/artifact_content.js';

export type GetArtifactContentInput = Extract<ClientMsg, { type: 'get_artifact_content' }>;

export function executeGetArtifactContent(args: {
  msg: GetArtifactContentInput;
  send: (msg: ServerMsg) => void;
}): void {
  const { msg, send } = args;
  const outcome = readArtifactContent(msg.mutationId);

  send({
    type: 'artifact_content',
    mutationId: msg.mutationId,
    content: outcome.content,
    mtime: outcome.mtime,
    size: outcome.size,
    // Omit falsy optionals so the wire stays lean and the UI checks are simple.
    ...(outcome.truncated ? { truncated: true } : {}),
    ...(outcome.redactedFields.length > 0 ? { redactedFields: outcome.redactedFields } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  });
}
