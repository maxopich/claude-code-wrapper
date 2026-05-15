import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SAFE_URL_SCHEMES = /^(?:https?|mailto|tel|#|\/)/i;
const UNSAFE_URL_SCHEMES = /^(?:javascript|data|vbscript|file):/i;

/**
 * Block dangerous schemes that an agent could be tricked into emitting.
 * Returning empty string causes react-markdown to render the link as plain text.
 */
function safeUrl(url: string): string {
  if (!url) return '';
  const trimmed = url.trim();
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
