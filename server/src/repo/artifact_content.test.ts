import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { appendMultiAgentMutation, createMultiAgentSession } from './multi_agent.js';
import {
  MAX_ARTIFACT_BYTES,
  readArtifactContent,
  redactArtifactContent,
} from './artifact_content.js';

// Cluster I Phase H3 (UI_Findings spec §4.4): server-side coverage for the
// artifact current-content read. The `redactArtifactContent` tier are pure
// (no DB/fs); the `readArtifactContent` tier spins a real SQLite under a tmp
// `~/.cebab` and writes real files on disk so the TOCTOU-safe `fs` path, the
// 1 MB cap, and the mutation lookup all run through production code.

// A valid 20-char AWS access key (AKIA + 16) — the canonical Tier-3 pattern.
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-artifact-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // applies 001..025
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Create the parent bus session once (FK target for mutation rows). */
function seedSession(id = 's1'): void {
  createMultiAgentSession(id, 'orchestrator');
}

/** Append a mutation row and return its numeric id. */
function seedMutation(opts: { filePath: string | null; cwd: string | null; sessionId?: string }) {
  const rec = appendMultiAgentMutation(
    opts.sessionId ?? 's1',
    'worker',
    opts.filePath ? 'Write' : 'Bash',
    'mutate',
    'did a thing',
    { filePath: opts.filePath, cwd: opts.cwd, toolUseId: null },
  );
  return rec.id;
}

