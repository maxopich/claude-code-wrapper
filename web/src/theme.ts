// Redesign theme gammas (mockup→prod migration, Phase 1).
//
// Theme is a pure CLIENT display preference — a color gamma over one layout.
// It is NOT server state: it never touches the WS `SettingsView` or shared/
// types. Selection is projected onto `document.documentElement[data-theme]`
// (above React's tree, so portaled modals inherit it) and persisted to
// localStorage. The CSS contract lives in styles.css's four `[data-theme]`
// blocks; styleTokens.test.ts guards their parity.
import { readStored, writeStored } from './prefs';

export const THEMES = ['aurora', 'daylight', 'slate', 'phosphor'] as const;
export type Theme = (typeof THEMES)[number];

/** Default first-run gamma (user decision, 2026-07-07): warm light, serif
 *  reading bodies. Also the fallback when localStorage is empty/corrupt. */
export const DEFAULT_THEME: Theme = 'daylight';

const STORAGE_KEY = 'cebab.theme';

export function isTheme(x: unknown): x is Theme {
  return typeof x === 'string' && (THEMES as readonly string[]).includes(x);
}

/** Read the persisted gamma, falling back to the default on absent/invalid. */
export function readStoredTheme(): Theme {
  return readStored<Theme>(STORAGE_KEY, DEFAULT_THEME, (raw) =>
    isTheme(raw) ? raw : DEFAULT_THEME,
  );
}

/** Project a gamma onto the document root and persist it. Idempotent — safe
 *  to call on every render/effect. The inline boot script in index.html sets
 *  the attribute before first paint (no FOUC); this keeps it in sync on
 *  runtime switches. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  writeStored(STORAGE_KEY, theme);
}

/** Presentation metadata for the Settings → Appearance picker. `swatch`
 *  mirrors each gamma's page/panel/accent so the card previews the palette
 *  without a live render. Kept in sync with styles.css `[data-theme]` values. */
export const THEME_META: Array<{
  id: Theme;
  label: string;
  description: string;
  swatch: { bg: string; panel: string; accent: string };
}> = [
  {
    id: 'daylight',
    label: 'Daylight',
    description: 'Warm light, serif reading bodies, coral accent.',
    swatch: { bg: '#f3f1ea', panel: '#fbfaf5', accent: '#bf5e3a' },
  },
  {
    id: 'aurora',
    label: 'Aurora',
    description: 'Airy light canvas, azure accent.',
    swatch: { bg: '#eef1f6', panel: '#ffffff', accent: '#2f6fed' },
  },
  {
    id: 'slate',
    label: 'Slate',
    description: "Refined dark, teal accent — today's look, polished.",
    swatch: { bg: '#0c0d10', panel: '#1a1d24', accent: '#2fb6c4' },
  },
  {
    id: 'phosphor',
    label: 'Phosphor',
    description: 'Terminal dark, monospace UI, green accent.',
    swatch: { bg: '#04070a', panel: '#0c151a', accent: '#3ddc84' },
  },
];
