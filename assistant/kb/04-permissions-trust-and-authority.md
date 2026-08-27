# Permissions, Trust, and authority

This page explains how Cebab decides what an agent is allowed to do when you run a project: the per-project **Trust** setting, the two things it controls, the per-session permission pill, and the **Authority** preflight inspector that shows what a session will load before you start it.

Keep one thing in mind throughout: Cebab runs the `claude` CLI locally, under your own account and your own Claude subscription. Trust and permission modes decide how much gets auto-approved and which configuration files load — they are not a sandbox. Even an "untrusted" project's agent still runs as you and can touch your files if you approve a tool. See `08-safety-controls.md` for the brakes that sit around this.

## What Trust controls

Each project in the sidebar has a Trust toggle with two states: **asks** (untrusted) and **trusted**. Flipping it changes **two** separate things. The first is a convenience default; the second is the security-relevant half.

### 1. Permission mode

Trust sets the starting `permissionMode` for the project's new sessions:

- **default** ("asks") — every restricted tool call prompts you for approval. You see an inline approval card in the chat and the agent waits for your decision. See `03-chat-and-composer.md` for how approval cards work.
- **acceptEdits** ("trusted") — file edits and common filesystem commands auto-approve, so the agent works without stopping to ask on routine actions. Other restricted tools can still prompt.

An untrusted project starts in **default**; a trusted project starts in **acceptEdits**. (A project can also carry an explicit starting mode set from its authority view, which takes precedence over the trust-derived default for new sessions.)

### 2. Which configuration loads (`settingSources`)

This is the half that matters for safety. Trust decides whether the project's **own** configuration files are loaded when the agent spawns in that directory:

- **Untrusted** loads only your user-scope settings. The project's own files are ignored.
- **Trusted** also loads the project's own configuration: its `CLAUDE.md` (project instructions), its `.claude/skills/`, its `.claude/settings*.json` (which can declare hooks, environment-variable injectors, and MCP servers), and a project-root `.mcp.json`.

So flipping a project to **trusted** authorises all of that to run the moment you use the project. A hostile or careless `.claude/settings.local.json` checked into a repo you cloned cannot auto-load its hooks while the project is untrusted — that is the point of leaving it on "asks" until you have looked.

## The exception: user-scope MCP servers load regardless

Trust scopes the _project's_ files. It does **not** scope MCP servers you declared at the user level in `~/.claude.json`'s top-level `mcpServers` (for example via `claude mcp add --scope user`). Those load even for an untrusted project, because a home-directory declaration is outside a project's reach.

Cebab gates those user-scope servers a different way: **TOFU** (trust-on-first-use). The first time such a server would be used, you make a trust decision about it. That first-use decision is the only brake on user-scope MCP servers — Trust does not stop them. See MCP trust decisions below.

## The inline per-session mode pill

Above the chat there is an inline pill that flips the permission mode for **one session only**, between `default` and `acceptEdits`, mid-conversation. Use it when you want to tighten or loosen approvals for the run you are in without changing the project's Trust setting.

Two limits to know:

- It flips **permissionMode only**. It does **not** change `settingSources` — which files loaded is fixed when the run started and cannot be changed for a running session.
- It is **session-scoped**. It does not persist to the project or affect future sessions. To change the durable default, use the project Trust toggle.

Because the pill only touches permission mode, switching a session to `default` genuinely makes tools ask again, even on a trusted project.

## The Authority panel (preflight inspector)

Before you start a session, you often want to know exactly what the agent _will_ load and what it will be able to do. The **Authority panel** answers that. Open it from the Authority chip in the chat header — its tooltip reads _"Open the AuthorityPanel preflight inspector for this project."_ It also appears as a preview when you open a new chat on a selected project, and can be reviewed after a run.

The panel is not a guess from the config files alone. It runs a real, lightweight probe: Cebab spawns the agent just far enough to read what the session actually resolves (it stops at initialization and spends no model turn), then shows you the result. A freshness line shows how long ago the snapshot was taken; **Refresh** re-probes. If no session has ever run for the project on this connection, Refresh still reads and shows what the settings files declare — only the parts that need a live run stay empty until the project runs one.

The panel is organised into sections:

- **Model & identity** — which model the run will ask for and the agent's identity.
- **Tools** — the tools available to the agent, with a risk class per tool. After a run it can show which tools were attempted or denied, so you can triage "what bounced?"
- **MCP servers** — the MCP servers that will load, each with a live **runtime status** (the tooltip reads _"Runtime status: …"_). This is where you see the important distinction a session otherwise hides: a server that loaded but **failed to connect** contributes zero tools and looks, from inside a chat, identical to a server that was never declared. The panel names it and prints its status verbatim rather than guessing a cause. An untrusted project also shows here what its Trust setting is keeping out ("project scope not read" versus "none declared").
- **Allow / deny rules** — the explicit allow and deny rules in effect, plus default-deny tools, so you can see "these are allowed, these are denied."
- **Env injection scan** — scans the settings layers for environment variables that would be injected, flagging credential-class keys. This section force-opens when any injection is detected, because setting an env var before a run is high-signal — review it before starting.
- **Hooks** — the hooks (SessionStart / PreToolUse / PostToolUse / Stop and similar) that will auto-run. Each hook shows its trust tier; a project-local hook declared in `.claude/settings.local.json` is flagged as the _lowest-trust tier_ and the section force-opens so you notice it. Hooks run automatically with no per-call prompt, so this section is worth a look on any project you have just trusted.
- **Slash commands** — the slash commands enumerated for the session.
- **Skills** — the skills that loaded.
- **Sub-agents** — the sub-agents declared for the project.

Empty sections distinguish "nothing has looked yet" from "looked and found none," so a blank list never overstates what was measured.

## MCP trust decisions (TOFU)

For user-scope MCP servers (see the exception above), Cebab asks you to make a trust decision the first time the server would be used, rather than at project-trust time. Approve it and it becomes usable; the decision is remembered so you are not asked again. This is the mechanism that keeps a home-directory MCP declaration from silently acting the moment you open any project, trusted or not.

For MCP servers declared inside a project (project `.mcp.json` or `.claude/settings*.json`), the gate is Trust itself: those load only when the project is trusted, and the Authority panel's MCP section shows whether they loaded and connected.

## Related pages

- `02-projects-and-sessions.md` — switching projects, the sidebar, and where the Trust toggle lives.
- `03-chat-and-composer.md` — approval cards and the chat header.
- `05-multi-agent-concepts.md` — how permissions and prompt-level constraints work for multi-agent (bus) runs, which differ from single-agent.
- `08-safety-controls.md` — the safety brakes that surround all of the above.
