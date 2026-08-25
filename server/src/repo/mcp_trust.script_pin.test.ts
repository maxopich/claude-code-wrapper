import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { closeDb, getDb } from '../db.js';
import { config } from '../config.js';
import { _resetOperatorIdCache } from '../notifications/operator.js';
import {
  changedScriptPaths,
  checkTrust,
  computeScriptShas,
  parseScriptShas,
  recordTrustDecision,
  SCRIPT_TOO_LARGE,
} from './mcp_trust.js';

// `Cebab-1af` [security]: the MCP trust ledger pins the FILES a declaration
// points at, not only the declaration.
//
// The finding, reproduced end-to-end by `the bead's case` below: an operator
// approves `{ command: 'node', args: ['mcp/kitchen-server.mjs'] }`, the SCRIPT
// is rewritten in place, and every identity the ledger had matched — because
// `binary_sha` hashes the COMMAND, and `node` is not an absolute path. No
// modal, no audit row, new program.
//
// Every case below names the mutation it reddens, because most of them would
// pass against a resolver that pinned the wrong file or pinned nothing.

let tmpRoot: string;
let projectPath: string;
let originalDataDir: string;

const ORIGIN = '/p/.mcp.json';

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mcp-script-pin-'));
  projectPath = path.join(tmpRoot, 'project');
  fs.mkdirSync(path.join(projectPath, 'mcp'), { recursive: true });
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  _resetOperatorIdCache();
  getDb();
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  _resetOperatorIdCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeScript(rel: string, body: string): string {
  const abs = path.join(projectPath, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return createHash('sha256').update(Buffer.from(body)).digest('hex');
}

// ---- computeScriptShas: what counts as a file this declaration runs ----

describe('[security] computeScriptShas — which tokens get pinned', () => {
  test('an arg that names a readable file is hashed, keyed by the token as declared', () => {
    // Reddens: returning null for a relative arg, or keying by the resolved
    // absolute path (which would make the map unstable across checkouts and
    // useless as an operator-facing label).
    const sha = writeScript('mcp/kitchen-server.mjs', 'export const kitchen = 1;\n');
    expect(computeScriptShas('node', ['mcp/kitchen-server.mjs'], projectPath)).toEqual({
      'mcp/kitchen-server.mjs': sha,
    });
  });

  test('a bare command is never hashed, even when a file of that name sits in the project', () => {
    // The asymmetry this module argues for: a command with no separator is
    // resolved on PATH, so `<project>/node` is NOT what runs. Reddens: dropping
    // `commandIsRelativePath` and treating the command like an arg, which pins
    // bytes that never execute and then reports them "unchanged" forever.
    writeScript('node', 'not the real node\n');
    expect(computeScriptShas('node', [], projectPath)).toBeNull();
  });

  test('a command containing a separator IS hashed; an absolute command is left to binary_sha', () => {
    // Reddens (first half): treating every non-absolute command as a PATH
    // lookup, which misses `{ command: './mcp/server.mjs' }` entirely.
    // Reddens (second half): hashing an absolute command here as well, which
    // pins one file in two columns and fires two prompts for one change.
    const sha = writeScript('mcp/server.mjs', 'relative command\n');
    expect(computeScriptShas('./mcp/server.mjs', [], projectPath)).toEqual({
      './mcp/server.mjs': sha,
    });

    const abs = path.join(projectPath, 'mcp', 'server.mjs');
    expect(computeScriptShas(abs, [], projectPath)).toBeNull();
  });

  test('flag tokens are skipped, and the file after a flag is not', () => {
    // Reddens: dropping the `-` guard, which would try to read a file named
    // `--experimental-vm-modules` (harmless) — and, more usefully, would make
    // the flag itself an entry that never resolves.
    const sha = writeScript('mcp/server.mjs', 'flagged\n');
    expect(
      computeScriptShas('node', ['--experimental-vm-modules', 'mcp/server.mjs'], projectPath),
    ).toEqual({ 'mcp/server.mjs': sha });
  });

  test('directories and missing paths contribute nothing — `npx -y pkg <dir>` pins none', () => {
    // The shape of half the MCP ecosystem. Reddens: candidacy by SYNTAX (a
    // token containing a slash) rather than by what `readFileBounded` says,
    // which would try to hash a directory and, before `safe_fs`, a device.
    fs.mkdirSync(path.join(projectPath, 'shared-dir'), { recursive: true });
    expect(
      computeScriptShas(
        'npx',
        ['-y', '@modelcontextprotocol/server-filesystem', 'shared-dir'],
        projectPath,
      ),
    ).toBeNull();
  });

  test('EVERY resolvable arg is hashed, not the first one', () => {
    // The anti-guess property, and the reason this stores a map rather than
    // 030's single hash. `node --require ./preload.js server.mjs` runs BOTH
    // files and no rule names the right one. Reddens: any "first match wins"
    // resolver — which passes every other case in this file.
    const preload = writeScript('preload.js', 'preloaded\n');
    const main = writeScript('server.mjs', 'main\n');
    expect(
      computeScriptShas('node', ['--require', './preload.js', 'server.mjs'], projectPath),
    ).toEqual({ './preload.js': preload, 'server.mjs': main });
  });

  // 64 MB written synchronously, because the cap IS 64 MB and the test has to
  // cross it. Windows CI measured this at 744 ms on one runner and 16 568 ms on
  // another, on identical code — a 22x spread in temp-disk speed, which the
  // default 5 s timeout turns into a coin flip. The explicit ceiling is about
  // the fixture's cost, not the assertion's: nothing here waits on a promise
  // that could hang, so a generous timeout cannot mask a real stall.
  test('a file over the hash cap is recorded as a sentinel, not omitted', () => {
    // Reddens: `continue` on `too_large`. An omitted entry cannot mismatch, so
    // padding a rewritten script past the cap would launder the change — the
    // one bypass an existence-keyed map is otherwise open to.
    const big = path.join(projectPath, 'big.mjs');
    fs.writeFileSync(big, Buffer.alloc(64 * 1024 * 1024 + 1, 0x61));
    expect(computeScriptShas('node', ['big.mjs'], projectPath)).toEqual({
      'big.mjs': SCRIPT_TOO_LARGE,
    });
    // And the sentinel participates in the comparison, which is the whole
    // point of recording it.
    expect(
      changedScriptPaths({ 'big.mjs': 'a'.repeat(64) }, { 'big.mjs': SCRIPT_TOO_LARGE }),
    ).toEqual(['big.mjs']);
  }, 60_000);

  test('more resolvable files than the cap pins NONE of them', () => {
    // Reddens: truncating to the first 8. A partial pin is silently narrower
    // than it looks, so the ninth file could be rewritten under a green
    // "unchanged". Refusing to identify is a state the caller already handles.
    const args: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      writeScript(`f${i}.mjs`, `file ${i}\n`);
      args.push(`f${i}.mjs`);
    }
    expect(computeScriptShas('node', args, projectPath)).toBeNull();
    // Exactly at the cap still pins.
    expect(Object.keys(computeScriptShas('node', args.slice(0, 8), projectPath)!)).toHaveLength(8);
  });

  test('a tilde is a literal directory name, not the home directory', () => {
    // Neither `execvp` nor an interpreter expands `~` — the shell does, and no
    // shell runs in this spawn. So the file to pin is `<project>/~/x.mjs`.
    //
    // Asserted from the LITERAL side on purpose: a test that only checked
    // `~/x.mjs` resolves to nothing would pass against an implementation that
    // expanded to `$HOME/x.mjs` and found nothing there either — vacuous, and
    // the home directory is not somewhere a test may write to find out.
    const sha = writeScript(path.join('~', 'x.mjs'), 'literal tilde\n');
    expect(computeScriptShas('node', ['~/x.mjs'], projectPath)).toEqual({ '~/x.mjs': sha });
  });
});

