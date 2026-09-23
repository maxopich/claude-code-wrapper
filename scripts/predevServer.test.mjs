/**
 * The dev:server pre-start cleanup must free ONLY the port this server is about
 * to bind — never every matching Cebab server on the machine (Cebab-ulfb).
 *
 * WHAT WENT WRONG. `predev-server.mjs` used to list every process whose command
 * line matched the NEEDLE and SIGKILL them all. Because the autonomous loop
 * gate and an operator's QA server can run from other checkouts at the same
 * time, starting a dev server from ANY checkout killed the others mid-run —
 * a resource shared across checkouts that no per-process guard could see. The
 * fix scopes the kill to the LISTENER on the target port; every other Cebab
 * server is left alone.
 *
 * These cases pin the pure decision (`decideKill`) directly, since the I/O that
 * feeds it (lsof / ps / netstat / wmic) cannot be exercised deterministically
 * in a unit test. The "different port" control lives INSIDE the happy-path case
 * on purpose: a second, fully-matching Cebab tree sits in the process table and
 * must come out untouched, which is the exact regression the old code caused.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { decideKill, readEnvFilePorts, resolveTargetPort, NEEDLE } from './predev-server.mjs';

/** A realistic tsx-watch command line for a Cebab dev server. */
const WATCH_CMD =
  'node /repo/server/node_modules/.bin/tsx watch --env-file-if-exists=../.env src/index.ts';
/** The child Node the supervisor spawns — binds the port, does NOT carry the args. */
const CHILD_CMD = 'node --import file:///repo/server/node_modules/tsx/dist/loader.mjs src/index.ts';

describe('decideKill: port-scoped dev-server cleanup', () => {
  test('listener is a Cebab server under tsx watch → kills the listener AND its supervisor', () => {
    // Our tree, listening on the target port via child pid 300.
    // A SECOND, fully-matching Cebab tree (400/500) listens on a DIFFERENT
    // port — the control that must survive.
    const processes = [
      { pid: 100, ppid: 1, command: 'node /usr/lib/npm-cli.js run dev' },
      { pid: 200, ppid: 100, command: WATCH_CMD },
      { pid: 300, ppid: 200, command: CHILD_CMD },
      // Another checkout's server (e.g. the loop gate), different port:
      { pid: 400, ppid: 1, command: WATCH_CMD.replace('/repo/', '/other-checkout/') },
      { pid: 500, ppid: 400, command: CHILD_CMD.replace('/repo/', '/other-checkout/') },
    ];

    const decision = decideKill(processes, [300]);

    expect(decision.action).toBe('kill');
    expect(new Set(decision.kill)).toEqual(new Set([300, 200]));
    // The other checkout's server is untouched — the whole point of the fix.
    expect(decision.kill).not.toContain(400);
    expect(decision.kill).not.toContain(500);
  });

  test('listener itself matches the NEEDLE → still killed with its ancestor', () => {
    const processes = [
      { pid: 200, ppid: 1, command: WATCH_CMD },
      { pid: 300, ppid: 200, command: WATCH_CMD }, // child carries the args too
    ];
    const decision = decideKill(processes, [300]);
    expect(decision.action).toBe('kill');
    expect(new Set(decision.kill)).toEqual(new Set([300, 200]));
  });

  test('listener is a non-Cebab process → refuses, kills nothing', () => {
    const processes = [
      { pid: 700, ppid: 1, command: '/usr/local/bin/some-other-server --port 4319' },
      // A matching Cebab server elsewhere must NOT tempt a kill: it is not the
      // listener, so it is invisible to the decision.
      { pid: 200, ppid: 1, command: WATCH_CMD },
    ];
    const decision = decideKill(processes, [700]);
    expect(decision.action).toBe('refuse');
    expect(decision.holder.pid).toBe(700);
    expect(decision.holder.command).toMatch(/some-other-server/);
    expect(decision.kill).toBeUndefined();
  });

  test('no listener on the port → nothing to do', () => {
    const processes = [{ pid: 200, ppid: 1, command: WATCH_CMD }];
    expect(decideKill(processes, []).action).toBe('noop');
    expect(decideKill(processes, undefined).action).toBe('noop');
  });

  test('listener pid absent from the table → refuses rather than guessing', () => {
    // lsof named a pid ps did not (a race, or a permission gap). It is not
    // recognisable as ours, so we must not kill it.
    const decision = decideKill([{ pid: 1, ppid: 0, command: 'init' }], [999]);
    expect(decision.action).toBe('refuse');
    expect(decision.holder.pid).toBe(999);
  });
});

