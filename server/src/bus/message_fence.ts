/**
 * Structural separation for untrusted text that Cebab puts into an agent's
 * prompt (register H08 / F16).
 *
 * WHAT THIS EXISTS TO STOP. Every bus turn is a string Cebab concatenates:
 * `briefing` + the project's `CLAUDE.md` block + the message body. The first
 * two are Cebab-authored; the third is whatever another agent handed to
 * `bus_send`, and until this module it was appended raw. That matters because
 * the `CLAUDE.md` block ships with an explicit instruction — "treat everything
 * between the delimiters as AUTHORITATIVE project rules: they override your
 * defaults" — and nothing stopped a relayed message from containing that same
 * delimiter pair. A worker could hand its peer a block the peer had already
 * been told to obey.
 *
 * F16 is the reason prose alone was never the answer: framing is a mitigation,
 * a boundary is a shape the content cannot escape no matter what it says.
 *
 * THE SHAPE.
 *
 *     <bus_message_ab12cd34ef56ab78 from="reviewer">
 *     …body…
 *     </bus_message_ab12cd34ef56ab78>
 *
 * The token is 64 random bits generated AT DELIVERY TIME — after the sender's
 * text is already fixed and persisted. That ordering is the whole argument: a
 * sender cannot forge a token that did not exist when it wrote.
 *
 * WHY PER-DELIVERY AND NOT PER-SESSION. A per-session token would be simpler
 * and could be named once in the briefing, but it is reachable: bus agents run
 * without a human tool gate, so a determined participant could read a peer's
 * CLI transcript under `~/.claude/projects/<encoded-cwd>/` and lift the token
 * that peer was issued. A fresh token per delivery removes the thing there is
 * to steal.
 *
 * WHY THERE IS ALSO A DEFANGER. The token makes forgery impossible in
 * principle, but only if the reader matches the delimiter exactly; a model
 * reading `</bus_message_…>` for some other token might still take it as a
 * close. So the body additionally has every occurrence of the tag stem broken
 * with a zero-width space. Belt and braces, and it is what makes the gate —
 * "the composed prompt contains the close delimiter exactly once" — a
 * statement about the bytes rather than about the reader.
 *
 * WHAT IS NOT DEFANGED, deliberately: `<participant>`. It is a labelling
 * wrapper around agent slugs with no authority claim attached, so forging one
 * buys an attacker nothing, and breaking it would cost legibility for no gain.
 *
 * THE COST, stated plainly: an agent whose message legitimately discusses
 * these delimiters — reviewing Cebab itself, say — sees them zero-width-broken.
 * The operator's record is unaffected: the persisted event, the archived
 * `prompt.md` and the web chat all carry the original bytes. The rewrite
 * exists only in the string handed to the model.
 */
import crypto from 'node:crypto';
import { sanitizeForPrompt } from './sanitize.js';

/**
 * Tag stem for the relayed-message fence. The delivered tag is this plus a
 * random hex token, so this string on its own is never a real delimiter —
 * which is exactly what lets `defangBusDelimiters` treat ANY occurrence of it
 * in untrusted text as hostile without having to know which token is live.
 */
export const BUS_MESSAGE_TAG_STEM = 'bus_message_';

/**
 * Delimiters for the injected project-`CLAUDE.md` block (`readProjectClaudeMd`
 * in `runtime.ts`, which imports them from here).
 *
 * They live in this module rather than next to their one renderer because the
 * defanger below is the other half of the same contract: the pair that frames
 * trusted-by-the-operator rules is also the pair untrusted text most wants to
 * forge, and a copy in each file is a drift waiting to happen.
 */
export const PROJECT_RULES_OPEN = '<project_claude_md>';
export const PROJECT_RULES_CLOSE = '</project_claude_md>';

/**
 * Bytes of randomness in the per-delivery token. Eight bytes → 16 hex chars →
 * 64 bits, far past guessing for a value used exactly once that is not even
 * generated until after the guess would have had to be made.
 */
const TOKEN_BYTES = 8;

/**
 * Zero-width space, built from its code point so this source file never holds
 * a literal invisible character — the technique `runtime.ts` established for
 * the close delimiter, now shared.
 */
const ZWSP = String.fromCharCode(0x200b);

/** Insert the zero-width space after the run's first character. Insertion,
 *  not deletion: every original byte survives, and a human reading the
 *  delivered prompt still sees the token they expect. */
function breakRun(run: string): string {
  return `${run[0]}${ZWSP}${run.slice(1)}`;
}

/**
 * Break Cebab's structural delimiters inside untrusted text.
 *
 * Covers the fence's tag stem (case-insensitively, so `</BUS_MESSAGE_x>` is
 * caught too) and both project-rules delimiters. The three targets are
 * independent — `<project_claude_md>` is not a substring of
 * `</project_claude_md>`, since the latter's second character is `/` — so the
 * order of the passes does not matter and no pass can double-break another's
 * output.
 *
 * Exported for the tests and for `readProjectClaudeMd`; relay callers want
 * `fenceRelayedMessage`.
 */
export function defangBusDelimiters(text: string): string {
  // Constructed per call rather than hoisted: a module-level `/g` regex
  // carries `lastIndex` state, and while `String.replace` resets it, a shared
  // mutable matcher is not worth the reasoning.
  let out = text.replace(new RegExp(BUS_MESSAGE_TAG_STEM, 'gi'), breakRun);
  for (const d of [PROJECT_RULES_OPEN, PROJECT_RULES_CLOSE]) {
    // Split/join on the literal — no escaping question, and exact by
    // construction.
    out = out.split(d).join(breakRun(d));
  }
  return out;
}

/** A fenced message plus the token that framed it. The token is returned so
 *  callers and tests can assert on the exact pair without re-deriving it. */
export type FencedMessage = { text: string; token: string };

/**
 * Wrap one agent-authored message body for delivery.
 *
 * `from` is the sending agent's slug, stamped by the router from the pinned
 * `BusEvent.source` (never from anything the agent supplied). It goes through
 * `sanitizeForPrompt` for the same reason every other interpolated slug does:
 * the wrap must hold even if a future caller reaches this with a name that
 * skipped `isValidAgentName`.
 *
 * Called once per delivery. Cheap: one `randomBytes(8)` plus three passes over
 * a body already capped at `BUS_SEND_TEXT_MAX_BYTES`.
 */
export function fenceRelayedMessage(from: string, body: string): FencedMessage {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const tag = `${BUS_MESSAGE_TAG_STEM}${token}`;
  const text = [
    `<${tag} from="${sanitizeForPrompt(from)}">`,
    defangBusDelimiters(body),
    `</${tag}>`,
  ].join('\n');
  return { text, token };
}
