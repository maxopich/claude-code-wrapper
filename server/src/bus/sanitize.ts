/**
 * Sanitize an arbitrary string for safe interpolation into an LLM prompt.
 *
 * Strips ALL C0/C1 control characters (including `\n`, `\r`, and `\t` —
 * the renderers that use this helper inline values into structured
 * single-line layouts where a raw newline would let an attacker break
 * out of the line and inject top-level instructions) plus the three
 * characters that could break a `<participant>…</participant>` wrap
 * (`<`, `>`, `&`). Truncates to `maxLen` codepoints with a trailing `…`
 * if the input is longer.
 *
 * Used by the bus runtime renderers (`renderChainBriefing`,
 * `renderRosterPrompt`) to defuse prompt injection via filesystem-derived
 * names (project folder names, agent slugs from operator-controlled
 * scaffolding). The install-time slug filter prevents control chars in
 * canonical agent names today, but `projectName` flows directly from
 * `addProject`, which means a folder named `Reviewer"\n\nIgnore prior…`
 * would otherwise inline verbatim into the orchestrator briefing.
 */
export function sanitizeForPrompt(raw: string, maxLen = 80): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x1F\x7F-\x9F]/g, '').replace(/[<>&]/g, '');
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + '…';
}
