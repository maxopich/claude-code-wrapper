/**
 * Sensitive-field redactor (Phase H).
 *
 * The Logs surface ships raw `tool_use.input` / `tool_result.content` /
 * assistant-text payloads to the browser. Those payloads can include real
 * secrets: a `Bash(cat ~/.aws/credentials)` output, a `Read('.env')` result,
 * a `Write('.git/config')` input, an LLM turn that just echoed an API key.
 * A one-click Logs button would silently elevate every prior session's
 * disk-cached JSONL into operator-visible terrain.
 *
 * Mitigation: server-side, two-tier.
 *   1. `redactSensitive(payload)` walks the projected JSON and replaces
 *      values it considers sensitive with the literal `'<redacted>'`,
 *      returning the redacted blob plus the list of dot-paths that were
 *      masked. The Logs WS handler runs this before serializing.
 *   2. The browser's `Show raw` toggle shows the already-redacted blob;
 *      only an explicit `Reveal sensitive` confirm re-requests the chunk
 *      with `revealSensitive=true`, which short-circuits this function.
 *
 * Heuristics (kept narrow on purpose — false positives are cheap, false
 * negatives leak credentials):
 *   - Field names matching `password|passwd|secret|token|apikey|api_key|
 *     authorization|auth_token|access_key|private_key|client_secret|
 *     bearer|credentials?|cookie` (case-insensitive, anywhere in the key).
 *     Always masked.
 *   - Field names hinting at a filesystem path (`file_path|path|notebook_path`)
 *     whose value matches a sensitive-path regex (see SENSITIVE_PATH_PATTERNS).
 *     Mask the SIBLING value field (e.g. `content`, `output`, `text`) on
 *     the same object — not the path itself, which is operator-meaningful.
 *   - String values that look like an obvious credential: header shapes
 *     (`Bearer <jwt>`, `Authorization: ...`), API keys (`sk-...`, AWS
 *     `AKIA[A-Z0-9]{16}`), a PEM `BEGIN … PRIVATE KEY` header, and the
 *     vendor token prefixes in SENSITIVE_VALUE_PATTERNS (GitHub, GitLab,
 *     Slack, Google, npm, Stripe live). Masked in place.
 *
 * Pure: no I/O, no globals. Same input → same output (modulo `JSON.stringify`
 * key order, which we don't depend on). Browser-safe.
 */

import { bashCommandPathArguments } from './mutation.js';

export type RedactResult = {
  /** Deep-cloned payload with sensitive values replaced by '<redacted>'. */
  redacted: unknown;
  /** Dot-paths that were masked. Empty when nothing matched. */
  fields: string[];
};

const REDACTED_TOKEN = '<redacted>';
const MAX_DEPTH = 12;

/**
 * Reported path for a mask applied to the payload ROOT — a top-level string
 * that is itself a credential, or a whole payload that sat past `MAX_DEPTH`.
 *
 * Registers D24/D25: both of those masked the value and reported nothing,
 * because the dot-path for the root is the empty string and every caller
 * gates on `fields.length > 0`. A sentinel is what lets "the entire payload
 * was a secret" and "nothing here was sensitive" stop being the same answer.
 * Deliberately not a valid dot-path, so it can never collide with a real key.
 */
export const ROOT_FIELD = '(root)';

/** Field names whose VALUE is always redacted (case-insensitive substring). */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /apikey/i,
  /api[_-]key/i,
  /access[_-]key/i,
  /private[_-]key/i,
  /client[_-]secret/i,
  /auth(?:orization)?(?!or)/i, // 'authorization', 'auth_token', 'auth'; not 'author'
  /bearer/i,
  /credentials?/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /session[_-]id/i,
];

/** Directory segments whose CONTENTS (anywhere under that path) are sensitive.
 *  Matched as a substring `/<seg>/` in the normalized path. */
const SENSITIVE_DIR_SEGMENTS: readonly string[] = ['.aws', '.gnupg', '.ssh', '.kube'];

/** Basenames that are always sensitive on their own (no extension required). */
const SENSITIVE_BASENAMES: ReadonlySet<string> = new Set(['.envrc', '.netrc', '.pgpass', '.npmrc']);

/** Basenames where any value with this exact stem (optionally followed by an
 *  extension) is sensitive — `.env`, `.env.local`, `credentials.json`, etc. */
