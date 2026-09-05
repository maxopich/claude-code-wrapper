# docs/

How Cebab works underneath — the mechanism behind the claims in
[`README.md`](../README.md) and [`SECURITY.md`](../SECURITY.md).

## What belongs here

These pages are **reference**: mechanism, the measurements behind a design, and the
history that explains why something is shaped the way it is. They are read on demand,
by someone about to change the subsystem they describe.

What does NOT belong here is the rule itself. A statement someone acts on — a security
posture, a constraint on what a component may do — belongs where it cannot be missed:
in the code at the point of decision, in `SECURITY.md`, or in the module's own JSDoc.
Reference detail can move; the rules cannot. `scripts/busSafetyClaims.test.mjs` scans
these pages along with `README.md` and `SECURITY.md`, and fails the build when any of
them describes a posture the code no longer has.

Code comments follow the same split one level down: the **why** at the point of
decision, plus JSDoc on exported symbols, stays in the file. A file-header essay about
how the subsystem came to be belongs on one of these pages, with a pointer where it was.

That split is about KIND, not volume, and the difference is worth a number because the
volume looks alarming without one. Measured 2026-09-05 across the 674 tracked `.ts`/`.tsx`
files under `server/src`, `web/src` and `shared/src`: **52,070 comment-only lines, 26.9%
of every line in the tree**. Almost all of it is the kind that stays — `shared/src/protocol.ts`
is 69% comment, and what that buys is a per-message contract on each wire type, listing
its validation, its side effects and the conditions it rejects under, on the declaration
someone implementing a handler is already looking at. The kind this page asks for is
file-header essays, and they are **2,333 lines across 59 files — 4.5% of the total**, none
longer than 65 lines. So the migration this section describes is mostly already how the
tree is written; what is left is small, and each case is a judgement rather than a sweep.

## Pages

| Page                                               | Subject                                                                                                                                                                                                                                                                                                                                                        | Read before touching                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`bus-architecture.md`](bus-architecture.md)       | core bus modules, what "install" writes, per-participant `settingSources`, `cebab_bus` MCP namespacing, server-restart resume (R-A/R-B)                                                                                                                                                                                                                        | `server/src/bus/`                                                                                     |
| [`safety-and-security.md`](safety-and-security.md) | what actually gates a tool call (Trust, `settingSources`, `shouldAutoAllow`, the `seedPermissionMode` order), the consultant constraint and its two limits, the pause-on-dangerous gate, the hash-chained audit log, forensic snapshots, the TOFU install gate, operator mute/pause/kick, the Origin gate, the per-launch auth token, credential-env scrubbing | `server/src/notifications/`, `bus/pause_gate.ts`, `bus/install_trust_gate.ts`, `auth.ts`, `origin.ts` |
| [`managed-agents.md`](managed-agents.md)           | the copy engine's symlink rule and size caps, the `.git` exclusion, credentials in the clear, the three editable config kinds, the delete's ordering                                                                                                                                                                                                           | `server/src/managed_*.ts`                                                                             |
| [`source-gates.md`](source-gates.md)               | the 24 source-scanning gates in `scripts/` — what each protects, the five ways one fails vacuously, why a cross-package gate cannot live inside a package                                                                                                                                                                                                      | `scripts/*.test.mjs`, or adding any new gate                                                          |

## Adding a page

Link it from the table above, and from the module it describes — a header comment
naming the page is what makes someone editing that code open it. A page nobody links to
is a page nobody opens, which is the same as not writing it.
`scripts/docsIndex.test.mjs` enforces that in both directions: an unlinked page fails, and
so does a link to a page that left. Its corpus is `git ls-files docs`, not the directory —
[`source-gates.md`](source-gates.md) explains why that distinction is the whole design.
