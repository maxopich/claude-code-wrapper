import type { MutationCategory } from '@cebab/shared';

/**
 * The bus pause gate fires ONLY on `dangerous`-category mutations. The
 * operator opts into pausing on *dangerous commands* (rm, sudo, force-push,
 * `curl | sh`, writes to system/secret paths, infra/cluster/DB destructive
 * ops, …) — NOT on every mutation. MCP tool calls and ordinary edits classify
 * as `mutate` and run free; their safety relies on the MCP server's own
 * permissions and the hash-chained audit log.
 *
 * Shared by orchestrator.ts and chain.ts so the two routers' gate decisions
 * cannot drift. Pure function — unit-tested in `pause_gate.test.ts`.
 *
 * The caller reads the session row fresh from the DB on every mutation
 * (handles the operator flipping `mutations_acknowledged` mid-turn via
 * Continue, and R-B reconstructed sessions where the in-memory closure has no
 * value to read), then passes the three gate-relevant fields here.
 */
export function shouldPauseForMutation(
  category: MutationCategory,
  session:
    | {
        pause_on_dangerous: number;
        mutations_acknowledged: number;
        pending_mutation_id: number | null;
      }
    | undefined,
): boolean {
  return (
    category === 'dangerous' &&
    session?.pause_on_dangerous === 1 &&
    session.mutations_acknowledged === 0 &&
    session.pending_mutation_id === null
  );
}