const SENSITIVE_BASENAME_STEMS: readonly string[] = [
  '.env',
  'credentials',
  'id_rsa',
  'id_ed25519',
  'token',
  'secret',
  'secrets',

  // ---- register of0 ----
  // Project-scoped MCP declarations. `mcpServers[*].env` is the documented home
  // for a server's credentials, so the whole file is secret once anything is
  // declared there. Reported case: a Read of a project `.mcp.json` shipped a live
  // client id and client secret into an exported session log AND onto the Logs
  // surface, while `redactedFields` truthfully reported that something else had
  // been masked — which is what made the output look inspected.
  '.mcp.json',
  // The CLI's user-scope config. CLAUDE.md: its top-level `mcpServers` blocks
  // carry `env`, and Trust does not scope them — TOFU is the only brake.
  '.claude.json',
];

// A stem rather than an exact basename for both: the stem matcher anchors at the
// START of the basename, so it also covers the `.bak` / `.backup` forms the CLI
// itself writes, at identical blast radius on every audit negative (`mcp.json`,
// `docs/mcp.json.md`, `my.mcp.json.bak` all stay unmasked — verified). Bare
// `mcp.json` / `claude.json` are deliberately NOT matched: the CLI's files are
// dotfiles, and an undotted one in a repo is a schema or a doc.

/**
 * Register H16: extensions that mark the whole file as key material, matched
 * on the basename's suffix rather than its stem.
 *
 * NOT here, deliberately: `.crt`, `.cer`, `.pub`. Those are the PUBLIC halves
 * — they are meant to be handed out, and masking them costs the operator real
 * signal (which cert is this run using?) while protecting nothing. The
 * header's "false positives are cheap" is a rule about credentials, not a
 * licence to mask anything that sounds cryptographic.
 */
const SENSITIVE_BASENAME_EXTENSIONS: readonly string[] = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
];

/** Special compound paths — exact match against the tail of the path. */
const SENSITIVE_TAILS: readonly string[] = [
  '/.git/config',
  // Register of0. Both halves of the settings pair, deliberately.
  //
  // `settings.local.json` is the obvious one: gitignored, per-machine, never
  // reviewed — exactly where an operator parks a real key in an `env:` block.
  // `settings.json` is the judgement call, and it went the same way: CLAUDE.md's
  // env-precedence caveat documents that a project's `settings.json` can define
  // `env: { ANTHROPIC_API_KEY }` and silently reroute billing, which is a
  // credential by any reading. The cost is that a Read of it shows `<redacted>`
  // in the Logs surface; the operator can still open the file, and the Authority
  // panel is a separate code path that keeps rendering hooks/permissions/MCP
  // structurally. Header rule applies: false negatives leak credentials.
  //
  // Tails rather than basenames because `settings.json` alone is far too generic
  // — the `/.claude/` prefix is what makes this narrow (`web/settings.json` and
  // `.vscode/settings.json` stay untouched).
  '/.claude/settings.json',
  '/.claude/settings.local.json',
];

/** Field names whose value contains a filesystem path. When matched, we test
 *  the value against `SENSITIVE_PATH_PATTERNS` to decide whether to mask the
 *  sibling content field. */
const PATH_FIELD_NAMES: ReadonlySet<string> = new Set([
  'file_path',
  'filePath',
  'path',
  'notebook_path',
  'notebookPath',
]);

/** Sibling fields on the same object that are masked when a path field marks
 *  the object as touching a sensitive file. */
const SIBLING_VALUE_FIELDS: ReadonlySet<string> = new Set([
  'content',
  'output',
  'text',
  'new_string',
  'old_string',
  'data',

  // Register of0. `ws/session_log.ts`'s `mutationToLogRow` projects a row shaped
  // `{toolName, category, filePath, cwd, promoted, confirmedAt, toolInput,
  // toolResult}`. `filePath` IS a PATH_FIELD_NAME, so the sibling rule already
  // fired on that row — and then found nothing to mask, because these two names
  // were not in this set.
  //
  // Measured: a confirmed mutation on `.env` shipped its whole captured tool
  // input and output through the Logs projector, for a file that has been on the
  // path list since Phase H. The comment at that call site asserted the
  // opposite. This is the list the comment was describing.
  //
  // Wholesale masking (the branch below) is right for both: `parseToolIoJson`
  // yields an object, a bare string, or `capToolIoJson`'s
  // `{truncated, bytes, preview}` wrapper, and one token covers all three.
  'toolInput',
  'toolResult',
]);