// ---- changedScriptPaths: only a value present on BOTH sides proves a change --

describe('[security] changedScriptPaths — what counts as a change', () => {
  test('present on both sides and different → changed', () => {
    expect(changedScriptPaths({ a: 'x' }, { a: 'y' })).toEqual(['a']);
    expect(changedScriptPaths({ a: 'x' }, { a: 'x' })).toEqual([]);
  });

  test('approved then, unresolvable now → NOT a change', () => {
    // A deleted script cannot run; the spawn fails loudly on its own. Reddens:
    // comparing key SETS, which turns every deleted file into a prompt — the
    // noise that teaches operators to click through.
    expect(changedScriptPaths({ a: 'x' }, {})).toEqual([]);
  });

  test('absent then, present now → NOT a change', () => {
    // Mirrors `hook_trust`'s "only a hash that RESOLVED both times can prove a
    // change". Reddens: treating a new key as a change, which fires on any
    // file the server itself writes next to one it was pointed at.
    expect(changedScriptPaths({}, { a: 'x' })).toEqual([]);
  });

  test('a null on either side proves nothing', () => {
    expect(changedScriptPaths(null, { a: 'x' })).toEqual([]);
    expect(changedScriptPaths({ a: 'x' }, null)).toEqual([]);
  });

  test('a token named after an Object.prototype key does not false-positive', () => {
    // Reddens: `approved[token]` instead of `Object.hasOwn`. The keys come from
    // a project's own args via JSON.parse, so `constructor` is reachable and
    // `approved['constructor']` finds a function — truthy, not a sha, and
    // therefore "changed" on a file nobody touched.
    expect(changedScriptPaths({ other: 'x' }, { constructor: 'x' })).toEqual([]);
  });
});

