# Safety and security

Reference detail lifted out of [`CLAUDE.md`](../CLAUDE.md). **Nothing under
`docs/` is auto-loaded** — see [`bus-architecture.md`](bus-architecture.md) for
the same note. Read this before touching `server/src/notifications/`,
`server/src/bus/pause_gate.ts`, `server/src/bus/install_trust_gate.ts`,
`server/src/auth.ts`, or `server/src/origin.ts`.

The consultant-mode constraint itself, and the two limits on it, stay in
`CLAUDE.md` — they are what an agent reads and acts on. This page is why it is
shaped that way, plus the detect-and-contain layer sitting behind it.

## Why the consultant guardrail is advisory

The guardrail is advisory in the strict sense — the model interprets the prompt and nothing denies the tool call. `bus/guardrail.ts` classifies violations post-hoc so the operator sees them, and explains why enforcement is not wired: it would cover `Write`/`Edit`/`MultiEdit`/`NotebookEdit` only, while `Bash` and symlinked paths still escape.

## The mechanical brake: pause-on-dangerous

Operators also get a **mechanical** brake: an opt-in per-session **pause-on-dangerous** toggle. Cebab classifies every worker tool call `read`/`mutate`/`dangerous` (`shared/src/mutation.ts`, cross-platform — Unix shells + Windows cmd/PowerShell, matched case-insensitively); with the toggle on, a worker halts for operator approval before any `dangerous` command (`rm`, `sudo`, force-push, `curl|sh`, system/secret-path writes, `del`/`format`/`Remove-Item`/`reg delete`/`powershell -c`, …) via `applyPauseGate` / `releasePauseForMutation` in `bus/pause_gate.ts`, imported by both `orchestrator.ts` and `chain.ts`. It is **dangerous-only** by design: MCP tool calls and ordinary edits classify as `mutate` and run **free** — their guardrail is the MCP server's own permissions plus the hash-chained audit log, not a Cebab pause.

**What happens when the gate cannot do its job (`Cebab-aqd`).** The gate runs from the routers' mutation tap, _after_ the call is persisted to `multi_agent_mutations` — and the tap's `catch` used to log the failure and `return`, which is upstream of `applyPauseGate`. So a failed INSERT silently disarmed the brake and the `dangerous` command ran: fail-**open** on the operator's only mechanical control. It now fails **closed**. `shouldHaltUnrecordedMutation` (same module, so the two routers cannot drift) answers with the two facts that do not live in the unwritable table — the classifier's category and the session's toggle — and the tap throws `MutationNotRecordedError`. If even the session read fails, the answer is halt: an unknown gate state on a `dangerous` command resolves to caution.

That error is deliberately **not** a `PausedForMutationError`. Both routers' `deliver().catch` return quietly on that class, which is right for a real pause (the row and the banner are already persisted) and wrong here (neither exists — the operator would see an agent that simply stopped, with nothing to click). Falling through to `onWorkerFailed` instead reuses the recovery that already exists: a pending-retry slot, a `cebab → user kind=error` event carrying the reason, and Retry / Abandon, with the session left `running`. A **disarmed** gate or a `mutate` call still runs — an operator who turned the gate off chose that, and a failed write is no reason to revisit it.

## Safety subsystem (multi-agent controllability)

Behind the consultant-mode prompt and the pause-on-dangerous toggle (the _prevent_ layer) sits a bus-side _detect + contain_ layer, none of it described above:

- **Hash-chained audit log** (`server/src/notifications/safety_audit.ts` → SQLite `safety_audit`): append-only; each row's `hash_self` is SHA-256 over its canonical contents **and the previous row's `hash_self`**, so altering any row breaks the chain and `verifyChain()` (run on boot) flags the first mismatch. Every trust decision, mute/pause/kick, dangerous-mutation, and guardrail violation writes a row.
- **Dispatcher dual-write** (`server/src/notifications/dispatcher.ts`): the single operator-notification fan-out (`emit()`). A _safety_-class event writes its audit row **before** the WS notification is sent — if the audit append throws, the caller refuses to proceed (`audit_write_failed`). Safety events are never coalesced; operational ones coalesce by key within short windows.
- **Forensic snapshots** (`server/src/notifications/forensic_snapshot.ts` → `controllability_forensics`): on a single-agent **Stop** or a multi-agent **kick/auto-kick**, captures the last-N events, pending tool calls, the agent's recent mutations, and a shallow workdir hash, keyed to the triggering audit row. Best-effort — the audit row is the obligation, the snapshot a bonus.
- **Bus-install TOFU gate** (`server/src/bus/install_trust_gate.ts`): trust-on-first-use — the first time a project is installed into the bus the operator must approve; the decision persists (`projects.bus_trust_decision`), denials are logged, and the install blocks until decided.
- **Hook trust ledger** (`server/src/repo/hook_trust.ts` → migration 030 `hook_trust`): the record of the auto-executing project hooks this document and `CLAUDE.md` both warn about. Workers and chain participants run `settingSources: ['user', 'project', 'local']`, so a participant project's `SessionStart` / `PreToolUse` / `PostToolUse` / `Stop` hooks execute on **every hop** — and none of them passes through `canUseTool`, so none can be approved or denied. Identity is the tuple (project, hook kind, declaring settings file, command, args); rewriting a command produces a **new** row reported as `first_seen`, and `script_sha` catches the other case — command untouched, the file it points at rewritten. **Detection, not prevention**: it records what will run and reports what changed; it does not park the spawn. `hook_trust.ts`'s header says why prevention was left as a separate change rather than half-built.
- **Operator controls — mute / pause / kick** (`server/src/ws/control_verbs.ts`, `pause_expiry.ts`): **mute** drops the agent's outbound bus messages (returning an _oracle_ white-lie "delivered" so it can't detect the drop); **pause** holds its turns behind an `auto_resume | auto_kick` expiry timer; **kick** one-way-drains it (drops both inbound and outbound). All three persist to `multi_agent_participants` columns and reseed on server restart (R-B).

## Browser threat model

The WS upgrade is gated on `Origin` and `Host`: the browser must come from `http://127.0.0.1:5173` (Vite dev) / `http://localhost:5173` / `http://127.0.0.1:$PORT` / `http://localhost:$PORT`. Extra origins via `CEBAB_ALLOWED_ORIGINS` (comma-separated). Empty `Origin` is allowed — browsers always set it on WS upgrades, so an absent header means a non-browser client (smoke tests, curl), and the server is bound to 127.0.0.1 anyway. Without the Origin check, any tab the user has open could connect to the local server (Cross-Site WebSocket Hijacking).

## Per-launch auth token

**A per-launch token shipped** (`server/src/auth.ts`) — an earlier version of this file said such tokens were out of scope for v1, and someone hardening the socket gate on that basis could have removed a live control. Cebab generates the token once at boot, writes it to `~/.cebab/auth-token` (mode 0600), serves it from the Origin+Host-gated `/auth-token` endpoint, and the WS `verifyClient` gate rejects any upgrade whose `?token=` doesn't match. It closes browser-tab CSWSH (a cross-origin tab can't pass the Origin gate to fetch the token) and, on POSIX, other local users. It does **not** close same-uid: a bus agent runs as the operator, so it can read the token off disk and open its own connection — there is no boundary to build there, which is why the posture is **detect, not prevent** and the control-plane verbs are hardened individually instead. `server/src/auth.ts`'s header is the full statement.
