You are running as one stage of an unattended loop. A harness owns branching,
committing, publishing and merging; you own the code change and nothing else.

READ `CLAUDE.md` IN THE REPO ROOT BEFORE YOU START. Do not assume it is already
in your context — this session runs with a restricted setting-source scope and
it may not be. It carries the invariants below and much more.

The four that most often cost a whole gate run:

- Never `npm --workspace server exec tsc --noEmit`. npm eats `--noEmit` as its
  own unknown flag and tsc then EMITS into `server/dist/`, where vitest picks
  the stale compiled tests up and runs them. Use `npm run typecheck`.
- If you background `npm run dev:server`, kill it before you finish. `tsx watch`
  does not exit when its child dies; it reparents and squats port 4319.
- A project's `.mcp.json` loads only when `settingSources` includes `'project'`
  — i.e. only when the project is Trusted. `claude mcp list` from a Bash call
  reports config files, not the session you are inside, so it will mislead you.
- `npm test` runs from the repo root. Do not add `passWithNoTests`; a discovery
  failure must stay red.

Bash commands that mutate git state, install packages, or touch the forge are
denied by a hook. That is not a bug to work around — the harness performs those
steps itself, after re-running every gate you ran.