describe('parseScriptShas — a hand-edited row must not throw inside the lookup', () => {
  test('malformed, non-object and non-string values all degrade to null', () => {
    // Reddens: `JSON.parse` without the guard (throws inside a security
    // lookup), or degrading to `{}` — which reads as "pinned nothing" too but
    // loses the distinction this comment turns on.
    expect(parseScriptShas('{ not json')).toBeNull();
    expect(parseScriptShas('["a"]')).toBeNull();
    expect(parseScriptShas('{"a": 3}')).toBeNull();
    expect(parseScriptShas('{}')).toBeNull();
    expect(parseScriptShas(null)).toBeNull();
    expect(parseScriptShas('{"a":"x"}')).toEqual({ a: 'x' });
  });
});

// ---- checkTrust: the finding, end to end ----

describe('[security] checkTrust — a rewritten script under an unchanged declaration', () => {
  const DECL = { command: 'node', args: ['mcp/kitchen-server.mjs'] };

  function approve(decision: 'trusted' | 'trusted_pinned_hash' | 'denied_remember' = 'trusted') {
    const shas = computeScriptShas(DECL.command, DECL.args, projectPath);
    recordTrustDecision({
      serverName: 'kitchen',
      originPath: ORIGIN,
      ...DECL,
      binarySha: decision === 'trusted_pinned_hash' ? 'pinned-node-sha' : null,
      scriptShas: shas,
      decision,
    });
    return shas;
  }

  function look(candidateSha: string | null = null) {
    return checkTrust({
      serverName: 'kitchen',
      originPath: ORIGIN,
      candidateSha,
      ...DECL,
      candidateScriptShas: computeScriptShas(DECL.command, DECL.args, projectPath),
    });
  }

  test("the bead's case: declaration untouched, script rewritten → script_changed", () => {
    // THE FINDING. Reddens: removing the script comparison from `checkTrust`,
    // which returns `trusted` here and runs the new program silently.
    const before = writeScript('mcp/kitchen-server.mjs', 'export const ok = 1;\n');
    approve();
    const after = writeScript(
      'mcp/kitchen-server.mjs',
      'require("child_process").exec("curl…");\n',
    );
    expect(before).not.toBe(after);

    expect(look()).toEqual({
      decision: 'script_changed',
      changedPaths: ['mcp/kitchen-server.mjs'],
      previousShas: { 'mcp/kitchen-server.mjs': before },
      candidateShas: { 'mcp/kitchen-server.mjs': after },
    });
  });

  test('control: the same bytes still resolve to trusted', () => {
    // The green control for the case above. Without it, a `checkTrust` that
    // returned `script_changed` unconditionally would pass the finding's test
    // and re-prompt on every spawn forever.
    writeScript('mcp/kitchen-server.mjs', 'export const ok = 1;\n');
    approve();
    expect(look()).toEqual({ decision: 'trusted' });
  });

  test('a pinned-hash approval is covered too — the pin is on the interpreter', () => {
    // Reddens: checking scripts only on the unpinned `trusted` branch. `Trust &
    // pin hash` on `node server.mjs` pins NODE; the operator who chose the
    // strictest button is exactly the one who would assume otherwise.
    writeScript('mcp/kitchen-server.mjs', 'v1\n');
    approve('trusted_pinned_hash');
    writeScript('mcp/kitchen-server.mjs', 'v2\n');
    expect(look('pinned-node-sha').decision).toBe('script_changed');
  });

  test('a denial outranks a changed script — no re-offer of the Trust button', () => {
    // Reddens: putting the script comparison above the `denied_remember`
    // return. A denied server has nothing to re-decide, and the change prompt
    // carries Trust and Trust-and-pin buttons.
    writeScript('mcp/kitchen-server.mjs', 'v1\n');
    approve('denied_remember');
    writeScript('mcp/kitchen-server.mjs', 'v2\n');
    expect(look()).toEqual({ decision: 'denied_remember' });
  });

  test('a row decided before migration 039 pins nothing and prompts for nothing', () => {
    // The no-backfill posture, from the other side: a row that pinned nothing
    // must claim nothing. Reddens `changedScriptPaths` short-circuiting a null
    // approval to "everything changed" — which would make every pre-039 row on
    // a live install prompt on its next spawn — and it is the case a read-time
    // backfill would have to break to be written at all.
    writeScript('mcp/kitchen-server.mjs', 'v1\n');
    approve();
    getDb().prepare('UPDATE mcp_trust SET script_shas_json = NULL').run();
    writeScript('mcp/kitchen-server.mjs', 'v2\n');
    expect(look()).toEqual({ decision: 'trusted' });
  });

  test('approving again re-baselines, so the next spawn is silent', () => {
    // The property that keeps this from prompting forever. Reddens:
    // `recordTrustDecision` dropping `scriptShas` on the write path — every
    // spawn after the first change would re-prompt with the same diff.
    writeScript('mcp/kitchen-server.mjs', 'v1\n');
    approve();
    writeScript('mcp/kitchen-server.mjs', 'v2\n');
    expect(look().decision).toBe('script_changed');
    approve();
    expect(look()).toEqual({ decision: 'trusted' });
  });

  test('the approved shas reach the audit chain, not just the lookup table', () => {
    // Reddens: persisting to `mcp_trust` without adding the field to the
    // `mcp.trust_decided` payload. `mcp_trust` replaces rows it supersedes, so
    // the chain is the only place "which bytes did the operator approve" is
    // answerable after a second decision.
    const sha = writeScript('mcp/kitchen-server.mjs', 'v1\n');
    approve();
    const row = getDb()
      .prepare<[], { payload_json: string }>(
        "SELECT payload_json FROM safety_audit WHERE kind = 'mcp.trust_decided' ORDER BY id DESC LIMIT 1",
      )
      .get()!;
    expect(JSON.parse(row.payload_json).scriptShas).toEqual({ 'mcp/kitchen-server.mjs': sha });
  });
});
