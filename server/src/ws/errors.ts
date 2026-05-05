import type { WrapperErrorKind } from "@cebab/shared/protocol";

export function classifyError(err: unknown): { kind: WrapperErrorKind; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOENT|claude.*not.*found|spawn.*claude/i.test(message)) {
    return { kind: "claude_not_found", message };
  }
  if (/please log in|not authenticated|oauth/i.test(message)) {
    return { kind: "auth_expired", message };
  }
  if (/rate.?limit/i.test(message)) {
    return { kind: "rate_limited", message };
  }
  if (/parse|json/i.test(message)) {
    return { kind: "parse_error", message };
  }
  return { kind: "process_crashed", message };
}
