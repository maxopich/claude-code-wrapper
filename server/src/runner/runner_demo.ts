// One-shot SDK runner demo. Now persists to DB + JSONL.
// Run: npm --workspace server exec tsx src/runner/runner_demo.ts -- "<prompt>" [cwd]
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pickRunner } from './index.js';
import { persistMessage } from './orchestrator.js';
import { config } from '../config.js';
import { upsertProject } from '../repo/projects.js';
import { createSession } from '../repo/sessions.js';
import { countEvents } from '../repo/events.js';
import { closeLogger } from './logger.js';
import { closeDb } from '../db.js';

async function main() {
  const prompt = process.argv[2] ?? 'say hi in 5 words';
  const cwd = path.resolve(process.argv[3] ?? process.cwd());
  const projectName = path.basename(cwd);
  const project = upsertProject(projectName, cwd);
  const sessionId = randomUUID();
  createSession(sessionId, project.id);

  console.error(`[demo] mock=${config.mock} project=${project.name} (id=${project.id})`);
  console.error(`[demo] sessionId=${sessionId}`);
  console.error(`[demo] cwd=${cwd}`);
  console.error(`[demo] prompt=${JSON.stringify(prompt)}`);
  console.error('---');

  const q = pickRunner({
    cwd,
    prompt,
    sessionId,
    includePartialMessages: false,
    canUseTool: async (toolName) => ({
      behavior: 'deny',
      message: `demo runner denies all tools (${toolName})`,
    }),
  });

  for await (const msg of q) {
    const seq = persistMessage(sessionId, msg);
    if (msg.type === 'system' && msg.subtype === 'init') {
      console.error(
        `[#${seq} init] model=${msg.model} apiKeySource=${msg.apiKeySource} tools=${msg.tools.length}`,
      );
    } else if (msg.type === 'assistant') {
      const text = msg.message.content
        // Annotate explicitly: SDK ≥0.3.201 widened `content`'s element type,
        // so an unannotated `b` is now an implicit-any (TS7006). This block
        // only reads `.type` / `.text`, so a structural type is enough and
        // stays valid across SDK versions.
        .map((b: { type: string; text?: string }) => (b.type === 'text' ? b.text : `[${b.type}]`))
        .join(' ');
      console.error(`[#${seq} assistant] ${text}`);
    } else if (msg.type === 'result') {
      console.error(
        `[#${seq} result] subtype=${msg.subtype} cost=$${msg.total_cost_usd.toFixed(6)}`,
      );
    } else {
      console.error(`[#${seq} ${msg.type}]`);
    }
  }

  console.error('---');
  console.error(`[demo] persisted ${countEvents(sessionId)} events`);
  closeLogger(sessionId);
  closeDb();
}

main().catch((err) => {
  console.error('[demo] error', err);
  process.exit(1);
});
