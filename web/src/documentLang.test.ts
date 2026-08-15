import { describe, expect, test } from 'vitest';
// The shell Vite serves. `?raw` reads it as text — there is no DOM here to
// inspect, and the point is what ships in the file.
import indexHtml from '../index.html?raw';

/**
 * Register U35: `<html>` shipped with no `lang`.
 *
 * A screen reader picks its voice and pronunciation rules from the document
 * language. With none declared it falls back to the operator's system default,
 * so an English UI read by a reader configured for another language comes out
 * as that language's phonemes applied to English words — technically audible,
 * practically unusable. It is one attribute, and nothing in the client set it
 * at runtime either.
 *
 * Gated here rather than in a component test because `index.html` is outside
 * `web/src` and no React test would ever load it.
 */
describe('[a11y] the document declares its language (U35)', () => {
  const html = /<html([^>]*)>/i.exec(indexHtml)?.[1] ?? null;

  test('the scan found the html element', () => {
    // Anti-vacuity: a null match would make the assertions below pass on
    // `undefined`, which is the shape of the bug they are guarding.
    expect(html).not.toBeNull();
    expect(indexHtml).toContain('<div id="root">');
  });

  test('html carries a lang attribute', () => {
    expect(html).toMatch(/\slang="[^"]+"/);
  });

  test('the value is a plausible language subtag, not a placeholder', () => {
    // `lang=""` satisfies "has the attribute" while telling a reader nothing.
    // Checked subtag by subtag rather than with one BCP-47 pattern: every
    // shape of that pattern trips `security/detect-unsafe-regex`, and split +
    // two trivial predicates says the same thing without the argument.
    const value = /\slang="([^"]*)"/.exec(html ?? '')?.[1] ?? '';
    const [primary, ...subtags] = value.split('-');
    expect({
      primary: /^[a-z]{2,3}$/.test(primary ?? ''),
      subtags: subtags.every((s) => /^[A-Za-z0-9]{2,8}$/.test(s)),
    }).toEqual({ primary: true, subtags: true });
  });
});
