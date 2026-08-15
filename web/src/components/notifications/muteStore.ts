import type { NotificationEnvelope, NotificationSeverity } from '@cebab/shared/protocol';

/**
 * Cluster A Phase 5: localStorage-backed mute store for the dock.
 *
 * "Per-type, scoped (session / global 1h / global until unmute). Disallowed
 * on error and danger." (spec §3 + UX §5)
 *
 * v1 stores mutes per-device (`localStorage`) per OQ-5 — single-user-local
 * Cebab doesn't have a server-side account to attach to. Cross-tab is
 * implicit: localStorage broadcasts via the `storage` event when another
 * tab writes, but Phase 5 doesn't subscribe to it (the existing mute set
 * is read at notify time, so a fresh-tab consult always sees up-to-date
 * mutes; the active-tab toast suppression only matters once per push).
 *
 * The mute KEY is the `dedupeKey`'s prefix up to the first `:`. Current
 * dispatcher dedupeKey conventions: `<source>:<scope>` (e.g.
 * `session_superseded:<sid>`, `bus_auto_installed:<projectId>`,
 * `chain_not_reconstructed:<sid>`, `wrap:global`). Muting the prefix
 * suppresses every variant — operators who care about a specific session
 * can dismiss-not-mute. This trades precision for affordance simplicity:
 * one button on the toast, no scope picker. Phase 5.1 can add "mute this
 * session only" if operator feedback wants finer control.
 *
 * Persistence shape:
 *   { [prefix: string]: { until: number | 'forever'; ts: number } }
 *
 * `until` is wall-clock ms (a future timestamp) OR the string `'forever'`
 * for the "global until unmute" variant. `ts` is when the mute was
 * created (for the manage-mutes UI to render "muted 2h ago").
 *
 * Mutes are display-side ONLY: the server still persists every
 * notification row + writes audit rows for safety class regardless of
 * client mute state. The inbox panel ALWAYS shows muted rows so a
 * forgotten-mute doesn't hide history.
 */

const STORAGE_KEY = 'cebab.notif.mutes';

/**
 * Severities that can never be muted. UX-7 / spec §3: error and danger
 * stay visible because they represent unresolved state the operator
 * MUST attend to. The mute UI should hide the affordance entirely for
 * these tiers; this function is the source of truth.
 */
const MUTE_DISALLOWED_SEVERITIES: ReadonlySet<NotificationSeverity> = new Set(['error', 'danger']);

export type MuteEntry = {
  /** Wall-clock ms when the mute expires, or 'forever'. */
  until: number | 'forever';
  /** Wall-clock ms when the mute was created. */
  ts: number;
};

export type MuteMap = Record<string, MuteEntry>;

/**
 * Register W24: `'session'` is gone.
 *
 * It encoded a tab-lifetime mute as `until: Date.now()`, and `isMuted`
 * requires `Date.now() < entry.until` — false the instant it was written. It
 * never suppressed a single notification; worse, the first notification after
 * it hit the lazy-expire branch and DELETED the entry, so the manage-mutes
 * panel could not show the operator what they had chosen either. The doc
 * comment called it "best-effort"; it was zero-effort.
 *
 * Deleted rather than implemented. `addMute` has exactly one caller
 * (`NotificationStack`, with `'hour'`) and the toast offers exactly one
 * affordance ("Mute this notification type for 1 hour"), so the in-memory
 * session set the register offers as the alternative would be shipping a
 * feature no UI exposes. Removing the member makes reintroducing it without
 * an implementation a `tsc` error.
 */
export type MuteScope = 'hour' | 'forever';

/**
 * Resolve a notification envelope to its mute key. Mute keys are the
 * `dedupeKey` prefix up to (but not including) the first `:`. Envelopes
 * without a `:` use the whole dedupeKey as the prefix.
 *
 * Exported so the manage-mutes panel can show currently-muted keys
 * alongside the toast prefix the operator would see.
 */
export function muteKeyFor(env: Pick<NotificationEnvelope, 'dedupeKey'>): string {
  const idx = env.dedupeKey.indexOf(':');
  return idx === -1 ? env.dedupeKey : env.dedupeKey.slice(0, idx);
}

/**
 * Whether an envelope is mute-eligible (severity not in the disallowed
 * set). Used by the toast to hide/show the Mute button and by `addMute`
 * to refuse error/danger mutes at write time.
 */
export function isMuteAllowed(severity: NotificationSeverity): boolean {
  return !MUTE_DISALLOWED_SEVERITIES.has(severity);
}

/**
 * Read the entire mute map from localStorage. Returns `{}` when storage
 * is unavailable (private browsing, JSDOM without storage shim) so call
 * sites can treat a missing store as "no mutes" without try/catch.
 */
export function readMutes(): MuteMap {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as MuteMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeMutes(map: MuteMap): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota exceeded / disabled storage — silently degrade */
  }
}

/**
 * Whether the envelope is currently muted. Reads the mute map fresh on
 * every call (no subscription) — call sites are notify-time, not render-
 * time, so the per-push read is negligible. Expired mutes are detected
 * here and removed lazily (no GC daemon needed for v1).
 */
export function isMuted(env: Pick<NotificationEnvelope, 'dedupeKey' | 'severity'>): boolean {
  if (!isMuteAllowed(env.severity)) return false;
  const map = readMutes();
  const key = muteKeyFor(env);
  const entry = map[key];
  if (!entry) return false;
  if (entry.until === 'forever') return true;
  if (Date.now() < entry.until) return true;
  // Lazy-expire: a stale entry is dropped so the manage-mutes panel
  // doesn't show it indefinitely.
  removeMute(key);
  return false;
}

/**
 * Add a mute for a specific prefix. `scope` determines `until`:
 *   - 'hour': 1 hour from now.
 *   - 'forever': until manually unmuted.
 *
 * Every scope this accepts produces an `until` that `isMuted` can actually
 * satisfy — see the note on `MuteScope` for the one that could not and was
 * removed.
 *
 * Returns the entry written, or `null` if the operation was refused
 * (the panel never reaches here for error/danger, but defense in depth).
 */
export function addMute(
  env: Pick<NotificationEnvelope, 'dedupeKey' | 'severity'>,
  scope: MuteScope,
): MuteEntry | null {
  if (!isMuteAllowed(env.severity)) return null;
  const map = readMutes();
  const key = muteKeyFor(env);
  const now = Date.now();
  const HOUR_MS = 60 * 60 * 1000;
  const until: number | 'forever' = scope === 'forever' ? 'forever' : now + HOUR_MS;
  const entry: MuteEntry = { until, ts: now };
  map[key] = entry;
  writeMutes(map);
  return entry;
}

/**
 * Remove a single mute. The manage-mutes panel calls this; lazy-expire
 * inside `isMuted` also calls this for stale entries.
 */
export function removeMute(key: string): void {
  const map = readMutes();
  if (!(key in map)) return;
  delete map[key];
  writeMutes(map);
}

/**
 * Test-only / reset-on-logout: clear every mute. Phase 5 doesn't expose
 * a "clear all mutes" affordance (per-row removal is enough), but the
 * helper exists for tests and a future settings panel.
 */
export function _clearAllMutes(): void {
  writeMutes({});
}
