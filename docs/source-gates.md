# Source-scanning gates

Twenty-five files in [`scripts/`](../scripts) — 5,814 lines, 346 vitest cases — read this
repo's own source as text and assert something about it. They are not unit tests of a
module; they are checks on the shape of the tree. This page says what they protect, the
ways they fail, and what to do before adding another.

Read it before writing a new gate, and before "simplifying" one that looks redundant.
Several of them exist precisely because something looked redundant.

## Why the repo has them at all

Each catches a defect class that nothing else in the build can see.

**Prose that outlives the code.** A comment, a doc, or a workflow keeps asserting a
posture the code no longer has. Nothing fails, because nothing executes a sentence. The
documented history is that one false claim about the bus's permission posture sat in six
tracked files and was corrected one at a time, so each fix left the others standing —
including `scripts/audit-gate.mjs`, which cited a file that by then said the opposite.
[`busSafetyClaims.test.mjs`](../scripts/busSafetyClaims.test.mjs) is the answer to that.

**A convention no type can express.** "This name is declared in exactly one package."
"This port has one definition." "An exported predicate returns `boolean`." A second copy
typechecks, lints and runs; it just re-opens the hazard the first fix closed.

**A configuration whose entire value is its scope.** A gitleaks allow-list, a `files:`
glob in the ESLint config, the `types: []` in `web/tsconfig.json`. Widen any of them and
every test still passes — the check simply stops covering anything. This is the most
dangerous class, because the symptom of the regression is a faster, greener build.

## The catalogue

### Gates over product source

| Gate                                                                       | Asserts                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [`sharedIsOneHome`](../scripts/sharedIsOneHome.test.mjs)                   | no name declared in `shared/src` is declared again in `server/src` or `web/src`, or twice within itself |
| [`defaultPortSingleSource`](../scripts/defaultPortSingleSource.test.mjs)   | `DEFAULT_PORT` in `shared/src/net.ts` is the only definition of 4319; seven named consumers import it   |
| [`predicateReturns`](../scripts/predicateReturns.test.mjs)                 | every exported `is`/`has`/`can`/`should` function declares `boolean` or a type predicate                |
| [`exportConsumers`](../scripts/exportConsumers.test.mjs)                   | every value export of four watched modules carries a verdict — provably imported, or a written reason   |
| [`redactRegexBounded`](../scripts/redactRegexBounded.test.mjs)             | the credential-scanning regex in `shared/src/redact.ts` has no unbounded `*`/`+`                        |
| [`controlReasonVocabulary`](../scripts/controlReasonVocabulary.test.mjs)   | the three control-verb modals share one reason vocabulary and declare none of their own                 |
| [`sideChannelSeamStability`](../scripts/sideChannelSeamStability.test.mjs) | App.tsx's two WS side-channel callbacks stay `useCallback`-wrapped with ref-only bodies                 |
| [`optimisticSends`](../scripts/optimisticSends.test.mjs)                   | every operator-decision send routes through `sendThenApply`, with the dispatch inside its apply         |
| [`devOrigins`](../scripts/devOrigins.test.mjs)                             | an origin is trusted only where Cebab binds the port or a launcher declares it                          |

### Gates over configuration

| Gate                                                             | Asserts                                                                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`scopedChecks`](../scripts/scopedChecks.test.mjs)               | four config surfaces keep their scope: gitleaks paths, the server tsconfig split, CI format, lint-staged   |
| [`workflowPermissions`](../scripts/workflowPermissions.test.mjs) | every workflow declares `permissions: {}` at top level, a per-job block, and SHA-pinned `uses:`            |
| [`configSurfaceClaims`](../scripts/configSurfaceClaims.test.mjs) | the published env knobs, the project MCP path and the Windows CI image match the code                      |
| [`osvAllowlist`](../scripts/osvAllowlist.test.mjs)               | `osv-scanner.toml`'s self-declared count is right, every excuse names a fixed version, no id repeats       |
| [`semgrepRules`](../scripts/semgrepRules.test.mjs)               | every custom semgrep rule carries both a `ruleid` and an `ok` fixture, and no annotation is orphaned       |
| [`reactHooksLint`](../scripts/reactHooksLint.test.mjs)           | the two `react-hooks` rules can actually fire under the real `eslint.config.js`                            |
| [`devBins`](../scripts/devBins.test.mjs)                         | `npm run dev` resolves the two binaries it spawns, from the workspace that declares them                   |
| [`verifyNativeBinary`](../scripts/verifyNativeBinary.test.mjs)   | the native-binary hash check's decision table, aimed at the ways it could report OK having checked nothing |
| [`pr-label-gate`](../scripts/pr-label-gate.test.mjs)             | the fixture-review job fails **closed** when the labeller that feeds it did not succeed                    |
| [`docsIndex`](../scripts/docsIndex.test.mjs)                     | `docs/README.md` links every page that ships, and nothing else                                             |