/**
 * Inline value patterns — masked wherever they appear (heuristic, not
 * comprehensive; here to catch the obvious leaks).
 *
 * Register H16: the first five were the whole list, which covered no private
 * key and none of the vendor token shapes that dominate real leaks. Each
 * addition is a literal prefix plus a length floor — no alternation inside a
 * quantifier, so `security/detect-unsafe-regex` has nothing to backtrack on.
 *
 * The floors are deliberately below the real token lengths (vendors change
 * them) but high enough that prose cannot trip them: "ghp_" alone is not a
 * match, "ghp_" followed by 20+ token characters is.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  // Authorization headers (case-insensitive, anywhere in the string).
  /\bauthorization:\s*\S+/i,
  /\bbearer\s+[A-Za-z0-9._\-+/]{16,}/i,
  // AWS access keys
  /\bAKIA[0-9A-Z]{16}\b/,
  // Anthropic-style API keys (sk-... 32+ chars)
  /\bsk-[A-Za-z0-9_-]{32,}/,
  // Generic JWT-shape (three b64 segments)
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,

  // ---- H16 additions ----
  // PEM private keys. The header alone is enough: whatever follows it in the
  // payload is key material, and it is the single highest-value shape here.
  // `PRIVATE KEY` covers RSA/EC/DSA/OPENSSH/ENCRYPTED variants via the
  // wildcard, which is bounded by the line-ish `[A-Z ]` class rather than `.`.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // GitHub: personal/OAuth/user/server/refresh tokens share the ghX_ shape.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  // GitHub fine-grained PATs.
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  // GitLab personal access tokens.
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  // Slack bot/user/app/refresh/legacy tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  // Google API keys.
  /\bAIza[A-Za-z0-9_-]{30,}/,
  // npm automation/publish tokens.
  /\bnpm_[A-Za-z0-9]{30,}/,
  // Stripe live secret + restricted keys. (Test keys `sk_test_` are
  // deliberately NOT here — they are publishable by design and masking them
  // costs an operator real debugging signal.)
  /\b[sr]k_live_[A-Za-z0-9]{20,}/,
];

/**
 * Does this key NAME look like it holds a credential?
 *
 * Exported (register H05) because the redactor is not the only consumer that
 * needs this judgement: `repo/project_authority.ts`'s `detectEnvInjections`
 * decides whether a key declared in a project's `settings.json` `env:` block
 * should park the session-start gate for operator acknowledgement. Sharing
 * one pattern list means a name that gets masked in a transcript is also a
 * name that gets a prompt before it reaches an agent's environment — rather
 * than two heuristics drifting apart.
 *
 * Name-only, deliberately: no value is ever inspected here (the BE-B12
 * invariant that env VALUES never leave the server).
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * Does this PATH name a file whose whole body should be treated as a secret?
 *
 * `.env`, `credentials`, `id_rsa`, anything under `~/.aws|.ssh|.gnupg|.kube`,
 * `.git/config`, `.mcp.json`, `.claude.json`, `.claude/settings*.json` — see
 * the lists above, which `Cebab-of0` extended after an exported session log
 * shipped a live API key out of a project `.mcp.json`.
 *
 * EXPORTED (Cebab-ws0.11) so callers can ask the question directly. Two of
 * them exist: the managed-agent copy engine, which writes credential-bearing
 * files at a tighter mode and names them in the copy preflight, and
 * `repo/artifact_content.ts`, which used to PROBE this predicate by redacting
 * a sentinel and checking whether the sibling came back masked — a workaround
 * that existed only because this was private.
 *
 * Path-only: nothing here reads a file, and no value is inspected.
 */
