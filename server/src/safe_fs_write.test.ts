/**
 * [security] Cebab-ws0.10 — the atomic bounded write.
 *
 * ITS OWN FILE because it is its own hazard set. `safe_fs.test.ts` next door
 * narrates the reader's three (blocking, unbounded, wrong type) and is
 * organised around them; a write shares none of those and answers a different
 * question — not "can this path be re-pointed between the check and the use?"
 * but "can bytes be put at a NAME without following whatever is standing
 * there, and without a reader ever seeing half of them?"
 *
 * The symlink case below is the one that decides the implementation. A plain
 * `fs.writeFileSync` FOLLOWS a symlink and deposits the operator's config
 * wherever it points; `O_NOFOLLOW` would refuse and leave the planted link in
 * place; the rename destroys it and puts a real file there. Only the third is
 * both safe and useful, and only this test tells the three apart.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { writeFileAtomicBounded } from './safe_fs.js';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-safe-write-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const OPTS = { maxBytes: 1024, mode: 0o600 };

describe('writeFileAtomicBounded', () => {
  test('writes new content and reports a usable mtime', () => {
    const p = path.join(dir, 'f.json');
    const r = writeFileAtomicBounded(p, Buffer.from('{"a":1}'), OPTS);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('{"a":1}');
    // The token has to be the value a later `stat` produces, not `Date.now()`
    // — the caller hands it back as a concurrency check.
    expect(r.ok && r.mtimeMs).toBe(fs.statSync(p).mtimeMs);
  });

  test('replaces existing content wholly, leaving no trailing tail', () => {
    const p = path.join(dir, 'f.txt');
    fs.writeFileSync(p, 'a much longer previous body');
    writeFileAtomicBounded(p, Buffer.from('short'), OPTS);
    expect(fs.readFileSync(p, 'utf8')).toBe('short');
  });

  test('leaves no temp file behind on success', () => {
    const p = path.join(dir, 'f.txt');
    writeFileAtomicBounded(p, Buffer.from('x'), OPTS);
    expect(fs.readdirSync(dir)).toEqual(['f.txt']);
  });

  test('[security] over-cap content is refused and nothing is written', () => {
    const p = path.join(dir, 'f.txt');
    fs.writeFileSync(p, 'original');
    const r = writeFileAtomicBounded(p, Buffer.from('z'.repeat(1025)), OPTS);
    expect(r).toEqual({ ok: false, refusal: 'too_large' });
    expect(fs.readFileSync(p, 'utf8')).toBe('original');
    // Checking the cap AFTER writing the temp file would leave one here.
    expect(fs.readdirSync(dir)).toEqual(['f.txt']);
  });

  test.runIf(process.platform !== 'win32')(
    '[security] a SYMLINK at the target is destroyed, not written through',
    () => {
      // The case the whole temp-and-rename shape exists for. `writeFileSync`
      // reddens here by writing to `secret` and leaving it linked.
      const target = path.join(dir, 'config.json');
      const secret = path.join(dir, 'secret.txt');
      fs.writeFileSync(secret, 'PRIVATE');
      fs.symlinkSync(secret, target);

      const r = writeFileAtomicBounded(target, Buffer.from('{"new":true}'), OPTS);
      expect(r.ok).toBe(true);
      // The pointed-at file is untouched...
      expect(fs.readFileSync(secret, 'utf8')).toBe('PRIVATE');
      // ...and the target is now a real file, not a link.
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(target, 'utf8')).toBe('{"new":true}');
    },
  );

  test.runIf(process.platform !== 'win32')('[security] the mode applies at CREATION', () => {
    // Not `writeFileSync` then `chmod`: that leaves the bytes briefly
    // world-readable, on exactly the credential-bearing files this is for.
    const p = path.join(dir, 'creds.json');
    writeFileAtomicBounded(p, Buffer.from('{}'), { maxBytes: 1024, mode: 0o600 });
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  test('a failed commit refuses and leaves the previous contents intact', () => {
    // The crash-mid-write property, forced rather than waited for. The rename
    // is the only step that can lose data, so that is the one to break.
    const p = path.join(dir, 'f.txt');
    fs.writeFileSync(p, 'original');
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EXDEV');
    });
    const r = writeFileAtomicBounded(p, Buffer.from('new'), OPTS);
    spy.mockRestore();

    expect(r).toEqual({ ok: false, refusal: 'commit_failed' });
    expect(fs.readFileSync(p, 'utf8')).toBe('original');
    // And the temp file is cleaned up rather than accumulating on every failure.
    expect(fs.readdirSync(dir)).toEqual(['f.txt']);
  });

  test('an unwritable directory refuses rather than throwing', () => {
    // Contract with its neighbours: a project-supplied path must never crash a
    // turn, so every failure is a typed refusal.
    const r = writeFileAtomicBounded(path.join(dir, 'no', 'such', 'f.txt'), Buffer.from('x'), OPTS);
    expect(r).toEqual({ ok: false, refusal: 'unwritable' });
  });

  test('the temp name is dot-prefixed so a stray one is not mistaken for config', () => {
    // `Cebab-ws0.6`'s scan reads `.mcp.json` by exact name today, but a future
    // glob over the project root would otherwise pick up a temp left by a
    // killed process.
    const p = path.join(dir, 'f.txt');
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('boom');
    });
    // Force the failure path, then re-check with cleanup disabled to observe
    // the name the implementation chose.
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    writeFileAtomicBounded(p, Buffer.from('x'), OPTS);
    spy.mockRestore();
    unlink.mockRestore();

    const left = fs.readdirSync(dir);
    expect(left).toHaveLength(1);
    expect(left[0]!.startsWith('.')).toBe(true);
    expect(left[0]).toContain('cebab-tmp');
  });
});
