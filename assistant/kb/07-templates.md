# Templates

A template is a saved, reusable multi-agent setup for the Multi-Agent tab. Instead of rebuilding the same crew of agents every time, you save the shape once and apply it whenever you want to run that kind of session. Templates live in the Templates browser inside the Multi-Agent tab.

For what participants, chain vs orchestrator mode, lifecycle, and hop budget mean, see 05-multi-agent-concepts.md. For actually starting and steering a run, see 06-multi-agent-running.md.

## What a template stores

A template captures the _structure_ of a multi-agent session, not a specific task:

- **Participants** — the list of projects (agents) that take part.
- **Mode** — chain (each agent hands to the next in a line) or orchestrator (a hub routes to workers who reply only to the hub). Some older templates were saved as a "custom" topology; the current build renders those using orchestrator routing and tells you so in the preview.
- **Lifecycle** — persistent or temp, controlling whether the session folder and bus installs survive when the run ends.
- **Per-agent roles** — an optional short role/goal description for each agent, authored in the preview card.
- **Hop-budget override** (optional) — a per-template limit that overrides the global hop budget for runs started from this template.

One thing a template deliberately does **not** store is your prompt. The first prompt is never saved — you type it fresh every time you apply a template and Start.

## Creating a template

Build a participant list in the Multi-Agent draft (add agents, pick the mode and lifecycle), then click **Save current as template**. You give it a name (for example, "security review"); this saves the current participant list plus lifecycle as a reusable preset. You need at least one participant before you can save. Saving over a name that already exists overwrites that template. Per-agent roles are added afterward, in the expanded preview card (see below).

## Applying a template

Select a template in the browser to open its preview, then click **Apply**. Apply fills the draft's participant list and lifecycle from the template. It does not start anything — after applying you type a fresh prompt and click Start. This is why the same template can drive many different tasks: the crew is fixed, the request is new each time.

If some of a template's saved participants are no longer available projects, the preview notes how many are "unavailable," and only the resolvable ones are applied.

## The template preview

Selecting a template shows a preview on the right with a topology diagram and a few honesty banners.

### Topology diagram

The diagram draws the agents and how messages flow between them — a left-to-right chain, or an orchestrator hub with spokes out to each worker. A caption states the protocol in words: in orchestrator mode, workers reply only to the orchestrator with no peer-to-peer messages; in chain mode, each agent receives from the prior one and forwards to the next, with no branching and no replies upstream. An animated dot shows one message in flight at a time; the order it visits agents is illustrative only — at runtime the orchestrator picks recipients based on their capabilities and your prompt.

You can click an agent in the diagram to edit its role text. Press Enter in the editor to save that role right away; Shift+Enter adds a newline; Escape cancels.

### Auto-approved tool calls banner

Every multi-agent session auto-approves tool calls — "bypass" is in effect for every participant. The only prompt you will see during a run is AskUserQuestion. This banner is always shown while the multi-agent UI is visible so the safety trade-off is never hidden.

### Execute vs consultant mode banner

For orchestrator-mode templates, a banner tells you which posture the run will take:

- **Consultant mode** (the default) — every agent acts as a consultant: read, analyze, advise. Workers may write scratch notes inside their own project folder but must not change files elsewhere and must not produce deliverable changes, unless your prompt explicitly directs a specific change.
- **Execute mode** — workers may actually make changes: each agent can create, modify, or delete files within its own project folder, but not in any other directory.

Either way the constraint is advisory — it is relayed to the agents in the prompt and out-of-folder writes are flagged after the fact; there is no server-side enforcement. Chain-mode templates do not show this banner because chain mode has no equivalent guardrail.

### Custom-topology note

If a template was saved as "custom," the preview shows a note that the current build renders it via orchestrator routing, plus a banner warning that the diagram is an approximation. Your stored template is not changed by this.

### Expand to full screen

The diagram has an expand control (the ⛶ button) to open a full-screen preview modal. You can also press **E** while the diagram has focus. Full screen gives more room for larger crews and a side panel for editing roles.

## Saving roles back to a template

In the preview you can type a role/goal for each agent. When you have unsaved edits, a **Save roles** button becomes active. Saving writes the per-agent roles back to the template; the participants, mode, and lifecycle are left unchanged. (Editing a role in the diagram and pressing Enter also saves immediately, without needing the button.) Switching to a different template discards any unsaved role edits.

## The per-template hop-budget override

If a template carries its own hop budget, the preview shows a "Hop budget: N (per template)" badge. This value overrides the global hop budget: runs started from this template enforce the template's number instead. If a template has no override, runs use the global budget.

## The last-run rail

When a template has been run before, the preview shows a "Last run" rail summarizing the most recent run: how long ago it started, how many hops it used out of the budget, the total cost (or "cost n/a" for older runs recorded before cost tracking existed), and a status chip. The chip distinguishes outcomes such as ok, at cap (the run hit the hop budget), interrupted (you stopped it), failed, and running. When the last run failed, the rail also shows the start of the first error message; hover it for the full text. The rail is read-only — it is a health-at-a-glance signal, not a control.

## Deleting a template

Each template in the browser list has a **×** delete button (labeled "Delete template"). Deleting removes the template preset. It does not touch any past run's on-disk artifacts, and it does not affect projects or their bus installs — a template is just a saved recipe.