### Gates over prose

[`busSafetyClaims`](../scripts/busSafetyClaims.test.mjs) is the only one, and it is
`[security]`-tagged. It reads the bus's real posture out of `server/src/bus/runner.ts`,
then scans every tracked artifact — source, docs, migrations, workflows — for the three
superseded claims. It is also the only thing asserting that
[`safety-and-security.md`](safety-and-security.md) still carries the five single-agent
posture claims that moved out of the untracked `CLAUDE.md`.

### The gates' own machinery

[`stripCommentsConformance`](../scripts/stripCommentsConformance.test.mjs) pins the three
`stripComments` implementations byte-identical and sweeps for a fourth.
[`audit-gate.mjs`](../scripts/audit-gate.mjs) and
[`security-test-gate.mjs`](../scripts/security-test-gate.mjs) are the two gates CI runs
directly rather than through vitest; each has its own unit test
([`audit-gate.test.mjs`](../scripts/audit-gate.test.mjs),
[`security-test-gate.test.mjs`](../scripts/security-test-gate.test.mjs)), which is where
the "gate that measures nothing" cases live.

## The five ways a gate fails

Every one of these has happened in this repo, and each is quoted from the measurement.

### 1. Two empty lists agree

Almost every gate here ends `expect(offenders).toEqual([])`. The failure mode is not a
wrong answer — it is no answer. `audit-gate.test.mjs` iterated a `for` loop over an array
that was empty in the tree, so the case made zero assertions and passed for as long as the
allow-list happened to have no entries.

The fix has a shape: a **corpus floor** (`expect(files.length).toBeGreaterThan(n)`) plus a
**named anchor** that must be in range (`expect(pages).toContain('safety-and-security.md')`).
A floor alone still passes if the scan collected the wrong files; an anchor alone still
passes if the matcher stopped matching. Both, or neither is worth much.

### 2. The corpus is the decision, and "on disk" is not "tracked"

`docsIndex` reads `git ls-files docs` rather than walking the directory, because `docs/`
holds pages that are gitignored and present only on the maintainer's machine — eight `.md`
files on disk there, five tracked. A `readdirSync` walk would demand the index link three
files CI has never seen: red for the developer, green on CI, which is how people learn to
ignore a gate.

`busSafetyClaims` walks the directory instead, deliberately, "so the gate runs identically
on both CI runners and needs no subprocess." Neither is the general answer. They are asking
different questions: _does the shipped index match the shipped pages_ needs the tracked
set, and _does any file carry a superseded claim_ is still true of a file only you have.

### 3. The gate's own header is inside its corpus

Three of these scan for identifiers their own prose names. `predicateReturns` matches
`export function is…` with no column anchor, so a doc comment writing that phrase registers
as a violation. Every cross-package gate therefore strips comments first — and that step
has three parallel implementations, one per program that cannot import the others:
`scripts/lib/strip_comments.mjs` (four gate consumers), `server/src/test_support/strip_comments.ts`
(five), `web/src/sourceScan.ts` (eight). `stripCommentsConformance` pins them
byte-identical against a fixture table that is the accumulated bug history of the function.

A **fourth** copy was live until 2026-09-04, hand-rolled inside `defaultPortSingleSource`:
block comments, then `//` to end of line. That strips from the `//` of a URL onward.
Measured — it turned

```
const base = 'ws://127.0.0.1:4319';
```

