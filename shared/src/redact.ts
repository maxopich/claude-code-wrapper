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
 *   - String values that look like an obvious credential header
 *     (`Bearer <jwt>`, `Authorization: ...`, `sk-...`, AWS access-key
 *     prefixes `AKIA[A-Z0-9]{16}`). Masked in place.
 *
 * Pure: no I/O, no globals. Same input → same output (modulo `JSON.stringify`
 * key order, which we don't depend on). Browser-safe.
 */

export type RedactResult = {
  /** Deep-cloned payload with sensitive values replaced by '<redacted>'. */
  redacted: unknown;
  /** Dot-paths that were masked. Empty when nothing matched. */
  fields: string[];
};

const REDACTED_TOKEN = '<redacted>';
const MAX_DEPTH = 12;

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
];

/** Special compound paths — exact match against the tail of the path. */
const SENSITIVE_TAILS: readonly string[] = ['/.git/config'];

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
]);

/** Inline value patterns — masked wherever they appear (heuristic, not
 *  comprehensive; here to catch the obvious leaks). */
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
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key));
}

function pathLooksSensitive(value: string): boolean {
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
  for (const stem of SENSITIVE_BASENAME_STEMS) {
    if (basename === stem) return true;
    if (basename.startsWith(`${stem}.`)) return true;
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
  const redacted = walk(payload, '', 0, fields);
  return { redacted, fields };
}

function walk(value: unknown, path: string, depth: number, fields: string[]): unknown {
  if (depth > MAX_DEPTH) return value;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (valueContainsSensitivePattern(value)) {
      if (path) fields.push(path);
      return REDACTED_TOKEN;
    }
    return value;
  }
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((v, i) => walk(v, `${path}[${i}]`, depth + 1, fields));
  }

  // Object — first scan keys to decide what to mask wholesale.
  const obj = value as Record<string, unknown>;
  const sensitiveSiblings = collectSensitiveSiblings(obj);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const childPath = path ? `${path}.${key}` : key;
    const raw = obj[key];

    if (isSensitiveKey(key)) {
      fields.push(childPath);
      out[key] = typeof raw === 'string' || typeof raw === 'number' ? REDACTED_TOKEN : raw;
      continue;
    }

    if (sensitiveSiblings.has(key)) {
      fields.push(childPath);
      out[key] = REDACTED_TOKEN;
      continue;
    }

    out[key] = walk(raw, childPath, depth + 1, fields);
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
  for (const key of Object.keys(obj)) {
    if (!PATH_FIELD_NAMES.has(key)) continue;
    const v = obj[key];
    if (typeof v !== 'string') continue;
    if (!pathLooksSensitive(v)) continue;
    for (const sib of Object.keys(obj)) {
      if (SIBLING_VALUE_FIELDS.has(sib)) out.add(sib);
    }
  }
  return out;
}