export function pathLooksSensitive(value: string): boolean {
  // Normalize: forward slashes only, lowercase for case-insensitive checks.
  // Use string ops rather than regex so the safe-regex linter can't flag
  // polynomial-backtracking false positives — the prior PR #78 refactored
  // a similar path-normalization regex away from `/\/+$/` for the same reason.
  const norm = value.replace(/\\/g, '/').toLowerCase();

  for (const tail of SENSITIVE_TAILS) {
    // Tails are stored with a leading `/` (e.g. `/.git/config`). Accept both
    // bare ("starts with the tail minus the slash") and slash-prefixed forms.
    if (norm === tail || norm.endsWith(tail)) return true;
    const bare = tail.slice(1);
    if (norm === bare || norm.endsWith(`/${bare}`)) return true;
  }
  for (const seg of SENSITIVE_DIR_SEGMENTS) {
    const wrapped = `/${seg}/`;
    if (norm.includes(wrapped) || norm.startsWith(`${seg}/`)) return true;
  }

  const basename = basenameOf(norm);
  if (SENSITIVE_BASENAMES.has(basename)) return true;
  // Register of0: the stem comparison was blind to a LEADING dot, so
  // `~/.claude/.credentials.json` — which README names as where Cebab's own OAuth
  // credentials live — did not match the `credentials` stem, while
  // `~/.aws/credentials` did. The bug is in the matcher, not the list: every stem
  // here has a dotfile form, and adding `.credentials` as a one-off would leave
  // the same blindness in place for the other six.
  //
  // BOTH forms are tested, not just the stripped one. Comparing only the stripped
  // basename would break `.env`, which strips to `env` and equals no stem.
  //
  // Blast radius is enumerable: exactly the dotted forms of the stems above
  // (`.credentials*`, `.token*`, `.secret*`, `.secrets*`, `.id_rsa*`,
  // `.id_ed25519*`), each itself credential-bearing. Because the match anchors at
  // the start of the basename it does not reach `.envelope.json`,
  // `.tokenizer.json` or `.secretary.md` — all three are pinned as negatives.
  const stemForms = basename.startsWith('.') ? [basename, basename.slice(1)] : [basename];
  for (const stem of SENSITIVE_BASENAME_STEMS) {
    for (const form of stemForms) {
      if (form === stem) return true;
      if (form.startsWith(`${stem}.`)) return true;
    }
  }
  // H16: `norm` is already lowercased, so this is case-insensitive — which
  // matters on Windows, where `SERVER.PEM` is the same file.
  for (const ext of SENSITIVE_BASENAME_EXTENSIONS) {
    if (basename.endsWith(ext)) return true;
  }
  return false;
}

function basenameOf(normPath: string): string {
  const slash = normPath.lastIndexOf('/');
  return slash === -1 ? normPath : normPath.slice(slash + 1);
}

function valueContainsSensitivePattern(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((re) => re.test(value));
}

// ---- Cebab-ygu.51: a credential-NAMED assignment inside free text ----

/**
 * `Cebab-ygu.51` [security]. Mask the VALUE of `name = value` where the NAME is
 * credential-shaped, wherever that pair appears inside a string.
 *
 * WHY THIS EXISTS. Everything above works on JSON STRUCTURE: a sensitive KEY,
 * a sensitive PATH with a sibling body, a vendor-shaped VALUE. An assistant
 * message is none of those — its text sits under the key `text`, which no key
 * rule matches, and a self-chosen secret matches no vendor pattern. So
 * a `db_password` line naming a passphrase the operator chose themselves went
 * out of a durable message verbatim, in the "share-safe" export.
 *
 * (The examples in this file name no value, deliberately: an assignment written
 * out in full is what the secret scan reads, and the rule below would mask this
 * comment if it ever walked one.)
 *
 * `Cebab-ygu.47` measured that class as empty and it was not: the durable
 * copies in that transcript were masked because the SAME STRING also happened
 * to contain an AKIA key, and the branch above replaces the entire string when
 * any value pattern hits. Remove the unrelated secret and the marker leaks.
 * Masking by coincidence looks identical to masking by rule until you take the
 * coincidence away.
 *
 * WHY IT IS NOT THE OVER-MASKING THE BEAD FEARED. That worry — "a rule broad
 * enough to catch this masks every message body, which is the transcript the
 * export exists to provide" — is about WHOLE-STRING masking. This masks the
 * VALUE SPAN and leaves the prose, including the key name, readable.
 *
 * Measured by running this function's output against the previous output over
 * 24 real session transcripts (4390 lines): **4 lines masked more, on 2 distinct
 * spans**, both inside a `Read` of Cebab's own `ws/server.ts` (`session_id:
 * sessionId`). Two identifiers in a source file — a false positive of exactly
 * the cheap kind the module header licenses. The generic alternative that was
 * rejected — any 32+ char mixed-case-and-digits token, i.e. entropy with no key
 * name — masks **1544 spans** on the same corpus (session ids, base64 blobs,
 * hashes). That is the cliff, and it is why this is keyed on the NAME and
 * nothing else.
 *
 * WHAT IT DELIBERATELY DOES NOT CATCH: a value with neither a credential-shaped
 * key nor a credential-shaped value. `plain_marker = <secret>` is
 * indistinguishable from prose, and reaching it means the 1544. Pinned as a
 * known limit in `redact.test.ts` rather than left to be rediscovered.
 */
