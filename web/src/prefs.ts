// Shared localStorage preference helpers. First lived inline in App.tsx
// (sidebar width / collapse); lifted here so other modules — e.g. the
// in-session AuthorityPanel collapse state — reuse the same guarded read/write
// instead of duplicating the try/catch. Deliberately thin: each preference
// owns its own key + parse, no central registry. Reads/writes are swallowed on
// failure (private mode, full quota) since these are all non-critical prefs.
export function readStored<T>(key: string, fallback: T, parse: (raw: string) => T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : parse(raw);
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* non-critical preference — ignore */
  }
}
