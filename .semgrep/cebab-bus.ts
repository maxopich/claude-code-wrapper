/**
 * Fixtures for `.semgrep/cebab-bus.yaml`. NOT application code — nothing
 * imports this, it is never compiled, and it is excluded from eslint, from
 * the main semgrep scan and from every tsconfig.
 *
 * `semgrep --test .` (run with this directory as the cwd) reads the
 * annotations below. A `ruleid` annotation asserts the next line MUST produce
 * a finding; an `ok` annotation asserts it must not. The run exits non-zero
 * if either is wrong.
 *
 * Careful when editing the prose here: semgrep scans comments for those two
 * annotation words followed by a colon, so writing one inline in a sentence
 * registers as a real annotation and fails the run with a rule-id mismatch.
 * Hence the circumlocution above.
 *
 * This file is the liveness proof for each rule. Register X09: the rule this
 * was written in response to had been dead for months — its target symbol
 * deleted by the bus rewrite — and nothing noticed, because "no findings" and
 * "cannot produce findings" look identical in a green check. A rule that
 * stops matching its own fixture now fails CI.
 *
 * Adding a rule to cebab-bus.yaml without adding a fixture here is a failure
 * in `scripts/semgrepRules.test.mjs`, which runs in the main suite on every
 * OS and does not need semgrep installed.
 *
 * The undefined identifiers below (`srv`, `cmd`, `binary`, `WebSocketServer`)
 * are deliberate: semgrep matches syntax, not types.
 */

// --- cebab-ws-server-no-verifyClient -------------------------------------

// ruleid: cebab-ws-server-no-verifyClient
const wssMissingGate = new WebSocketServer({ server: srv, path: '/ws' });

// ok: cebab-ws-server-no-verifyClient
const wssGated = new WebSocketServer({
  server: srv,
  verifyClient: (info, cb) => cb(true),
});

// --- cebab-bus-spawn-non-literal -----------------------------------------

// ruleid: cebab-bus-spawn-non-literal
spawn(cmd, ['--version']);

// ruleid: cebab-bus-spawn-non-literal
child_process.execFile(binary, ['--help']);

// ok: cebab-bus-spawn-non-literal
spawn('claude', ['--version']);

// --- cebab-spawn-missing-win32-shell -------------------------------------

// The violating shape. Note the callee is a LOCAL, not `spawn` — that is the
// case the rule exists to catch, and the one a callee-name pattern misses.
// ruleid: cebab-spawn-missing-win32-shell
child = spawnFn(binary, args, {
  env: cleanEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});

// Guarded: the platform-conditional shell is the fix.
// ok: cebab-spawn-missing-win32-shell
child = spawnFn(binary, args, {
  env: cleanEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});

// Also guarded, on the other exclusion: spawning the Node binary itself needs
// no shell, because it is a real executable rather than a shim.
//
// The callee here is deliberately NOT the bare `spawn` that the real shape in
// `server/src/ci_smoke.ts` uses. `process.execPath` is a non-literal command,
// so bare `spawn` would also match the F2 rule above; in real code it does not,
// because F2 is scoped to `/server/src/bus/**` by `paths.include` — but
// `semgrep --test` ignores `paths.include`, so inside this file every rule sees
// every line and the two fixtures would collide. Semgrep binds an annotation to
// the single line that follows it, so stacking a `ruleid` and an `ok` is not a
// way out. Keeping the callee distinct is, and it costs this rule nothing:
// matching by shape rather than by callee name is the point of it.
// ok: cebab-spawn-missing-win32-shell
spawnFn(process.execPath, [tsxCli, script], {
  cwd: serverDir,
  stdio: 'inherit',
});
