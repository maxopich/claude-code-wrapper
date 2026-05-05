// Tracks all in-flight Query objects so shutdown can close them deterministically.
// Without this, the SDK's spawned `claude` subprocesses can outlive the server
// and silently consume subscription quota.
type Closable = { close?: () => void };

const inFlight = new Set<Closable>();

export function registerQuery(q: Closable): () => void {
  inFlight.add(q);
  return () => inFlight.delete(q);
}

export function closeAllQueries(): void {
  for (const q of inFlight) {
    try {
      q.close?.();
    } catch (err) {
      console.error("[lifecycle] close failed", err);
    }
  }
  inFlight.clear();
}

export function inFlightCount(): number {
  return inFlight.size;
}
