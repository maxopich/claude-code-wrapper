import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { listProjects, upsertProject, type ProjectRow } from "./repo/projects.js";

/** Scan WORKSPACE_ROOT for project subdirectories and upsert them into the DB. */
export function syncWorkspaceProjects(): ProjectRow[] {
  if (!fs.existsSync(config.workspaceRoot)) {
    fs.mkdirSync(config.workspaceRoot, { recursive: true });
  }
  for (const entry of fs.readdirSync(config.workspaceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(config.workspaceRoot, entry.name);
    upsertProject(entry.name, full);
  }
  return listProjects();
}

export function rowToProject(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    trusted: row.trusted === 1,
    lastUsedAt: row.last_used_at,
  };
}