into `const base = 'ws:`, so the gate found no literal and passed. That string is the
pre-fix shape the gate was written to reject, and a URL is the only form a hardcoded port
takes in this tree: the check was blind to its entire subject, on a fixture the three
pinned copies had handled correctly for months. The copy now imports the shared one, and
the conformance gate sweeps for a fifth.

### 4. An allow-list entry outlives its reason

Measured twice. `busSafetyClaims`' posture allow-list still excused `CLAUDE.md` long after
that file stopped being tracked, under a comment claiming it was now collected. And an OSV
hold retired for expiry **re-fired under the same id** when the advisory's range widened
upstream. Both are the same shape: an exemption whose premise expired without announcing
itself.

An allow-list needs a test that every entry still excuses something. Two now have one.

### 5. Text matching is evadable, and a green must not read as a proof

`predicateReturns` sees only the literal `export function isFoo(` — an arrow-function
export, `export async function`, or an `export { isFoo }` re-export is invisible.
`redactRegexBounded` matches `[*+]` and therefore calls `{8,}` bounded, including on the
line it guards. These gates catch **drift**, not an adversary. Say so in the header, so
nobody later reads a green as a guarantee.

## Where a gate can live is decided by the type programs

Not a style preference — measured, and pinned:

- **`web/`** — `web/tsconfig.json` sets `"types": []`, so the web program has no
  `@types/node` and a web-side test cannot open a file. `web/src/nodeTypeIsolation.test.ts`
  fails typecheck if that stops being true.
- **`server/`** — `server/tsconfig.json` sets `rootDir: src` with no `allowJs`, so
  importing a `scripts/*.mjs` from a server test fails `npm run typecheck` with `TS7016`.
- **`scripts/`** — plain `.mjs`, run by the root vitest project. A `.test.mjs` _can_ import
  a workspace `.ts` module because vitest transforms it, which is what lets one file reach
  all three `stripComments` copies.

So a gate that must read across packages lives in `scripts/`. A gate about one package's
own source belongs inside that package, using its local stripper.

## What none of them can see

- **Whether the gate is wired in.** Nothing asserts `ci.yml` still invokes
  `node scripts/audit-gate.mjs`, or that `package.json`'s `test:security` still points at
  the wrapper. `ci_setup_steps_match` covers the setup steps only.
- **Whether a rule that matches its fixture also matches everything else.** `semgrepRules`
  pins structure; `semgrep --test` proves behaviour and runs only in the semgrep workflow,
  not in the vitest suite.
- **A paraphrase.** `busSafetyClaims` matches literal tokens, so a sentence that never
  writes `bypassPermissions` is invisible. Its own header records the shape it cannot
  reach: extensionless files beside a scan root rather than inside it, which is how
  `.github/CODEOWNERS` held a fourth copy of a false claim.
- **Severity.** `reactHooksLint` filters on `ruleId` and never `severity`, so downgrading
  either rule from `error` to `warn` leaves it green.
- **Whether the right tests ran.** `security-test-gate` proves at least one tagged test
  executed, never that the intended ones did — a deliberate trade its header states: a
  `> 0` floor never needs revisiting, and a threshold gets lowered to shut it up.

A discovery failure used to be a pass outright: `passWithNoTests: true` at the root meant a
bad include glob printed "No test files found" and exited 0. Removed; vitest's default is
already fail-on-empty. The other half of that hole is still live by construction —
`npm run test:security` filters by test **name**, and a renamed tag leaves every file
discovered and every test skipped, which vitest exits 0 on regardless.

## Adding one

1. **Name the defect in one sentence, in the past tense.** If you cannot point at the
   incident, you are writing a preference, not a gate.
2. **Choose the corpus deliberately** and write down why — tracked set or directory walk,
   and what the wrong choice would have done.
3. **Floor and anchor.** Assert the scan found something, and name one member that must be
   in range.
4. **Strip comments** if the gate's own prose is inside its corpus. Import one of the three
   implementations; do not write a fourth.
5. **Revert-check in both directions.** Mutate the tree so the gate must redden, confirm
   the _named_ case reddens, restore, confirm the green control. A gate that only ever went
   green has not been tested.
6. **Give every allow-list entry an expiry mechanism** — a test that the entry still
   excuses something real.
7. **State the blind spot in the header.** The next reader's first question is what a green
   does not mean, and the honest answer is short.
