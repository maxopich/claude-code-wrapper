import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ServerMsg } from '@cebab/shared';
import { config } from './config.js';
import { closeDb, getDb } from './db.js';
import { appendMultiAgentMutation, createMultiAgentSession } from './repo/multi_agent.js';
import { MAX_ARTIFACT_BYTES } from './repo/artifact_content.js';
import { executeGetArtifactContent } from './get_artifact_content.js';

// Cluster I Phase H3 (UI_Findings spec §4.4): coverage for the thin WS
// delegate. The deep read/redaction behavior is tested in
// `repo/artifact_content.test.ts`; here we assert the executor maps the read
// outcome onto the `artifact_content` reply and OMITS the falsy optionals
// (truncated / redactedFields / error) so the wire stays lean.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-artifact-exec-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

type ArtifactReply = Extract<ServerMsg, { type: 'artifact_content' }>;

function run(mutationId: number): ArtifactReply {
  const sent: ServerMsg[] = [];
  executeGetArtifactContent({
    msg: { type: 'get_artifact_content', mutationId },
    send: (m) => sent.push(m),
  });
  expect(sent).toHaveLength(1);
  const reply = sent[0]!;
  expect(reply.type).toBe('artifact_content');
  return reply as ArtifactReply;
}

function seedMutationForFile(rel: string, content: string): number {
  createMultiAgentSession('s1', 'orchestrator');
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return appendMultiAgentMutation('s1', 'worker', 'Write', 'mutate', 'wrote', {
    filePath: abs,
    cwd: tmpRoot,
    toolUseId: null,
  }).id;
}

describe('executeGetArtifactContent', () => {
  test('maps a successful read and OMITS falsy optionals', () => {
    const id = seedMutationForFile('a.txt', 'hello world\n');
    const reply = run(id);

    expect(reply.mutationId).toBe(id);
    expect(reply.content).toBe('hello world\n');
    expect(reply.size).toBe(Buffer.byteLength('hello world\n'));
    expect(reply.mtime).toBeGreaterThan(0);
    // No redaction, not truncated, no error → those keys are absent.
    expect(reply).not.toHaveProperty('error');
    expect(reply).not.toHaveProperty('truncated');
    expect(reply).not.toHaveProperty('redactedFields');
  });

  test('echoes the mutationId on error and omits success-only optionals', () => {
    const reply = run(987_654);
    expect(reply.mutationId).toBe(987_654);
    expect(reply.error).toBe('mutation_not_found');
    expect(reply.content).toBe('');
    expect(reply.size).toBe(0);
    expect(reply.mtime).toBe(0);
    expect(reply).not.toHaveProperty('truncated');
    expect(reply).not.toHaveProperty('redactedFields');
  });

  test('surfaces redactedFields when the read masked content', () => {
    const id = seedMutationForFile('.env', 'SECRET=AKIAIOSFODNN7EXAMPLE\n');
    const reply = run(id);
    expect(reply.content).toBe('<redacted>');
    expect(reply.redactedFields).toEqual(['content']);
    expect(reply).not.toHaveProperty('error');
  });

  test('sets truncated:true for an oversized file', () => {
    const id = seedMutationForFile('big.log', 'a'.repeat(MAX_ARTIFACT_BYTES + 10));
    const reply = run(id);
    expect(reply.truncated).toBe(true);
    expect(reply.size).toBe(MAX_ARTIFACT_BYTES);
  });
});
