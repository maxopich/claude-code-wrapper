/**
 * Test helper: find the REAL relayed-message fences in a composed prompt.
 *
 * Counting `<bus_message_` occurrences directly does not work, and the reason
 * is worth writing down because it looks like a bug the first two times you
 * hit it: the untrusted-input framing legitimately shows the reader an example
 * tag (`<bus_message_TOKEN from="…">`) so it knows what the wrapper looks
 * like. A raw count therefore reports one more than there are fences, and a
 * gate built on it would either fail on a correct prompt or — worse, once
 * someone "fixed" it by expecting two — go green on a prompt carrying a real
 * forged tag.
 *
 * A real fence is the stem followed by an actual 16-hex-char token. This
 * returns everything after each such opening delimiter, so callers can both
 * count them and assert on the `from=` label.
 *
 * Shared between `chain.security.test.ts` and `orchestrator.security.test.ts`
 * rather than copied: they assert the same property about the same bytes, and
 * a subtly different copy in one of them is how a gate quietly stops meaning
 * what its name says.
 */
import { BUS_MESSAGE_TAG_STEM } from '../bus/message_fence.js';

/** Matches the token + attributes immediately following an opening stem. */
const REAL_TAG_TAIL = /^[0-9a-f]{16} from="/;

export function realOpenTags(prompt: string): string[] {
  return prompt
    .split(`<${BUS_MESSAGE_TAG_STEM}`)
    .slice(1)
    .filter((tail) => REAL_TAG_TAIL.test(tail));
}