/**
 * One candidate `name <sep> value` pair. The 8-character floor on the VALUE is
 * in the pattern AND re-checked after trailing punctuation is trimmed, since the
 * trim can take a match below it. Deliberately generic: the NAME is
 * judged by `isSensitiveKey`, the module's existing predicate, rather than by a
 * second vocabulary baked into this pattern. A name masked as a JSON key and a
 * name masked inside prose must be the same list, or the two drift and only one
 * of them is ever tested.
 *
 * Also why this is not one big alternation: `SENSITIVE_KEY_PATTERNS` carries an
 * anchor (`^cookie$`) and a lookahead (`auth(?:orization)?(?!or)`) that cannot
 * be spliced into a larger expression and keep their meaning. Extracting the
 * token and asking the real predicate keeps both exactly as they read.
 *
 * EVERY REPETITION IS BOUNDED, and the first draft's were not — CodeQL caught
 * what `security/detect-unsafe-regex` passed, and the two are not the same
 * question (the eslint rule checks star height, which was 1 either way).
 *
 * The draft had `[ \t]*["']?[ \t]*` between name and separator, then `[ \t]*`
 * again after it. Two failures, both quadratic on input a project controls:
 *
 *   - with no quote present, a run of N tabs splits across those two stars N+1
 *     ways, and every split is tried;
 *   - even ONE greedy `[ \t]*` followed by a disjoint `[:=]` re-tries every
 *     length on failure, at every start position — so `-\t\t\t…` is O(N²)
 *     with no ambiguity involved at all.
 *
 * `{0,8}` fixes both by construction rather than by argument: the work at any
 * start position is now a constant, so the scan is linear in the string. Eight
 * is far more whitespace than any real `name = value` carries, and a line that
 * exceeds it simply is not a candidate — the safe direction, since the value
 * still has to survive `isSensitiveKey` to be masked at all.
 *
 * NO LOOKBEHIND pinning the name to a maximal run, though it would also remove
 * the `-----` re-entry: it would make a run LONGER than 64 characters
 * unmatchable, where the current form matches the last 64 before the separator
 * — and `isSensitiveKey` is a substring test, so the tail is the half that
 * carries the word.
 */
const CREDENTIAL_ASSIGNMENT =
  /([A-Za-z0-9_.-]{1,64})["']?[ \t]{0,8}[:=][ \t]{0,8}["']?([A-Za-z0-9_.+=~-]{8,})/g;

/**
 * Values that are code, not credentials. Each was MEASURED as a false positive
 * over this repo's own sources, standing in for code quoted inside a transcript:
 *
 *   - a dotted identifier — `token = authTokenRef.current`
 *   - a language keyword  — `secret = undefined`
 *
 * The value character class in the pattern above does the rest of this work by
 * excluding code punctuation entirely (`(`, `<`, `&`, `/`, `|`), which is what
 * removed `crypto.randomBytes(32`, `Map<string`, `initAuthToken(` and
 * `…&format=redacted` from the candidate set. Narrowing by what a value CANNOT
 * contain rather than by what it must look like keeps a real hyphenated
 * passphrase in scope, which an entropy floor would not.
 */
const NON_CREDENTIAL_VALUES: ReadonlySet<string> = new Set([
  'undefined',
  'Infinity',
  'NaN',
  'function',
  'readonly',
  'continue',
]);

function isIdentifier(segment: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment);
}

/** `authTokenRef.current`, `process.env.FOO` — a reference to a value, not one. */
function isDottedCodeReference(value: string): boolean {
  if (!value.includes('.')) return false;
  // `split`/`every` rather than a nested-quantifier regex: `(?:\.[A-Za-z…]*)+`
  // is star height 2 and `security/detect-unsafe-regex` rejects that shape.
  return value.split('.').every(isIdentifier);
}

/**
 * Replace every credential-named assignment's VALUE in `str` with the redaction
 * token. Returns `str` unchanged when nothing matched.
 *
 * EXACTLY the matched spans, and an earlier version of this masked every other
 * occurrence of the same value too — on the theory that an assistant turn which
 * states a secret once as an assignment and then repeats it bare would otherwise
 * ship the second copy. Measured against the operator's own 24 session
 * transcripts, that theory cost more than it bought: a `Read` of `ws/server.ts`
 * matched once on `session_id: sessionId` and the repeat pass then replaced the
 * identifier `sessionId` on twenty unrelated lines of the file. One match
 * mangling a whole body is not the "false positives are cheap" this module's
 * header licenses, and the repeat case was hypothetical — no transcript in the
 * corpus contained one. Removed, with the measurement, rather than tuned.
 *
 * Idempotent by construction: `<redacted>` contains `<` and `>`, neither of
 * which the value class accepts, so this function's own output can never be a
 * candidate value on a second pass.
 */
