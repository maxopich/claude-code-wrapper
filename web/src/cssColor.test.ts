import { describe, expect, test } from 'vitest';
import stylesCss from './styles.css?raw';
import {
  composite,
  contrastRatio,
  parseColor,
  parseThemeBlocks,
  relativeLuminance,
  resolveColor,
  resolveVar,
  splitTopLevel,
} from './cssColor.js';

/**
 * The instrument has to be calibrated before anything is allowed to trust it.
 *
 * `styleContrast.test.ts` turns "the four gammas are readable" from a claim
 * into a build failure — but only if the arithmetic underneath is right. A
 * contrast function with a transposed coefficient or a mis-handled
 * `color-mix` would go green on a palette nobody can read, which is exactly
 * the class of defect this whole change is about. So this file pins the maths
 * to published reference values and to the two parsing behaviours that the
 * findings actually turn on.
 */

describe('relative luminance and contrast — published reference pairs', () => {
  const white = parseColor('#ffffff');
  const black = parseColor('#000000');

  test('black on white is 21:1, the defined maximum', () => {
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
  });

  test('a colour against itself is 1:1', () => {
    expect(contrastRatio(white, white)).toBeCloseTo(1, 10);
    expect(contrastRatio(black, black)).toBeCloseTo(1, 10);
  });

  test('the ratio is symmetric — order of arguments cannot change it', () => {
    const a = parseColor('#2f6fed');
    expect(contrastRatio(a, white)).toBeCloseTo(contrastRatio(white, a), 10);
  });

  // #767676 is the canonical "smallest grey that passes AA on white" and
  // #777777 the canonical near-miss, quoted at 4.54 and 4.48 across the
  // accessibility literature. If a coefficient or the sRGB linearisation
  // were wrong these two would not land on opposite sides of 4.5.
  test('#767676 on white passes AA at 4.54; #777777 fails at 4.48', () => {
    expect(contrastRatio(parseColor('#767676'), white)).toBeCloseTo(4.54, 2);
    expect(contrastRatio(parseColor('#777777'), white)).toBeCloseTo(4.48, 2);
  });

  test('white has luminance 1 and black 0', () => {
    expect(relativeLuminance(white)).toBeCloseTo(1, 10);
    expect(relativeLuminance(black)).toBeCloseTo(0, 10);
  });

  test('the low-channel linear branch is used below the 0.03928 knee', () => {
    // #050505 is under the knee, where luminance is c/12.92 rather than the
    // power curve. Getting the branch wrong is invisible except in near-black
    // surfaces — which is exactly what phosphor's --panel (#070c10) is.
    expect(relativeLuminance(parseColor('#050505'))).toBeCloseTo(5 / 255 / 12.92, 10);
  });
});

