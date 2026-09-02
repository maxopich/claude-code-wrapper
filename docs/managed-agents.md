# Managed agents

Reference detail behind managed agents. The rules an
agent must not violate and points here for the mechanism. **Nothing under `docs/` is
auto-loaded** — neither the SDK's project-memory load nor the bus's `readProjectClaudeMd`
injection reads past `CLAUDE.md` — so this page arrives only when you open it.

What is here is mechanism and the measurements behind it. The rules that survive in
`CLAUDE.md` are the two that an agent could act wrongly on: **Cebab owns every byte under
`managedAgentsRoot()` and none outside it**, and **the wire carries a KIND, never a
path**. Everything below explains how those are enforced.

**Read before touching** `server/src/managed_agent.ts`, `managed_copy.ts`,
`managed_delete.ts`, `managed_file.ts`, or `repo/projects.ts`'s managed helpers.

## Contents

- [The two kinds of project](#the-two-kinds-of-project)
- [Editing a managed agent's config](#editing-a-managed-agents-config)
- [Why the edit is audited and the model choice is not](#why-the-edit-is-audited-and-the-model-choice-is-not)
- [Verifying an edit](#verifying-an-edit)
- [How "is this managed?" is answered](#how-is-this-managed-is-answered)
- [Why `.git` is excluded](#why-git-is-excluded)
- [Credentials, and why they are copied in the clear](#credentials-and-why-they-are-copied-in-the-clear)
- [The symlink rule](#the-symlink-rule)
- [Deleting a managed agent](#deleting-a-managed-agent)

## The two kinds of project

**Only one comes from the workspace scan** (`Cebab-ws0.9`). The scan is still the only way an _ordinary_ project appears — there is no `add_project` verb. A **managed agent** is the second kind: a full, independent recursive snapshot of a project at `<dataDir>/agents/<slug>/`, registered by `registerManagedProject` as an ordinary `projects` row, so Trust, the authority resolve, sessions and the bus work on it unchanged. Its `cwd` is inside the data dir, which is what makes "nothing lands in the operator's workspace" true for the single-agent path — `Cebab-ws0.8` did the bus half. A second copy of one project makes a SECOND managed agent (disambiguated `slug-2`), never an overwrite.

## Editing a managed agent's config

**Cebab WRITES into that tree as well as creating it** (`Cebab-ws0.10`). A managed agent's `.claude/settings.json`, `.mcp.json` and `CLAUDE.md` are editable from the app; an ordinary project offers no affordance at all, because Cebab owns every byte under `managedAgentsRoot()` and none outside it. **The wire carries a KIND, never a path** — `MANAGED_EDITABLE` in `managed_file.ts` is a closed set of three — so there is no traversal input to validate and no sanitiser to get wrong; `relPathIsContained` guards the CONSTANT against a future fourth entry, not a hostile request, and is tested directly for that reason. The editor shows **raw bytes**: `pathLooksSensitive` is true for two of the three files, so what is on screen is live credentials, and it says so rather than masking — a structured editor would reformat the file, reorder its keys and drop what it did not model, on files whose whole purpose is to be read by another program.

## Why the edit is audited and the model choice is not

**The asymmetry is the point.** A model choice cannot widen privilege; a `settings.json` edit can add hooks, MCP servers and env injections, which is a strictly larger authority change than the starting permission mode `Cebab-ws0.4` already audits. Audit-before-write, refused outright if the append fails, following `project_start_mode.ts`. The row carries the path, byte count, a sha256 and whether the file existed — **never the content**, since these are the files `Cebab-of0` closed a leak over. Reads are `readFileBounded`, never the prefix read: a truncated editor would silently drop the tail on the next save. Writes go through `writeFileAtomicBounded` (`safe_fs.ts`), whose temp-file-then-rename is not about tidiness — a rename REPLACES a symlink planted at the target instead of writing through it, which is the only way a write can answer the hazard the bounded reads answer by holding a descriptor.

## Verifying an edit

**Use `managed_file_smoke.ts`, not a read-back.** Reading it back proves only that Cebab can write a file, which would stay true if the bytes landed where the CLI never looks; the smoke probes the same project before and after, and the before-probe is what makes "present afterwards" mean anything.

## How "is this managed?" is answered

**By the PATH, never by a column.** `isManagedProjectPath` asks whether `projects.path` is inside `managedAgentsRoot()`; `managed_source_path` / `managed_copied_at` are provenance only. The distinction is load-bearing rather than stylistic: `syncWorkspaceProjects` soft-deletes any row the workspace scan did not see, and a managed row is _never_ in that scan — so managed rows need an exemption from that sweep, and every managed agent would otherwise be marked missing on the next `list_projects` (i.e. on every sidebar refresh). Key that exemption on a column and a hand-edited `managed_source_path` grants an ordinary project permanent immunity, while clearing it on a real managed agent sweeps it out from under a live directory. A managed agent whose directory the operator deleted by hand still _does_ go missing — each managed row answers for itself.

## Why `.git` is excluded

**It is what makes a managed agent uncommittable** (`Cebab-ws0.11`). Not a size optimisation: `gitignore(5)` consults parent ignore files only up to the top of the working tree, so a copied `.git` makes `<dataDir>/agents/<slug>/` its own working tree and `<dataDir>/.gitignore` — the bare `*` `ensureDataDir` writes — stops reaching inside it. The copy would also carry the source's remotes, so an agent running there could push into the operator's real repository. Excluding `.git` removes both at once. Matched by NAME at any depth (submodules have their own) and irrespective of kind, because `.git` is a regular FILE in a worktree or submodule holding a `gitdir:` pointer somewhere else entirely. `server/src/managed_copy.test.ts` pins the property from both sides: an outer `git add -A` stages nothing from the data dir, and `git rev-parse --show-toplevel` run inside a managed tree returns the outer repo rather than the copy.

## Credentials, and why they are copied in the clear

**Deliberately.** An encryption key that has to sit on the same disk as its ciphertext, readable by the same account, stops a casual grep and buys a key-management surface. What is done instead: the tree is 0700 and files matching `pathLooksSensitive` (exported from `shared/src/redact.ts` for this, and reused rather than restated) are written at exactly 0600 — which also strips a stray exec bit a plain `& 0o700` would keep; the preflight NAMES those files, paths only, since the predicate opens nothing; and a `chmod` that fails is reported as `permissions_unenforced` rather than swallowed. Note the ordering of importance: the 0700 TREE is what keeps other accounts out, and the per-file modes are defence in depth behind it.

## The symlink rule

**It is stricter than "don't follow symlinks"** (`managed_agent.ts`). `fsp.cp({ dereference: false })` satisfies that phrase and is wrong here: it recreates an escaping link faithfully, handing the managed agent a live path out of the space Cebab owns. So does an **absolute** link that resolves _inside_ the source — recreated verbatim it still names the SOURCE after the copy. Only relative links resolving inside-or-at the source root are recreated; everything else is skipped and reported. Directory links are never descended, which is also the loop guard. Measured caps (5 GB / 300k files) are a backstop, not the decision: the operator sees a preflight measured by the _same traversal the copy uses_ and confirms. The copy is `fs.promises` throughout — a synchronous copy of the gigabyte-scale trees this deliberately includes would park the event loop for minutes.

**The supported Node floor is declared, and `npm` now enforces it** (`Cebab-mfvu`). `package.json` gained `engines.node: ">=24.0.0"` and `.npmrc` gained `engine-strict=true`, and the second is what makes the first do anything: without it a dependency whose own `engines.node` excludes the running Node installs anyway — npm prints `npm warn EBADENGINE` and exits 0. Measured both directions. This is not hygiene, it is a defect class: two Dependabot majors (jsdom 30, better-sqlite3 13) both dropped Node 20 in their `engines`, CI was still on Node 20 (v20.20.2, itself EOL since 2026-04-30), npm installed them regardless, and the failure surfaced eighty seconds later as 230 runtime `TypeError: webidl.util.markAsUncloneable is not a function` and a wall of dead vitest workers — symptoms that read like code defects. The information was present at install time, as a warning. CI moved to Node 24 in the same change; the two `setup-node` sites and the `engines` floor are kept in lockstep and `ci.yml` says so. Cost of the strictness, measured against the tree: of 233 packages declaring `engines.node`, **zero** would block an install on Node 24 or 26 — one would on Node 20 (`lint-staged`, already silently unsupported there). Adding a dependency that needs a newer runtime is now an install-time refusal naming the package, the required range and the actual version.

## Deleting a managed agent

`managed_delete.ts`. The copy duplicates operator data; the delete DESTROYS it — the
agent's tree, its sessions, its events and its per-session JSONL logs, none of which come
back. So the same audit-before-act gate the copy uses is if anything more load-bearing
here, and the same refusal applies: **a failed audit append aborts with nothing removed.**

Three questions the design had to settle:

- **Sessions and events go.** A managed agent is an ordinary `projects` row and
  `sessions.project_id REFERENCES projects(id) ON DELETE CASCADE`, so removing the row
  already destroys its conversations. "Mark it missing" would leave a row pointing at a
  directory that is gone — a dead agent in the sidebar forever. An explicit operator
  delete is not the ambiguous case (a directory that vanished from under Cebab); it is
  the operator saying they are done with this agent.
- **The per-session JSONL logs need enumerating first.** They live under
  `<dataDir>/logs/<id>.jsonl`, keyed by SESSION id rather than by project, so no cascade
  reaches them — they have to be removed by listing the project's sessions while the rows
  still exist to name them. Best-effort, exactly as the session purge treats them: a
  stray unlink failure must not strand the database delete that is the real state.
- **The audit comes first**, per BE-1.

**The tree comes out before any DB write, and the order is deliberate.**
`removeManagedDir` is idempotent (`force: true`) and by far the most likely step to
fail — a recursive delete of a gigabyte-scale tree can hit `EBUSY`/`EACCES` where a
single `DELETE` cannot. Doing it first and gating on its success means a failure leaves
the DATABASE fully intact and the operation retryable: the sidebar row is still there,
and a retry re-enters and finishes the partially-removed tree off. The reverse order
risks the one outcome that has no recovery — a row left pointing at nothing.

**Two independent containment checks.** `isManagedProjectPath` refuses an ordinary
workspace project outright (its directory is the operator's, and its row would reappear
on the next scan anyway), and `removeManagedDir` re-checks containment itself. The
destructive step is guarded twice by code that does not share a path.

**Refused while anything is running.** `snapshotInFlight()` covers bus runs too, since
their `agent_activity` carries a `projectId` — deleting the tree and rows out from under
a live turn would leave the run writing into freed state.
