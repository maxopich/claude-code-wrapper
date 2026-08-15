// @vitest-environment jsdom
/**
 * [security] Register W03 — the markdown URL sanitiser.
 *
 * `safeUrl` replaces react-markdown's built-in `defaultUrlTransform`, so it has
 * to be at least as strict as the thing it displaced. It wasn't:
 * `String.prototype.trim()` removes whitespace and line terminators but NOT
 * control characters, so a scheme with one embedded control byte slipped past
 * all three checks and was returned verbatim, where the built-in returns ''.
 *
 * Control characters are written as `\x01`-style escapes throughout — never
 * pasted literally — so this file stays plain ASCII and greppable.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { Markdown, safeUrl } from './Markdown';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

/** Mount <Markdown> and hand back the rendered anchor, if any. */
function renderMarkdown(text: string): HTMLAnchorElement | null {
  act(() => {
    root.render(<Markdown text={text} />);
  });
  return container.querySelector('a');
}

const SOH = '\x01'; // C0 start-of-heading
const NUL = '\x00';
const DEL = '\x7F';
const VT = '\x0B'; // vertical tab — whitespace to trim(), still a control char

describe('[security] safeUrl — control-character smuggling', () => {
  test('a control character inside the scheme no longer slips through', () => {
    // The finding, exactly. Before the fix this returned the input unchanged.
    expect(safeUrl(`java${SOH}script:alert(1)`)).toBe('');
  });

  test.each([
    ['NUL', `java${NUL}script:alert(1)`],
    ['DEL', `java${DEL}script:alert(1)`],
    ['VT', `java${VT}script:alert(1)`],
    ['leading', `${SOH}javascript:alert(1)`],
    ['multiple', `j${SOH}av${NUL}ascr${DEL}ipt:alert(1)`],
    ['trailing in scheme', `javascript${SOH}:alert(1)`],
  ])('blocks the %s variant', (_label, url) => {
    expect(safeUrl(url)).toBe('');
  });

  test('the same trick on the other unsafe schemes is blocked too', () => {
    expect(safeUrl(`da${SOH}ta:text/html,<script>`)).toBe('');
    expect(safeUrl(`vb${SOH}script:msgbox`)).toBe('');
    expect(safeUrl(`fi${SOH}le:///etc/passwd`)).toBe('');
  });

  test('a url that is nothing but control characters returns empty', () => {
    // Must not fall through to the "bare relative path" allowance at the end.
    expect(safeUrl(`${SOH}${NUL}${DEL}`)).toBe('');
  });
});

describe('[security] safeUrl — the plain cases still behave', () => {
  test('unobfuscated dangerous schemes stay blocked', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('JavaScript:alert(1)')).toBe('');
    expect(safeUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe('');
    expect(safeUrl('vbscript:msgbox')).toBe('');
    expect(safeUrl('file:///etc/passwd')).toBe('');
  });

  test('safe schemes and relative targets still pass', () => {
    expect(safeUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(safeUrl('http://example.com')).toBe('http://example.com');
    expect(safeUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com');
    expect(safeUrl('tel:+123456789')).toBe('tel:+123456789');
    expect(safeUrl('#section')).toBe('#section');
    expect(safeUrl('/relative/path')).toBe('/relative/path');
    expect(safeUrl('relative/path.md')).toBe('relative/path.md');
  });

  test('an unknown scheme is still rejected', () => {
    expect(safeUrl('ftp://example.com')).toBe('');
    expect(safeUrl('customproto:whatever')).toBe('');
  });

  test('empty and whitespace-only input returns empty', () => {
    expect(safeUrl('')).toBe('');
    expect(safeUrl('   ')).toBe('');
  });

  test('stripping does not corrupt an otherwise-safe URL', () => {
    // Regression guard on the fix itself: a control char in the PATH should be
    // removed, not cause the whole (safe) URL to be dropped.
    expect(safeUrl(`https://example.com/a${SOH}b`)).toBe('https://example.com/ab');
  });

  test('surrounding whitespace is still trimmed', () => {
    expect(safeUrl('  https://example.com  ')).toBe('https://example.com');
  });
});

describe('[security] safeUrl is actually wired into the renderer', () => {
  // Without a wiring check, a refactor could leave `safeUrl` exported, tested
  // and UNUSED — every case above would still pass while links fell back to
  // react-markdown's own transform.
  //
  // Picking the probe took a measurement. The obvious candidate — a smuggled
  // `java\x01script:` link — is USELESS here: remark never parses a URL
  // containing a control character as a link at all, so no anchor is emitted
  // and an "href is empty" assertion passes whether or not `safeUrl` is wired.
  // (Worth knowing in its own right: the parser is a second, independent
  // barrier in front of that particular trick.)
  //
  // `tel:` is the discriminator. `safeUrl` allows it via SAFE_URL_SCHEMES;
  // react-markdown's `defaultUrlTransform` does NOT (its safe list is
  // http/https/irc/ircs/mailto/xmpp), so it blanks the href. Verified both
  // ways: with the transform removed this href becomes ''.
  test('a tel: link keeps its href — only OUR transform allows that', () => {
    expect(renderMarkdown('[call](tel:+123456789)')?.getAttribute('href')).toBe('tel:+123456789');
  });

  test('an ordinary link keeps its href', () => {
    expect(renderMarkdown('[click](https://example.com)')?.getAttribute('href')).toBe(
      'https://example.com',
    );
  });

  test('a plain javascript: link is stripped in the DOM', () => {
    // Not a wiring probe (the default blocks this too) — it pins the
    // end-to-end outcome operators actually care about.
    const anchor = renderMarkdown('[click](javascript:alert(1))');
    expect(anchor?.getAttribute('href') ?? '').toBe('');
  });
});