describe('colour parsing', () => {
  test('hex in three, four, six and eight digits', () => {
    expect(parseColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('#2f6fed')).toEqual({ r: 47, g: 111, b: 237, a: 1 });
    expect(parseColor('#00000080').a).toBeCloseTo(128 / 255, 10);
    expect(parseColor('#f00f').a).toBe(1);
  });

  test('rgb() and rgba() in comma and space form', () => {
    expect(parseColor('rgb(20, 24, 50)')).toEqual({ r: 20, g: 24, b: 50, a: 1 });
    expect(parseColor('rgba(255, 255, 255, 0.1)')).toEqual({ r: 255, g: 255, b: 255, a: 0.1 });
    expect(parseColor('rgb(20 24 50 / 0.5)')).toEqual({ r: 20, g: 24, b: 50, a: 0.5 });
  });

  test('transparent is black at zero alpha', () => {
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  test('an unsupported value throws rather than returning a default', () => {
    // A silent fallback would let the gate skip a pair and still report
    // success — the failure mode the gate exists to prevent.
    expect(() => parseColor('hsl(200 50% 50%)')).toThrow(/unsupported colour value/);
    expect(() => parseColor('color-mix(in oklab, #fff 50%, #000)')).toThrow(/unsupported/);
  });
});

describe('color-mix — premultiplied, which is the whole point', () => {
  test('mixing a hue with transparent yields that hue at reduced alpha', () => {
    // This is the behaviour register U07 turns on. `--err-soft` is
    // `color-mix(in srgb, var(--err) 12%, transparent)`. A naive lerp would
    // give 0.12 × err — a near-black — and the gate would then "prove" the
    // MOCK badge's second stripe was dark enough for white text. The spec
    // premultiplies, so the real result is a PALE tint of err.
    const mixed = parseColor('color-mix(in srgb, #ff0000 12%, transparent)');
    expect(mixed.r).toBeCloseTo(255, 6);
    expect(mixed.g).toBeCloseTo(0, 6);
    expect(mixed.b).toBeCloseTo(0, 6);
    expect(mixed.a).toBeCloseTo(0.12, 10);

    // …and composited onto a light panel it is very nearly the panel.
    const over = composite(mixed, parseColor('#ffffff'));
    expect(over.r).toBeCloseTo(255, 6);
    expect(over.g).toBeCloseTo(224.4, 4);
    expect(contrastRatio(parseColor('#ffffff'), over)).toBeLessThan(1.6);
  });

  test('mixing two opaque colours interpolates them', () => {
    const half = parseColor('color-mix(in srgb, #ffffff 50%, #000000)');
    expect(half.r).toBeCloseTo(127.5, 6);
    expect(half.a).toBe(1);
  });

  test('an omitted percentage is 100 minus the other; both omitted is 50/50', () => {
    expect(parseColor('color-mix(in srgb, #ffffff 25%, #000000)').r).toBeCloseTo(63.75, 6);
    expect(parseColor('color-mix(in srgb, #ffffff, #000000 25%)').r).toBeCloseTo(191.25, 6);
    expect(parseColor('color-mix(in srgb, #ffffff, #000000)').r).toBeCloseTo(127.5, 6);
  });

  test('percentages are normalised when they do not sum to 100', () => {
    // Per spec the weights are scaled; 30/10 behaves as 75/25.
    expect(parseColor('color-mix(in srgb, #ffffff 30%, #000000 10%)').r).toBeCloseTo(191.25, 6);
  });
});

describe('compositing', () => {
  test('an opaque foreground passes through untouched', () => {
    const fg = parseColor('#2f6fed');
    expect(composite(fg, parseColor('#ffffff'))).toEqual(fg);
  });

  test('a half-alpha white over black is mid grey', () => {
    const over = composite({ r: 255, g: 255, b: 255, a: 0.5 }, parseColor('#000000'));
    expect(over).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
  });

  test('a translucent backdrop is refused rather than guessed at', () => {
    expect(() => composite(parseColor('#fff'), { r: 0, g: 0, b: 0, a: 0.5 })).toThrow(
      /backdrop must be opaque/,
    );
  });
});

describe('splitTopLevel', () => {
  test('commas inside parentheses do not split', () => {
    expect(splitTopLevel('in srgb, rgba(1, 2, 3, 0.5) 40%, #000')).toEqual([
      'in srgb',
      'rgba(1, 2, 3, 0.5) 40%',
      '#000',
    ]);
  });
});

describe('var() resolution', () => {
  const tokens = new Map([
    ['--a', '#112233'],
    ['--b', 'var(--a)'],
    ['--c', 'color-mix(in srgb, var(--b) 40%, transparent)'],
  ]);

  test('a chain resolves through to the literal', () => {
    expect(resolveVar(tokens, 'var(--b)')).toBe('#112233');
    expect(resolveColor(tokens, '--c').a).toBeCloseTo(0.4, 10);
  });

  test('a fallback is used when the token is undeclared', () => {
    expect(resolveVar(tokens, 'var(--missing, #abcdef)')).toBe('#abcdef');
    // …and a declared token wins over its own fallback.
    expect(resolveVar(tokens, 'var(--a, #abcdef)')).toBe('#112233');
  });

  test('a nested var() inside a fallback still resolves', () => {
    expect(resolveVar(tokens, 'var(--missing, var(--a))')).toBe('#112233');
  });

  test('an undeclared token with no fallback throws', () => {
    expect(() => resolveVar(tokens, 'var(--nope)')).toThrow(/unresolvable/);
  });
});

describe('parseThemeBlocks against the real stylesheet', () => {
  const blocks = parseThemeBlocks(stylesCss);

  test('all four gammas are found with their values, not just their names', () => {
    expect(Object.keys(blocks).sort()).toEqual(['aurora', 'daylight', 'phosphor', 'slate']);
    // A spot value per theme, so a parser that returned empty maps — and so
    // vacuously passed every contrast assertion — is caught here.
    expect(blocks.aurora!.get('--fg-0')).toBe('#191b24');
    expect(blocks.daylight!.get('--panel')).toBe('#fbfaf5');
    expect(blocks.slate!.get('--on-accent')).toBe('#05181b');
    expect(blocks.phosphor!.get('--err-soft')).toBe(
      'color-mix(in srgb, var(--err) 12%, transparent)',
    );
  });

  test('every gamma declares a usable value for each token the gate reads', () => {
    for (const [theme, tokens] of Object.entries(blocks)) {
      for (const token of [
        '--fg-0',
        '--fg-1',
        '--fg-2',
        '--fg-3',
        '--bg',
        '--panel',
        '--panel-2',
        '--raised',
        '--accent',
        '--on-accent',
        '--err',
      ]) {
        expect(() => resolveColor(tokens, token), `${theme} ${token}`).not.toThrow();
      }
    }
  });
});
