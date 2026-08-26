/**
 * Autonomous loop — the single-run lock.
 *
 * WHY THIS EXISTS. The spec says "serial, one bead at a time" and nothing
 * enforced one PROCESS. Measured on the first successful dry-run: two loop
 * runs went at the same checkout concurrently, were handed the SAME bead by
 * SELECT, and had two agents editing ONE working tree while the other's gate
 * ran against it. Both gates passed, which was luck rather than safety — and
 * the two runs also shared the ledger, `state.json`, and HEAD.
 *
 * A LIVE PID IS THE SIGNAL, NOT THE FILE. `kill -9`, a closed lid, or a crash
 * all leave a lock behind, and a tool that then refuses to start until someone
 * deletes a file by hand is worse than the race it prevents — the operator
 * hits it at 3am with no idea what to remove. So the holder's liveness is
 * probed, and a lock whose owner is gone is taken over and reported.
 *
 * `process.kill(pid, 0)` sends no signal; it only asks whether the pid can be
 * signalled. EPERM means the process exists under another user — alive, so the
 * lock stands. Only ESRCH means gone.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LOCK_BASENAME = 'run.lock';

export class LockHeldError extends Error {
  constructor(holder) {
    super(
      `another loop run is already active in this checkout (pid ${holder.pid}, started ${holder.startedAt}). ` +
        `Only one run may hold a working tree: two runs get handed the same bead and edit the same files. ` +
        `Stop it with \`npm run loop:stop\`, or wait for it to finish.`,
    );
    this.name = 'LockHeldError';
    this.holder = holder;
  }
}

/** Is a pid live? Absence is the only thing that frees a lock. */
export function pidIsAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: exists, owned by someone else. Alive for our purposes.
    return error?.code === 'EPERM';
  }
}

/**
 * Decide what to do about an existing lock, without touching the filesystem —
 * so both branches are testable and neither needs a real process.
 *
 * @returns {{action: 'take'|'refuse', reason: string, holder?: object}}
 */
export function evaluateLock(raw, { isAlive = pidIsAlive, self = process.pid } = {}) {
  if (!raw) return { action: 'take', reason: 'no lock present' };
  let holder;
  try {
    holder = JSON.parse(raw);
  } catch {
    // A truncated lock is a crash artifact, not a running process.
    return { action: 'take', reason: 'lock file was unreadable; treating as stale' };
  }
  if (holder.pid === self) return { action: 'take', reason: 'lock is our own' };
  if (isAlive(holder.pid)) return { action: 'refuse', reason: 'holder is alive', holder };
  return {
    action: 'take',
    reason: `holder pid ${holder.pid} is gone; taking over a stale lock`,
    holder,
  };
}

/**
 * ACQUISITION IS ATOMIC, and read-then-write would not be. Two runs starting
 * together would both read "no lock", both decide to take it, and both write —
 * which is the exact race this file exists to prevent, reintroduced inside the
 * lock itself. `flag: 'wx'` is an exclusive create: the OS guarantees exactly
 * one winner, and the loser gets EEXIST.
 *
 * Only after losing that race do we look at who holds it, because that is the
 * only case where staleness matters.
 */
export function acquireLock(loopDir, { now = Date.now(), log = () => {} } = {}) {
  const file = path.join(loopDir, LOCK_BASENAME);
  const mine = JSON.stringify(
    { pid: process.pid, startedAt: new Date(now).toISOString() },
    null,
    2,
  );

  const tryCreate = () => {
    try {
      fs.writeFileSync(file, mine, { flag: 'wx' });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };

  if (tryCreate()) return file;

  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    // Vanished between EEXIST and the read — whoever held it released it.
  }
  const verdict = evaluateLock(raw);
  if (verdict.action === 'refuse') throw new LockHeldError(verdict.holder);
  if (verdict.holder) log(`lock: ${verdict.reason}`);

  // Stale: remove and re-create exclusively. If a third process wins the gap,
  // it holds a legitimate live lock and we refuse rather than stomp it.
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone
  }
  if (tryCreate()) return file;
  throw new LockHeldError(verdict.holder ?? { pid: 'unknown', startedAt: 'unknown' });
}

/** Only ever removes OUR lock — a run that overran and lost it must not delete
 *  the lock of whoever legitimately took over. */
export function releaseLock(loopDir) {
  const file = path.join(loopDir, LOCK_BASENAME);
  try {
    const holder = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (holder.pid !== process.pid) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
