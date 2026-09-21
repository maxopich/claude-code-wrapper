/**
 * The ordering, which is the actual defect.
 *
 * `smoke_port_guard.test.ts` proves the check answers correctly. It cannot
 * prove that `ci_smoke` CALLS it, or calls it before spawning — and "after the
 * spawn" is exactly the shape the bug had (`Cebab-j1dl`): the old code did
 * check `serverExited`, just too late to matter, because the squatter's 200
 * arrived before our child's exit event. A unit test of the helper would have
 * been green throughout.
 *
 * So this runs the real script against a real occupied port and asserts on what
 * it did NOT do. The negatives carry the weight: reaching `server healthy` or
 * the auth-token read means the guard did not stop it, whatever else it printed.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const open: net.Server[] = [];
afterEach(async () => {
  while (open.length) {
    const s = open.pop();
    await new Promise<void>((resolve) => s?.close(() => resolve()));
  }
});

/** Stand in for the stray `dev:server` that cost a finished feature. */
function squat(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    open.push(s);
    s.listen({ port: 0, host: '127.0.0.1' }, () => resolve((s.address() as net.AddressInfo).port));
  });
}

function runCiSmoke(port: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, 'src/ci_smoke.ts'], {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (b) => (output += String(b)));
    child.stderr.on('data', (b) => (output += String(b)));
    child.on('exit', (code) => resolve({ code: code ?? 1, output }));
  });
}

describe('ci_smoke against an occupied port', () => {
  test('refuses before spawning, and never reaches ws_smoke', async () => {
    const port = await squat();
    const { code, output } = await runCiSmoke(port);

    expect(code, `ci_smoke exited ${code}\n${output}`).not.toBe(0);
    expect(output).toContain(String(port));
    expect(output).toContain('Refusing to run');

    // The two negatives. Both strings are on the path the old code took, and
    // either one appearing means the guard ran too late or not at all.
    expect(output).not.toContain('server healthy');
    expect(output).not.toContain('auth-token');
  }, 60_000);
});