/** Write a file under the tmp workspace and return its absolute path. */
function writeFile(rel: string, content: string): string {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

// ---------------------------------------------------------------------------
// redactArtifactContent — pure redaction policy
// ---------------------------------------------------------------------------

describe('redactArtifactContent — pure', () => {
  test('benign content is returned verbatim with no fields', () => {
    const body = 'line one\nconst x = 1;\nexport default x;\n';
    const { redacted, fields } = redactArtifactContent('src/app.ts', body);
    expect(redacted).toBe(body); // byte-exact (trailing newline preserved)
    expect(fields).toEqual([]);
  });

  test('[security] sensitive PATH masks the WHOLE body', () => {
    const body = 'API_KEY=plaintext-value\nDB_PASS=hunter2\n';
    // `.env` is a sensitive-stem basename → the file itself is a secret.
    const { redacted, fields } = redactArtifactContent('.env', body);
    expect(redacted).toBe('<redacted>');
    expect(fields).toEqual(['content']);
    // The plaintext key/value must NOT survive anywhere in the output.
    expect(redacted).not.toContain('plaintext-value');
    expect(redacted).not.toContain('hunter2');
  });

  test('[security] credentials / id_rsa / .aws / .git-config paths mask wholesale', () => {
    for (const p of [
      'config/credentials.json',
      'secrets/id_rsa',
      '/home/u/.aws/credentials',
      'repo/.git/config',
    ]) {
      const out = redactArtifactContent(p, 'whatever the contents are\nsecond line\n');
      expect(out.redacted, p).toBe('<redacted>');
      expect(out.fields, p).toEqual(['content']);
    }
  });

  test('[security] non-sensitive path masks only the lines carrying inline secrets', () => {
    const body = ['const region = "us-east-1";', `const key = "${AWS_KEY}";`, 'doStuff(key);'].join(
      '\n',
    );
    const { redacted, fields } = redactArtifactContent('src/aws.ts', body);
    const lines = redacted.split('\n');
    expect(lines[0]).toBe('const region = "us-east-1";'); // intact
    expect(lines[1]).toBe('<redacted>'); // the AKIA line masked
    expect(lines[2]).toBe('doStuff(key);'); // intact
    expect(fields).toEqual(['line:2']);
    expect(redacted).not.toContain(AWS_KEY);
  });

  test('a null path skips the whole-file tier and still masks inline secrets per line', () => {
    const body = `safe\nAuthorization: Bearer ${'a'.repeat(40)}\nsafe2`;
    const { redacted, fields } = redactArtifactContent(null, body);
    expect(redacted.split('\n')[1]).toBe('<redacted>');
    expect(fields).toEqual(['line:2']);
  });

  test('caps the reported line fields (badge only needs "something masked")', () => {
    // 150 secret lines → masked content, but fields list is bounded.
    const body = Array.from({ length: 150 }, () => `tok ${AWS_KEY}`).join('\n');
    const { redacted, fields } = redactArtifactContent('src/many.ts', body);
    expect(redacted).not.toContain(AWS_KEY);
    expect(fields.length).toBeLessThanOrEqual(100);
    expect(fields.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// readArtifactContent — lookup + TOCTOU read + cap + redact
// ---------------------------------------------------------------------------

describe('readArtifactContent — happy path', () => {
  test('reads an absolute-path artifact and returns content + size + mtime', () => {
    seedSession();
    const abs = writeFile('notes.md', '# Title\nbody text\n');
    const id = seedMutation({ filePath: abs, cwd: tmpRoot });

    const out = readArtifactContent(id);
    expect(out.error).toBeUndefined();
    expect(out.content).toBe('# Title\nbody text\n');
    expect(out.size).toBe(Buffer.byteLength('# Title\nbody text\n'));
    expect(out.truncated).toBe(false);
    expect(out.mtime).toBeGreaterThan(0);
    expect(out.redactedFields).toEqual([]);
  });

  test('resolves a RELATIVE filePath against the mutation cwd', () => {
    seedSession();
    writeFile('sub/dir/x.txt', 'relative-resolved-ok');
    const id = seedMutation({ filePath: 'sub/dir/x.txt', cwd: tmpRoot });

    const out = readArtifactContent(id);
    expect(out.error).toBeUndefined();
    expect(out.content).toBe('relative-resolved-ok');
  });

  test('an empty file reads as empty content, not an error', () => {
    seedSession();
    const abs = writeFile('empty.txt', '');
    const id = seedMutation({ filePath: abs, cwd: tmpRoot });

    const out = readArtifactContent(id);
    expect(out.error).toBeUndefined();
    expect(out.content).toBe('');
    expect(out.size).toBe(0);
  });
});

describe('readArtifactContent — 1 MB cap (H3-4)', () => {
  test('a file larger than the cap is truncated to the first MB', () => {
    seedSession();
    const big = 'a'.repeat(MAX_ARTIFACT_BYTES + 4096);
    const abs = writeFile('big.log', big);
    const id = seedMutation({ filePath: abs, cwd: tmpRoot });

    const out = readArtifactContent(id);
    expect(out.error).toBeUndefined();
    expect(out.truncated).toBe(true);
    expect(out.size).toBe(MAX_ARTIFACT_BYTES);
    expect(out.content.length).toBe(MAX_ARTIFACT_BYTES);
  });

  test('a file exactly at the cap is NOT truncated', () => {
    seedSession();
    const abs = writeFile('exact.log', 'b'.repeat(MAX_ARTIFACT_BYTES));
    const id = seedMutation({ filePath: abs, cwd: tmpRoot });

    const out = readArtifactContent(id);
    expect(out.truncated).toBe(false);
    expect(out.size).toBe(MAX_ARTIFACT_BYTES);
  });
});

describe('readArtifactContent — redaction (H3-3)', () => {
  test('[security] a sensitive-path artifact comes back fully masked', () => {
    seedSession();
    const abs = writeFile('.env', `SECRET=${AWS_KEY}\nDB=postgres://localhost\n`);
    const id = seedMutation({ filePath: abs, cwd: tmpRoot });

    const out = readArtifactContent(id);
    expect(out.error).toBeUndefined();
    expect(out.content).toBe('<redacted>');
    expect(out.redactedFields).toEqual(['content']);
    expect(out.content).not.toContain(AWS_KEY);
    expect(out.content).not.toContain('postgres://localhost');
  });

  test('[security] a benign-path artifact masks only its secret lines', () => {
    seedSession();
    const abs = writeFile('deploy.sh', `#!/bin/sh\nexport AWS_KEY=${AWS_KEY}\necho done\n`);
    const id = seedMutation({ filePath: abs, cwd: tmpRoot });

    const out = readArtifactContent(id);
    expect(out.error).toBeUndefined();
    expect(out.content).toContain('#!/bin/sh'); // non-secret lines survive
    expect(out.content).toContain('echo done');
    expect(out.content).not.toContain(AWS_KEY); // the secret line is masked
    expect(out.redactedFields).toEqual(['line:2']);
  });
});

describe('readArtifactContent — error outcomes', () => {
  test('mutation_not_found for an unknown id', () => {
    const out = readArtifactContent(999_999);
    expect(out.error).toBe('mutation_not_found');
    expect(out.content).toBe('');
    expect(out.size).toBe(0);
    expect(out.mtime).toBe(0);
  });

  test('no_file_path when the mutation has no target file (Bash/Agent/Task)', () => {
    seedSession();
    const id = seedMutation({ filePath: null, cwd: tmpRoot });
    const out = readArtifactContent(id);
    expect(out.error).toBe('no_file_path');
  });

  test('no_file_path when a relative path has no cwd to resolve against', () => {
    seedSession();
    const id = seedMutation({ filePath: 'rel/path.txt', cwd: null });
    const out = readArtifactContent(id);
    expect(out.error).toBe('no_file_path');
  });

  test('not_a_file when the path resolves to a directory', () => {
    seedSession();
    const dir = path.join(tmpRoot, 'a-directory');
    fs.mkdirSync(dir, { recursive: true });
    const id = seedMutation({ filePath: dir, cwd: tmpRoot });
    const out = readArtifactContent(id);
    expect(out.error).toBe('not_a_file');
  });

  test('read_failed when the file no longer exists on disk', () => {
    seedSession();
    const id = seedMutation({ filePath: path.join(tmpRoot, 'gone.txt'), cwd: tmpRoot });
    const out = readArtifactContent(id);
    expect(out.error).toBe('read_failed');
  });
});

describe('[security] an armoured multi-line secret does not ship its body (Cebab-6fax.31)', () => {
  // MEASURED 2026-09-08. A PEM private key pasted into a previewable file had
  // its BEGIN and END lines masked and its base64 BODY — which IS the key —
  // shipped verbatim, while this module's header claimed parity with the log
  // view. Per-line redaction is structurally unable to see a secret whose body
  // matches no pattern of its own; the same shape as `Cebab-ygu.47`, where a
  // secret chopped across two stream deltas survived the per-line pass. That
  // fix changed the corpus; this one changes the unit, from a line to a block.
  //
  // The key material is assembled at RUNTIME rather than written out, so the
  // repo's secret scanner has nothing to find
  // (`project_secret_shaped_test_data`).
  const B = '-----BEGIN' + ' RSA PRIVATE KEY-----';
  const E = '-----END' + ' RSA PRIVATE KEY-----';
  const BODY_A = 'MIIEow' + 'IBAAKCAQEA3Zx8kQvHt' + 'nQ1cWq9m2ZJ4pLbVdRs';
  const BODY_B = 'TfYh2K' + 'LmN8pQrStUvWxYz0123' + '456789abcdefghijklm';

  test('the body between the delimiters is masked, not just the delimiters', () => {
    const src = ['# my config', B, BODY_A, BODY_B, E, 'port = 8080'].join('\n');
    const { redacted } = redactArtifactContent('/tmp/app.conf', src);
    expect(redacted).not.toContain(BODY_A);
    expect(redacted).not.toContain(BODY_B);
  });

  test('the rest of the file stays readable — this is not a whole-body blank', () => {
    // The Tier 1 whole-file rule exists for files whose PATH says "secret".
    // A config that merely embeds one must still be previewable, or operators
    // turn the preview off.
    const src = ['# my config', B, BODY_A, E, 'port = 8080'].join('\n');
    const { redacted } = redactArtifactContent('/tmp/app.conf', src);
    expect(redacted).toContain('# my config');
    expect(redacted).toContain('port = 8080');
  });

  test('a block with no END is masked to EOF', () => {
    // The file was truncated at the read cap, or the key is malformed. Either
    // way the tail is still key material.
    const src = ['intro', B, BODY_A, BODY_B].join('\n');
    const { redacted } = redactArtifactContent('/tmp/app.conf', src);
    expect(redacted).toContain('intro');
    expect(redacted).not.toContain(BODY_A);
    expect(redacted).not.toContain(BODY_B);
  });

  test('the masked range is reported in `fields`', () => {
    const src = ['intro', B, BODY_A, E].join('\n');
    const { fields } = redactArtifactContent('/tmp/app.conf', src);
    expect(fields).toContain('block:2-4');
  });

  test('two blocks in one file are both masked', () => {
    const src = [B, BODY_A, E, 'middle', B, BODY_B, E].join('\n');
    const { redacted } = redactArtifactContent('/tmp/app.conf', src);
    expect(redacted).not.toContain(BODY_A);
    expect(redacted).not.toContain(BODY_B);
    expect(redacted).toContain('middle');
  });

  test('ANTI-VACUITY: an ordinary file with base64-looking content is untouched', () => {
    // The reason the rule is delimiter-shaped rather than a "looks like a key
    // blob" heuristic: a broad matcher would blank minified JS, lockfile
    // integrity hashes and every data URI in the tree, and a preview that
    // blanks ordinary files gets switched off.
    const src = ['const sri = "sha512-' + BODY_A + '";', 'export default sri;'].join('\n');
    const { redacted, fields } = redactArtifactContent('/tmp/app.js', src);
    expect(redacted).toBe(src);
    expect(fields).toEqual([]);
  });

  test('ANTI-VACUITY: a PUBLIC key block is not treated as private', () => {
    const pub = '-----BEGIN' + ' PUBLIC KEY-----';
    const src = [pub, BODY_A, '-----END' + ' PUBLIC KEY-----'].join('\n');
    expect(redactArtifactContent('/tmp/app.conf', src).redacted).toBe(src);
  });
});