export function maskCredentialAssignments(str: string): string {
  CREDENTIAL_ASSIGNMENT.lastIndex = 0;
  /** [start, end) of each value to mask, in ascending order. */
  let spans: Array<[number, number]> | undefined;
  let match: RegExpExecArray | null;
  while ((match = CREDENTIAL_ASSIGNMENT.exec(str)) !== null) {
    const [, name, matched] = match;
    // A REJECTED candidate must give the text back. `exec` leaves `lastIndex`
    // past the whole match, so `deploy-notes.txt: db_password = <secret>` was
    // consumed as the pair (`deploy-notes.txt`, `db_password`) — rejected on the
    // name, and the real assignment inside it never scanned. Rewinding to just
    // past the NAME re-enters the same text one candidate later. Strictly
    // increasing (`name` is at least one character), so it cannot loop.
    CREDENTIAL_ASSIGNMENT.lastIndex = match.index + name.length;
    if (!isSensitiveKey(name)) continue;
    // A sentence-final period is punctuation, not key material. Trailing dots
    // only — `=` stays, because it is base64 padding.
    let value = matched;
    while (value.endsWith('.')) value = value.slice(0, -1);
    if (value.length < 8) continue;
    if (NON_CREDENTIAL_VALUES.has(value)) continue;
    if (isDottedCodeReference(value)) continue;
    const start = match.index + match[0].length - matched.length;
    (spans ??= []).push([start, start + value.length]);
    // Accepted: skip past the value so it is not re-scanned as a name.
    CREDENTIAL_ASSIGNMENT.lastIndex = match.index + match[0].length;
  }
  if (!spans) return str;
  let out = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    out += str.slice(cursor, start) + REDACTED_TOKEN;
    cursor = end;
  }
  return out + str.slice(cursor);
}

/**
 * Body fields of a `tool_result` block (register of0).
 *
 * Deliberately narrower than SIBLING_VALUE_FIELDS: `tool_use_id`, `type` and
 * `is_error` stay visible because they answer "which call was this, and did it
 * fail" and carry no file body.
 */
const TOOL_RESULT_BODY_FIELDS: ReadonlySet<string> = new Set(['content', 'text']);

/**
 * Is this object an Anthropic `tool_result` content block?
 *
 * BOTH discriminators are required, so an unrelated blob that merely carries
 * `type: 'tool_result'` cannot trip the rule. A structural check rather than a
 * key-name guess: this block shape is API-stable, unlike the envelope around it
 * (which differs between the export, the WS projector and the search scanner).
 */
function isToolResultBlock(obj: Record<string, unknown>): boolean {
  return obj.type === 'tool_result' && 'tool_use_id' in obj;
}

/**
 * Register of0, the second half. Does ANY object in this payload declare a
 * sensitive file path?
 *
 * WHY THIS EXISTS. A `Read` of a sensitive file puts the body in the payload
 * TWICE:
 *
 *   payload.tool_use_result.file = { filePath, content, numLines, ... }
 *       -> path and content are SIBLINGS, so `collectSensitiveSiblings` reaches
 *          this copy the moment the path is on the list.
 *   payload.message.content[i]   = { tool_use_id, type: 'tool_result', content }
 *       -> the same body, with NO path field on that object, so the sibling
 *          rule structurally cannot reach it.
 *
 * Measured on the transcript that reported this: adding the path to the list
 * masked copy 1 and exported copy 2 verbatim — while `fields` truthfully named
 * the mask it had applied. A leak with a correct-looking attestation beside it.
 *
 * Correlating the assistant event's `tool_use.id` with this event's
 * `tool_use_id` is not available: this function is pure and sees one payload at
 * a time. But WITHIN this payload the path IS present, just in a sibling
 * subtree. This pass finds it there.
 *
 * Depth-bounded to MAX_DEPTH so it never sees more than `walk` does — a path
 * below the cut sits inside a subtree `walk` masks wholesale anyway. Short-
 * circuits on the first hit.
 */
function payloadDeclaresSensitivePath(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    for (const v of value) {
      if (payloadDeclaresSensitivePath(v, depth + 1)) return true;
    }
    return false;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (PATH_FIELD_NAMES.has(key) && typeof v === 'string' && pathLooksSensitive(v)) return true;
  }
  for (const v of Object.values(obj)) {
    if (payloadDeclaresSensitivePath(v, depth + 1)) return true;
  }
  return false;
}

