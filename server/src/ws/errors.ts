import type { WrapperErrorKind } from '@cebab/shared/protocol';

type ErrLike = {
  name?: string;
  code?: string;
  syscall?: string;
  message?: string;
};

/**
 * Map an unknown error into a WrapperErrorKind. Branches on instance shape
 * first (Node syscall errors have `.code`, AbortError has `.name`), then falls
 * back to message-substring matching. Tightened regexes to avoid false-positives
 * (e.g. "json" appearing in an unrelated SDK validation error).
 */
export function classifyError(err: unknown): { kind: WrapperErrorKind; message: string } {
  const e = (err && typeof err === 'object' ? err : {}) as ErrLike;
  const message = err instanceof Error ? err.message : String(err);

  if (e.code === 'ENOENT' && (e.syscall === 'spawn' || /claude/i.test(message))) {
    return { kind: 'claude_not_found', message };
  }
  if (e.name === 'AbortError') {
    return { kind: 'process_crashed', message };
  }

  if (/(^|\s)(claude.*not.*found|spawn.*claude.*ENOENT)/i.test(message)) {
    return { kind: 'claude_not_found', message };
  }
  // Alternation with one optional group containing `.*expired` — bounded
  // backtracking, not catastrophic. ESLint's safe-regex check is overly
  // conservative on alternated `.*` patterns.
  // eslint-disable-next-line security/detect-unsafe-regex
  if (/please log in|not authenticated|oauth(?:.*expired)?/i.test(message)) {
    return { kind: 'auth_expired', message };
  }
  if (/rate[ -]?limit/i.test(message)) {
    return { kind: 'rate_limited', message };
  }
  // Tightened: was /parse|json/i which matched any error mentioning JSON.
  if (/^(JSON\.parse|parse error|unexpected token|invalid JSON)/i.test(message)) {
    return { kind: 'parse_error', message };
  }
  return { kind: 'process_crashed', message };
}
