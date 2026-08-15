import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SAFE_URL_SCHEMES = /^(?:https?|mailto|tel|#|\/)/i;
const UNSAFE_URL_SCHEMES = /^(?:javascript|data|vbscript|file):/i;

/**
 * Register W03: strip C0/C1 control characters, which `String.prototype.trim()`
 * does NOT remove — it strips whitespace and line terminators only.
 *
 * That gap made this transform WEAKER than the react-markdown built-in
 * (`defaultUrlTransform`) it replaced. A scheme like `java<U+0001>script:alert(1)`
 * missed UNSAFE_URL_SCHEMES (not literally "javascript:"), missed
 * SAFE_URL_SCHEMES, and missed the `^[a-zA-Z][\w+.-]*:` catch-all too — the
 * control char is not in `[\w+.-]`, so the required `:` is never reached — and
 * the string fell through to be returned VERBATIM. The default returns '' for
 * the same input.
 *
 * Stripping before the scheme tests means the checks see the string a browser
 * would act on rather than the obfuscated one. React DOM's own sanitiser also
 * blocks the `javascript:` variant, so this was lost defence in depth rather
 * than a live hole — but a sanitiser beaten by one byte is not one to keep.
 *
 * Done as a code-point scan rather than a regex literal on purpose: a
 * `/[\x00-\x1F\x7F]/` class puts the raw bytes in the source, where they are
 * invisible in a diff and make the file unsearchable (grep treats NUL as
 * binary). Numeric comparisons keep the file plain ASCII.
 */
function stripControlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    // C0 (0x00-0x1F) and DEL (0x7F).
    if (code <= 0x1f || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

/**
 * Block dangerous schemes that an agent could be tricked into emitting.
 * Returning empty string causes react-markdown to render the link as plain text.
 *
 * Exported for direct unit testing — the same extract-the-decision-and-test-it
 * pattern as `describeTurnInFlight` / `isDirectInvocation` elsewhere in the repo.
 */
export function safeUrl(url: string): string {
  if (!url) return '';
  const trimmed = stripControlChars(url).trim();
  // A URL that was ONLY control characters collapses to empty here; return ''
  // rather than falling through to the "bare relative path" allowance below.
  if (!trimmed) return '';
  if (UNSAFE_URL_SCHEMES.test(trimmed)) return '';
  if (SAFE_URL_SCHEMES.test(trimmed)) return trimmed;
  // Bare relative paths or fragments are fine; reject anything else.
  if (/^[a-zA-Z][\w+.-]*:/.test(trimmed)) return '';
  return trimmed;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