/**
 * Per-call state for `walk`. A parameter, never a module global, so the function
 * stays pure and reentrant.
 *
 * The pre-pass answer is computed LAZILY and memoized: it is only needed once a
 * `tool_result` block is actually encountered, and the overwhelming majority of
 * payloads have none (every text-only turn, every stream event, every row the
 * export streams for a conversation without tool calls). Eager evaluation would
 * put a second full traversal on every line of every exported transcript to
 * answer a question most of them never ask.
 */
type WalkScope = { readonly root: unknown; cached: boolean | undefined };

function scopeHasSensitivePath(scope: WalkScope): boolean {
  if (scope.cached === undefined) {
    scope.cached = payloadDeclaresSensitivePath(scope.root, 0);
  }
  return scope.cached;
}

/**
 * Walk `payload` and return a deep-cloned copy with sensitive values masked.
 * Records the dot-paths that were masked in the returned `fields` array.
 *
 * Cycles are not supported (the SDK payloads we project are JSON, so they
 * are by definition acyclic — but we bound recursion at `MAX_DEPTH` to be
 * defensive against malformed inputs).
 */
export function redactSensitive(payload: unknown): RedactResult {
  const fields: string[] = [];
  const scope: WalkScope = { root: payload, cached: undefined };
  const redacted = walk(payload, '', 0, fields, scope);
  return { redacted, fields };
}

function walk(
  value: unknown,
  path: string,
  depth: number,
  fields: string[],
  scope: WalkScope,
): unknown {
  if (depth > MAX_DEPTH) {
    // Register D24: this used to `return value` — the CALLER'S OWN object,
    // by reference, unmasked, and unreported. Three promises broken at once:
    // the JSDoc above says "deep-cloned copy" (it aliased), nothing past
    // depth 12 was masked, and `fields` said so by omission.
    //
    // The file already knew. The D05 note below observes that "`walk` returns
    // values verbatim past MAX_DEPTH, so recursion under a sensitive key
    // would still leak anything nested deeper than that" — and fixed that ONE
    // branch by masking wholesale rather than recursing. This applies the
    // same trade everywhere, which makes the two consistent instead of the
    // general case being the exception.
    //
    // Cost: a payload nested deeper than MAX_DEPTH loses its tail. That is
    // the right direction for a redactor — the alternative is emitting bytes
    // nobody inspected while reporting that nothing was found.
    fields.push(path || ROOT_FIELD);
    return REDACTED_TOKEN;
  }
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (valueContainsSensitivePattern(value)) {
      // Register D25: this was `if (path) fields.push(path)`. A top-level
      // string has an empty path, so the value was masked and `fields` stayed
      // empty — and every caller gates on exactly that
      // (`if (fields.length > 0) row.redactedFields = fields`), so a payload
      // that was ENTIRELY a credential reported as "nothing redacted".
      //
      // Reachable, not theoretical: `repo/artifact_content.ts` passes a bare
      // string once per line of every artifact preview. It happens to survive
      // because it compares `redacted !== line` instead of trusting `fields`
      // — i.e. the one caller that reaches this path had to route around the
      // report to be correct.
      fields.push(path || ROOT_FIELD);
      return REDACTED_TOKEN;
    }
    // Cebab-ygu.51: only AFTER the wholesale check above, and the order is the
    // design. A vendor-shaped token is unambiguous evidence that the whole
    // string is credential-bearing, so it keeps masking wholesale; this rule
    // fires on the strings that carry a secret and nothing else to notice it by,
    // and masks the span so the transcript survives.
    const spanMasked = maskCredentialAssignments(value);
    if (spanMasked !== value) {
      fields.push(path || ROOT_FIELD);
      return spanMasked;
    }
    return value;
  }
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((v, i) => walk(v, `${path}[${i}]`, depth + 1, fields, scope));
  }

  // Object — first scan keys to decide what to mask wholesale.
  const obj = value as Record<string, unknown>;
  const sensitiveSiblings = collectSensitiveSiblings(obj);
  // Shape test FIRST so the payload-wide pre-pass stays lazy: a payload with no
  // tool_result block never pays for it.
  //
  // Scoped to RESULTS, never args. An assistant event carries no file body — only
  // the path, which this redactor deliberately keeps readable everywhere else —
  // so widening this to `tool_use` would be pure signal loss. Measured: an
  // assistant payload with two parallel tool_use blocks, one on a sensitive file
  // and one not, comes back byte-identical.
  //
  // Over-masking bound, stated honestly: the realistic worst case is one user
  // event carrying two tool_result blocks where only one is sensitive, in which
  // case the benign body is masked too. The transcript this was measured on had
  // exactly one tool_result block in each such payload (n=3 — a small sample,
  // said out loud rather than dressed up as a guarantee), and even in that case
  // filePath, tool_use_id, the tool name and `fields` all stay readable.
  const maskToolResultBody = isToolResultBlock(obj) && scopeHasSensitivePath(scope);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const childPath = path ? `${path}.${key}` : key;
    const raw = obj[key];

    if (isSensitiveKey(key)) {
      fields.push(childPath);
      // Register D05: mask the value WHOLESALE, whatever its type. This used
      // to mask only `string | number` and copy objects/arrays through
      // verbatim — so `{credentials: {password: 'hunter2'}}` returned the
      // password intact while the `fields.push` above attested that it had
      // been redacted. A leak plus a false attestation, on the path that
      // `session_log_export` runs over every exported transcript line.
      //
      // Wholesale rather than recursing, deliberately: `walk` returns values
      // verbatim past MAX_DEPTH, so recursion under a sensitive key would
      // still leak anything nested deeper than that — and would leak it while
      // continuing to report the field as masked, which is the exact failure
      // being fixed here. A single token is depth-independent, and matches
      // what the sibling-masking branch below already does.
      out[key] = REDACTED_TOKEN;
      continue;
    }

    if (maskToolResultBody && TOOL_RESULT_BODY_FIELDS.has(key)) {
      fields.push(childPath);
      // Wholesale, per the D05 precedent above: a tool_result `content` is a
      // string OR an array of blocks, and recursing would leak whatever sits
      // past MAX_DEPTH while still reporting the field as masked.
      out[key] = REDACTED_TOKEN;
      continue;
    }

    if (sensitiveSiblings.has(key)) {
      fields.push(childPath);
      out[key] = REDACTED_TOKEN;
      continue;
    }

    out[key] = walk(raw, childPath, depth + 1, fields, scope);
  }
  return out;
}