describe('resolveTargetPort: matches server/src/config.ts precedence', () => {
  test('defaults to 4319 when neither var is set', () => {
    expect(resolveTargetPort({})).toBe(4319);
  });
  test('bare PORT is honoured', () => {
    expect(resolveTargetPort({ PORT: '5000' })).toBe(5000);
  });
  test('prefixed CEBAB_PORT wins over bare PORT', () => {
    expect(resolveTargetPort({ CEBAB_PORT: '6000', PORT: '5000' })).toBe(6000);
  });
  test('blank / non-integer / out-of-range fall back to the default', () => {
    expect(resolveTargetPort({ PORT: '' })).toBe(4319);
    expect(resolveTargetPort({ PORT: 'abc' })).toBe(4319);
    expect(resolveTargetPort({ PORT: '70000' })).toBe(4319);
    expect(resolveTargetPort({ PORT: '0' })).toBe(4319);
  });
});

describe('resolveTargetPort reads the .env the server will load (review of Cebab-ulfb)', () => {
  test('a PORT declared only in .env is the port that gets freed', () => {
    // The server gets `--env-file-if-exists=../.env`; this hook runs before it
    // with a plain process env. Reading only `env` freed 4319 here.
    expect(resolveTargetPort({}, { PORT: '4400' })).toBe(4400);
    // Control, same case: nothing anywhere is still the default.
    expect(resolveTargetPort({}, {})).toBe(4319);
  });

  test('per key, the process env beats the file, as Node\u2019s --env-file does', () => {
    expect(resolveTargetPort({ PORT: '5000' }, { PORT: '4400' })).toBe(5000);
    // CEBAB_PORT from the file still outranks a bare PORT from the env,
    // because the server reads CEBAB_PORT first whichever source supplied it.
    expect(resolveTargetPort({ PORT: '5000' }, { CEBAB_PORT: '6000' })).toBe(6000);
    // A blank env value does not shadow the file.
    expect(resolveTargetPort({ PORT: '' }, { PORT: '4400' })).toBe(4400);
  });

  test('the CLI itself reads the .env beside the repo root, not only the function', () => {
    // Wiring, not logic: a copy of the script under <tmp>/scripts/ with a
    // <tmp>/.env declaring PORT. --dry-run names the port it decided on and
    // kills nothing. The env passed has NO port, so only the file can supply it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'predev-cli-'));
    try {
      fs.mkdirSync(path.join(dir, 'scripts'));
      const script = path.join(dir, 'scripts', 'predev-server.mjs');
      fs.copyFileSync(new URL('./predev-server.mjs', import.meta.url), script);
      fs.writeFileSync(path.join(dir, '.env'), 'PORT=45999\n');
      const env = { ...process.env };
      delete env.PORT;
      delete env.CEBAB_PORT;
      const out = execFileSync(process.execPath, [script, '--dry-run'], { env, encoding: 'utf8' });
      expect(out).toContain('port 45999');
      expect(out).not.toContain('port 4319');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('readEnvFilePorts parses export prefixes and quotes, last one wins', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'predev-env-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'MOCK=0\nexport PORT="4400"\nCEBAB_PORT=\nPORT=4401\n');
    try {
      expect(readEnvFilePorts(file)).toEqual({ PORT: '4401', CEBAB_PORT: '' });
      expect(readEnvFilePorts(path.join(dir, 'missing.env'))).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('anti-vacuity: NEEDLE distinguishes ours from a stranger', () => {
  test('matches a Cebab tsx-watch command', () => {
    expect(NEEDLE.test(WATCH_CMD)).toBe(true);
  });
  test('does not match a plain node or an unrelated tsx watch', () => {
    expect(NEEDLE.test('node dist/index.js')).toBe(false);
    expect(NEEDLE.test('node .bin/tsx watch --env-file-if-exists=../.env other.ts')).toBe(false);
    expect(NEEDLE.test('/usr/local/bin/some-other-server --port 4319')).toBe(false);
  });
});
