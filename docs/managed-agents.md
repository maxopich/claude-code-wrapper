# Managed agents

Reference detail behind managed agents. **Nothing under `docs/` is auto-loaded** — the
SDK's project-memory load and the bus's `readProjectClaudeMd` injection both read a
project's own root `CLAUDE.md` and stop there — so this page arrives only when you open
it.

What is here is mechanism and the measurements behind it. The two rules an agent could act
wrongly on are stated where they cannot be missed — in the always-loaded `CLAUDE.md`, and
repeated here so a reader of this page alone has them: **Cebab owns every byte under
`managedAgentsRoot()` and none outside it**, and **the wire carries a KIND, never a path**
(`MANAGED_EDITABLE` in `managed_file.ts` is a closed set of four fixed literals, so there is
no traversal input to validate). Everything below explains how those are enforced. Note this page used
to send the reader to `SECURITY.md` for them; that file states Cebab's runtime posture and
threat model and has never carried these two.

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
- [When an incomplete copy refuses to register](#when-an-incomplete-copy-refuses-to-register)
- [Where the copy is allowed to write](#where-the-copy-is-allowed-to-write)
- [The supported Node floor](#the-supported-node-floor)
- [Deleting a managed agent](#deleting-a-managed-agent)

## The two kinds of project

**Only one comes from the workspace scan** (`Cebab-ws0.9`). The scan is still the only way an _ordinary_ project appears — there is no `add_project` verb. A **managed agent** is the second kind: a full, independent recursive snapshot of a project at `<dataDir>/agents/<slug>/`, registered by `registerManagedProject` as an ordinary `projects` row, so Trust, the authority resolve, sessions and the bus work on it unchanged. Its `cwd` is inside the data dir, which is what makes "nothing lands in the operator's workspace" true for the single-agent path — `Cebab-ws0.8` did the bus half. A second copy of one project makes a SECOND managed agent (disambiguated `slug-2`), never an overwrite.

## Editing a managed agent's config

**Cebab WRITES into that tree as well as creating it** (`Cebab-ws0.10`). A managed agent's `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json` and `CLAUDE.md` are editable from the app; an ordinary project offers no affordance at all, because Cebab owns every byte under `managedAgentsRoot()` and none outside it. **The wire carries a KIND, never a path** — `MANAGED_EDITABLE` in `managed_file.ts` is a closed set of four fixed literals — so there is no traversal input to validate and no sanitiser to get wrong; `relPathIsContained` guards the CONSTANT against a future fifth entry, not a hostile request, and is tested directly for that reason. `settings.local.json` is the fourth kind (`Cebab-6fax.43.1`): it was excluded at first, but the copy engine duplicates it and Trust LOADS it, so it is the one copied file that can change the agent's posture (hooks, MCP servers, env) while being the one the operator cannot otherwise see or edit — added by decision, as a literal, never a `settings*.json` glob. The set grows by decision, never by mechanism: re-read `Cebab-6fax.43.1` before proposing a fifth. The editor shows **raw bytes**: `pathLooksSensitive` is true for all but `CLAUDE.md`, so what is on screen is live credentials, and it says so rather than masking — a structured editor would reformat the file, reorder its keys and drop what it did not model, on files whose whole purpose is to be read by another program. After a save on an **untrusted** agent the editor says the file loads in its chats only once the agent is Trusted: managed copies start untrusted, and an untrusted agent's chats read none of these files.

## Why the edit is audited and the model choice is not

**The asymmetry is the point.** A model choice cannot widen privilege; a `settings.json` or `settings.local.json` edit can add hooks, MCP servers and env injections, which is a strictly larger authority change than the starting permission mode `Cebab-ws0.4` already audits. Audit-before-write, refused outright if the append fails, following `project_start_mode.ts`. The row carries the path (home-collapsed to `~/…` at the append site since `Cebab-6fax.43.5`), byte count, a sha256 and whether the file existed — **never the content**, since these are the files `Cebab-of0` closed a leak over. Reads are `readFileBounded`, never the prefix read: a truncated editor would silently drop the tail on the next save. Writes go through `writeFileAtomicBounded` (`safe_fs.ts`), whose temp-file-then-rename is not about tidiness — a rename REPLACES a symlink planted at the target instead of writing through it, which is the only way a write can answer the hazard the bounded reads answer by holding a descriptor.

## Verifying an edit

**Use `managed_file_smoke.ts`, not a read-back.** Reading it back proves only that Cebab can write a file, which would stay true if the bytes landed where the CLI never looks; the smoke probes the same project before and after, and the before-probe is what makes "present afterwards" mean anything.

## How "is this managed?" is answered

**By the PATH, never by a column.** `isManagedProjectPath` asks whether `projects.path` is inside `managedAgentsRoot()`; `managed_source_path` / `managed_copied_at` are provenance only. The distinction is load-bearing rather than stylistic: `syncWorkspaceProjects` soft-deletes any row the workspace scan did not see, and a managed row is _never_ in that scan — so managed rows need an exemption from that sweep, and every managed agent would otherwise be marked missing on the next `list_projects` (i.e. on every sidebar refresh). Key that exemption on a column and a hand-edited `managed_source_path` grants an ordinary project permanent immunity, while clearing it on a real managed agent sweeps it out from under a live directory. A managed agent whose directory the operator deleted by hand still _does_ go missing — each managed row answers for itself.

## Why `.git` is excluded

**It is what makes a managed agent uncommittable** (`Cebab-ws0.11`). Not a size optimisation: `gitignore(5)` consults parent ignore files only up to the top of the working tree, so a copied `.git` makes `<dataDir>/agents/<slug>/` its own working tree and `<dataDir>/.gitignore` — the bare `*` `ensureDataDir` writes — stops reaching inside it. The copy would also carry the source's remotes, so an agent running there could push into the operator's real repository. Excluding `.git` removes both at once. Matched by NAME at any depth (submodules have their own) and irrespective of kind, because `.git` is a regular FILE in a worktree or submodule holding a `gitdir:` pointer somewhere else entirely. `server/src/managed_copy.test.ts` pins the property from both sides: an outer `git add -A` stages nothing from the data dir, and `git rev-parse --show-prefix` run inside a managed tree returns a NON-EMPTY prefix — i.e. "inside some repo, not the top of one" — with the enclosing repo asserted empty as the anti-vacuity control. Deliberately not `--show-toplevel`: comparing that against a path went red on Windows only, where `os.tmpdir()` hands back the 8.3 short name and git returns the long one.

## Credentials, and why they are copied in the clear

**Deliberately.** An encryption key that has to sit on the same disk as its ciphertext, readable by the same account, stops a casual grep and buys a key-management surface. What is done instead: the tree is 0700 and files matching `pathLooksSensitive` (exported from `shared/src/redact.ts` for this, and reused rather than restated) are written at exactly 0600 — which also strips a stray exec bit a plain `& 0o700` would keep; every other file keeps its OWNER bits (`entry.mode & 0o700`), so group and other are stripped and nothing the source could not do becomes possible in the copy; the preflight NAMES the credential files, paths only, since the predicate opens nothing; and a `chmod` that fails is reported as `permissions_unenforced` rather than swallowed. Note the ordering of importance: the 0700 TREE is what keeps other accounts out, and the per-file modes are defence in depth behind it.

## Why an ordinary file keeps its owner-exec bit

**Because a copied project's hooks and MCP servers are SPAWNED, not read** (`Cebab-6fax.43.2`). A uniform-0600 copy was specified, built and then closed unmerged, on two measurements taken against the bundled CLI:

- **0600 stops them running.** Shell-form hooks go through `/bin/sh -c` and survive, but an exec-form hook and a stdio MCP server are executed directly. A `SessionStart` hook at `"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh` failed at 0600 with **exit 126** (the 0700 control ran), and an `.mcp.json` server `./bin/server` at 0600 came up `failed` (the 0700 control `connected`; `node bin/server` at 0600 also `connected`, since there the interpreter is what gets executed). Exit 126 is **non-blocking**, so a `PreToolUse` guard hook invoked by path would stop blocking and **fail open** — and a managed copy is trusted or not like any other project, so on a **trusted** one this lands on single-agent turns and on every bus hop alike (`Cebab-6fax.21.1`).
- **Nothing downstream was undoing an exec bit.** `hardenDataDir` skips any file with no group/other bits at all (`GROUP_OTHER_MASK = 0o077`), so a 0700 file is left exactly as it is. The sweep is not a backstop for a uniform-0600 rule and never contradicted the copy; the guarantee it and the copy share is **owner-only access behind the 0700 tree**, not 0600.

So the two branches are deliberate and each is pinned from both sides in `server/src/managed_agent.test.ts`: a 0755 `run.sh` lands at 0700, a plain source file at 0600, and a 0755 `.env` at 0600 — the last being the case a bare `& 0o700` gets wrong. A change that "tidies" the copy to one mode reddens there rather than silently breaking every hook in every managed copy.

## The symlink rule

**It is stricter than "don't follow symlinks"** (`managed_agent.ts`). `fsp.cp({ dereference: false })` satisfies that phrase and is wrong here: it recreates an escaping link faithfully, handing the managed agent a live path out of the space Cebab owns. So does an **absolute** link that resolves _inside_ the source — recreated verbatim it still names the SOURCE after the copy. Only relative links resolving inside-or-at the source root are recreated; everything else is skipped and reported. Directory links are never descended, which is also the loop guard. Measured caps (5 GB / 300k files) are a backstop, not the decision: the operator sees a preflight measured by the _same traversal the copy uses_ and confirms. The copy is `fs.promises` throughout — a synchronous copy of the gigabyte-scale trees this deliberately includes would park the event loop for minutes.

## When an incomplete copy refuses to register

**A copy that lost real content is not registered** (`Cebab-6z6a`). `copyTree`
tolerates a per-entry error and records it as a `copy_failed` (or
`unreadable_dir`) skip rather than throwing — the fix `Cebab-ygu.14`/`.13` made
so one churning cache file could not discard a multi-gigabyte copy. The cost of
that tolerance is that a copy which lost genuine content still returns
`ok`-shaped, and registering it hands the operator a managed agent that "looks
configured and is not". So `runManagedCopy` inspects the skip list before
`registerManagedProject` and refuses two cases, removing the incomplete tree
exactly as the partial-throw path does:

- **A credential or settings file did not arrive.** Any skip whose reason is in
  `MISSING_REASONS` (`copy_failed`, `unreadable_dir`) and whose path is one of
  the agent's own config files: root `.env` / `.env.*`, `.mcp.json`,
  `.claude/settings.json`, `.claude/settings.local.json`, or anything under a
  root `.ssh/`. A missing one of those is what makes an agent silently
  mis-configured rather than merely incomplete.

  **Not `pathLooksSensitive`, and the difference is the point.** That predicate
  is the redactor's, and its header states the rule it is built on: a false
  negative leaks a credential, so it errs wide — any basename whose stem is
  `token`, `secret`, `credentials`, `key` or `pem`, and anything under a
  credential-looking directory. Measured, it matches `src/token.ts`,
  `lib/secret.js`, `ui/Secret.tsx`, `docs/token.md`, `design/Deck.key`,
  `test/fixtures/server.pem` and `node_modules/marked/lib/token.js`. Erring wide
  is right for redaction and wrong for a rule that DELETES a finished copy: one
  transient failure on an ordinary source file with an unlucky name would
  discard the whole tree, which is the class `Cebab-ygu.14` closed — and
  `node_modules`, which the copy deliberately includes, is where that churn
  happens. The list above is explicit and root-anchored for that reason, and
  widening it is a decision rather than a refactor. A control pins it: a copy
  that loses `src/token.ts` and `node_modules/marked/token.js` still registers,
  with both skips reported.

- **A systemic failure.** The source had files but essentially none arrived
  (`survey.files > 0 && copied.files === 0`), or the failures outnumber what was
  written (`missing.length > copied.files`) — the shape an ENOSPC/EACCES on the
  target leaves, as opposed to one transient per-file error. The two clauses
  catch different things and each is pinned alone: the first is the only one
  that fires when nothing arrived and nothing was recorded as a failure, the
  second the only one that fires when some of the tree did arrive.

What is deliberately NOT grounds for refusal: `permissions_unenforced` (the file
arrived; only its mode is loose), the policy skips `excluded_vcs` /
`symlink_escapes` / `not_regular` (chosen omissions the preflight already named —
refusing on `.git`'s `excluded_vcs` would make every git repo uncopyable), and
`symlink_unsupported` (an intra-tree link whose target is a real file copied
elsewhere in the tree). A benign non-sensitive `copy_failed` among healthy files
still registers with the skip reported, which is the `Cebab-ygu.14` behaviour the
refusal must not undo — pinned by an anti-vacuity control in
`managed_copy.test.ts`.

## Where the copy is allowed to write

**`copyTree` enforces its own containment and cap, not just the caller's** (`Cebab-6fax.43.4`, `Cebab-ygu.16`). The survey's caps run _before_ `claimManagedDir` creates the target, so they cannot see two hazards: a tree that grew between the estimate and the copy, and a target that lies inside its own source. So `copyTree` refuses two things itself, against paths resolved with `realpath` first — a resolution failure is a **refusal**, never a fallback to the raw path, which would defeat the check it is part of:

- **A target not strictly inside `managedAgentsRoot()`.** A copy can only ever write bytes into the space Cebab owns; that is the one sentence the whole design rests on.
- **A source that is the target or an ANCESTOR of it.** This is the self-recursive copy of `Cebab-ygu.16`: a data dir nested inside a workspace project (a shape `workspace.ts` cannot refuse) makes the managed target a descendant of the source, and the walk would then read the directory it is filling and re-copy its own output one level deeper each pass.

**One resolver for the whole copy, and it must be.** Containment, `copyTree`'s walk root, and `walkTree`'s per-link "does this symlink escape?" comparison all resolve through the same `canonical` = JS `fs.realpathSync`. That call follows symlinks but does **not** restore on-disk letter case (macOS) or 8.3 short names (Windows) — the native `fs.realpathSync.native` / `fsp.realpath` do. An earlier attempt (PR #599) took the walk root from the native realpath while the per-link check used `canonical`; the two then disagreed about the same path, and every in-tree symlink under a mixed-case source was dropped as `symlink_escapes` while the preflight promised to recreate it — a red on exactly the two symlink-control tests on Windows CI. `assertCopyContained` returns its resolved source so the walk reuses it, so there is one resolution and no second function to drift.

**And the cap is re-checked BEFORE each write** (`result.files + 1`, `result.bytes + entry.size`), so one oversized file never lands. A copy that outgrows the survey's measurement throws from within; the caller's catch removes the partial target, because a copy larger than what was measured is not the snapshot it claims to be.

## The supported Node floor

**It is declared, and `npm` now enforces it** (`Cebab-mfvu`). `package.json` gained `engines.node: ">=24.0.0"` and `.npmrc` gained `engine-strict=true`, and the second is what makes the first do anything: without it a dependency whose own `engines.node` excludes the running Node installs anyway — npm prints `npm warn EBADENGINE` and exits 0. Measured both directions. This is not hygiene, it is a defect class: two Dependabot majors (jsdom 30, better-sqlite3 13) both dropped Node 20 in their `engines`, CI was still on Node 20 (v20.20.2, itself EOL since 2026-04-30), npm installed them regardless, and the failure surfaced eighty seconds later as 230 runtime `TypeError: webidl.util.markAsUncloneable is not a function` and a wall of dead vitest workers — symptoms that read like code defects. The information was present at install time, as a warning. CI moved to Node 24 in the same change; the two `setup-node` sites and the `engines` floor are kept in lockstep and `ci.yml` says so. Cost of the strictness, measured against the tree: of 233 packages declaring `engines.node`, **zero** would block an install on Node 24 or 26 — one would on Node 20 (`lint-staged`, already silently unsupported there). Adding a dependency that needs a newer runtime is now an install-time refusal naming the package, the required range and the actual version.

## Deleting a managed agent

`managed_delete.ts`. The copy duplicates operator data; the delete DESTROYS it — the
agent's tree, its sessions, its events and its per-session JSONL logs, none of which come
back. So the same audit-before-act gate the copy uses is if anything more load-bearing
here, and the same refusal applies: **a failed audit append aborts with nothing removed.**

Three questions the design had to settle:

- **Sessions and events go.** A managed agent is an ordinary `projects` row and
  `sessions.project_id REFERENCES projects(id) ON DELETE CASCADE`, so removing the row
  already destroys its Cebab-side conversation records. "Mark it missing" would leave a row pointing at a
  directory that is gone — a dead agent in the sidebar forever. An explicit operator
  delete is not the ambiguous case (a directory that vanished from under Cebab); it is
  the operator saying they are done with this agent.
- **The per-session JSONL logs need enumerating first.** They live under
  `<dataDir>/logs/<id>.jsonl`, keyed by SESSION id rather than by project, so no cascade
  reaches them — they have to be removed by listing the project's sessions while the rows
  still exist to name them. Best-effort, exactly as the session purge treats them: a
  stray unlink failure must not strand the database delete that is the real state.
- **The audit comes first**, per BE-1.

**What the delete does NOT remove.** The CLI's own transcripts of this agent's sessions,
at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` — a full, unredacted copy of every
conversation, keyed by the agent's cwd under `<dataDir>/agents/<slug>/`. That tree belongs
to the `claude` CLI and sits outside `managedAgentsRoot()`, so `runManagedDelete` leaves it
alone on purpose: the boundary that makes "Cebab owns every byte under
`managedAgentsRoot()` and none outside it" true is the same boundary that keeps a delete
out of `~/.claude`. `Cebab-6fax.44.1` settled this for session delete and the 7-day purge;
`Cebab-0dv9` applied the same answer here. The remedy is the accurate sentence at the point
of deletion, not a cross-boundary delete — so the modal and the sidebar tooltip name the
location and say Cebab does not touch it, and the operator can remove it themselves.

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

**Refused while anything is running.** Deleting the tree and rows out from under a live
turn would leave the run writing into freed state. Two signals answer "is anything live",
because they see different things. `snapshotInFlight()` is the per-HOP Query registry —
it catches a single-agent turn and a bus participant whose turn is executing _at that
instant_, but a bus run between hops — routing, or a paused agent — has no in-flight query
and slips past it (`Cebab-bxi0`). Not an `AskUserQuestion` park: that one waits _inside_
the turn, so the query is still registered and the per-hop signal does see it. So the
guard also refuses when the project takes part in a session `hasLiveSession()` reports as
genuinely live in this process — a signal that holds for the run's whole lifetime, not
just mid-hop. A stale `running` DB row left by a dead process is absent from that
in-process map, so the refusal is scoped to a truly live run; a stranded row is instead
ended by the end-the-stranded-row loop further down `managed_delete.ts` (`Cebab-6fax.33`),
which flips it to `stopped`.

**The reopen flow used to leave a live orphan** (`Cebab-1tty`, `Cebab-r833`). The
in-process map is cleared only by a router's teardown, and the reopen flow originally
displaced the active run with a bare `detachCurrentActive()` sink swap — the row then read
`crashed` (the UI says **failed**) while the registry still held the session, so a delete
refused on a run the operator believed was over and `Stop` no-op'd on it. Reopen now runs a
real `stop('crashed')` teardown on each displaced session, and it resolves the displaced set
**process-wide** via `listLiveSessionIds()` rather than from the reopening connection's own
`conn.multiAgent`, so a run that is live on a _different_ connection is stopped and
unregistered too instead of surviving beside the reopened target. The stop runs before the
connection's own sink is detached, so the displaced run's `multi_agent_ended` still
broadcasts to every window.