/**
 * If any value-of-type-string field on `obj` looks like a path field whose
 * value matches a sensitive-path pattern (e.g. `file_path: '.env'`), return
 * the set of sibling field names that should be masked on this object.
 */
function collectSensitiveSiblings(obj: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  let sensitive = false;
  for (const key of Object.keys(obj)) {
    if (!PATH_FIELD_NAMES.has(key)) continue;
    const v = obj[key];
    if (typeof v !== 'string') continue;
    if (pathLooksSensitive(v)) sensitive = true;
  }
  // Register Cebab-5j1. A Bash mutation names its file in the COMMAND string,
  // not in a `file_path` field — `mutationToLogRow` projects it as
  // `{toolName:'Bash', toolInput:{command}, toolResult}` with `filePath: null`,
  // so the path-field loop above finds nothing and `toolResult` (the command's
  // captured output, which may be the whole body of a `.env`) ships unmasked.
  // `bashCommandPathArguments` extracts the path-looking tokens; if any is
  // sensitive, the `toolInput`/`toolResult` siblings mask exactly as a
  // `Write('.env')` row's already do.
  if (!sensitive && bashCommandTouchesSensitivePath(obj)) sensitive = true;
  if (sensitive) {
    for (const sib of Object.keys(obj)) {
      if (SIBLING_VALUE_FIELDS.has(sib)) out.add(sib);
    }
  }
  return out;
}

/**
 * Register Cebab-5j1. Does this object represent a Bash tool call whose command
 * names a sensitive file? Keyed on the `mutationToLogRow` row shape (`toolName`
 * + `toolInput.command`) — the one place `toolInput` and `toolResult` sit as
 * siblings, so it is the one place the sibling rule can act on the answer. The
 * SDK `events` shape puts a Bash `tool_use` and its `tool_result` in SEPARATE
 * events, which this correlation cannot reach and which is a distinct problem.
 */
function bashCommandTouchesSensitivePath(obj: Record<string, unknown>): boolean {
  if (obj.toolName !== 'Bash') return false;
  const toolInput = obj.toolInput;
  if (toolInput === null || typeof toolInput !== 'object') return false;
  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command !== 'string') return false;
  return bashCommandPathArguments(command).some(pathLooksSensitive);
}
