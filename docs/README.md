# docs/

Reference detail lifted out of [`CLAUDE.md`](../CLAUDE.md).

## The split, and why it is not a filing preference

`CLAUDE.md` is **always loaded**: the SDK reads it as project memory, the bus injects it
verbatim into every worker's and chain participant's first turn (`readProjectClaudeMd`),
and `scripts/lib/loop/build-system.md` orders every loop BUILD agent to read it. Nothing
under `docs/` is loaded by any of those — **both loaders read `CLAUDE.md` and stop**, so
a page here arrives only when a person opens it.

That makes the split a budget rather than a taste:

|          | goes in `CLAUDE.md`                                | goes in `docs/`                                |
| -------- | -------------------------------------------------- | ---------------------------------------------- |
| **What** | rules and hazards — what an agent must not violate | mechanism, history, measurement records        |
| **Test** | acting wrongly on it breaks something              | you would want it when changing this subsystem |
| **Cost** | paid on every worker, every run                    | paid only when opened                          |

Reference detail can move; the rules cannot. A wrong posture sentence is what an agent
reads and acts on, so it belongs in the file that always loads — that is the exposure
`#333` closed, and the reason the security-critical _claims_ stay put even where their
mechanism moves here.

Code comments follow the same rule one level down: the **why** at the point of decision,
plus JSDoc on exported symbols, stays in the file. A file-header essay about how the
subsystem came to be belongs on one of these pages, with a pointer where it was.

## Pages

| Page                                                           | Subject                                                                                                                                                                                                                                                                                                                                                        | Read before touching                                                                                  |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`bus-architecture.md`](bus-architecture.md)                   | core bus modules, what "install" writes, per-participant `settingSources`, `cebab_bus` MCP namespacing, server-restart resume (R-A/R-B)                                                                                                                                                                                                                        | `server/src/bus/`                                                                                     |
| [`safety-and-security.md`](safety-and-security.md)             | what actually gates a tool call (Trust, `settingSources`, `shouldAutoAllow`, the `seedPermissionMode` order), the consultant constraint and its two limits, the pause-on-dangerous gate, the hash-chained audit log, forensic snapshots, the TOFU install gate, operator mute/pause/kick, the Origin gate, the per-launch auth token, credential-env scrubbing | `server/src/notifications/`, `bus/pause_gate.ts`, `bus/install_trust_gate.ts`, `auth.ts`, `origin.ts` |
| [`managed-agents.md`](managed-agents.md)                       | the copy engine's symlink rule and size caps, the `.git` exclusion, credentials in the clear, the three editable config kinds, the delete's ordering                                                                                                                                                                                                           | `server/src/managed_*.ts`                                                                             |
| [`AUTONOMOUS_LOOP_SPEC.md`](AUTONOMOUS_LOOP_SPEC.md)           | the loop **driver**: stages, transitions, data formats, guard, usage limits                                                                                                                                                                                                                                                                                    | `scripts/loop.mjs`, `scripts/lib/loop/`                                                               |
| [`LOOP_DEVELOPMENT_STANDARD.md`](LOOP_DEVELOPMENT_STANDARD.md) | what a change the loop **produces** has to be: the four defect classes, what each gate tier can and cannot see, the revert-check                                                                                                                                                                                                                               | the loop's gate or its BUILD prompt                                                                   |

`BEADS_KANBAN_WORKFLOW.md` is gitignored — one developer's local issue-tracking setup,
not part of the project.

## Adding a page

Link it from the table above **and** from `CLAUDE.md`'s pointer list. A page nobody links
is a page nobody opens, which is the same as not writing it — and `CLAUDE.md`'s list is
the only index the always-loaded surface has.
