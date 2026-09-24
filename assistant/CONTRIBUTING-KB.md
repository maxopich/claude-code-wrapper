# Contributing to the help knowledge base

This page is for **repo contributors**, not for the help assistant. It lives at
`assistant/CONTRIBUTING-KB.md`, deliberately **outside** `assistant/kb/`, so it
is not injected into the assistant's prompt. Keep contributor-facing notes here;
keep user-facing answers in `kb/`.

Being outside `kb/` is **not** a confinement boundary, and this page used to
imply it was (`Cebab-6fax.6`): it said the assistant's read tools were "scoped
there". Nothing scopes paths. The assistant runs with `cwd` set to
`assistant/kb/` and a read-only tool set. Reads **inside** `assistant/kb/` are
settled by the CLI itself and never reach Cebab, so they just work. Any other
tool call — a Read of an absolute path outside the KB, a Glob elsewhere, an MCP
tool — reaches Cebab's permission gate and is **refused on the spot**
(`Cebab-zqhq`): the model gets the refusal back as the tool result and the
operator sees no prompt. So the confinement rests on the CLI's in-folder read
rule plus that refusal, not on a path check. Do not put anything in this file
that would matter if the assistant read it — the refusal keeps it out of reach,
but only because it lives outside the KB folder the CLI reads freely.

## What the knowledge base is

`assistant/kb/` holds the flat markdown files the built-in Cebab help assistant
answers from. The assistant runs as an ordinary single-agent session whose `cwd`
is this directory, reading pages by **bare filename**. `00-index.md` is a router
(it names which page owns which questions), and `01`–`14` are the content pages.
The composer that assembles the assistant's system prompt from `PROMPT.md` plus
`00-index.md` plus a runtime snapshot is server-side; this KB is just its content.

## Rules that the build enforces

`server/src/assistant/kb_gate.test.ts` fails CI when the KB drifts. Before you
open a PR, know what it checks — every item here is a red build if you get it
wrong, with the offending filename named in the failure message:

1. **Flat directory.** No subdirectories under `assistant/kb/`. Nesting breaks
   the bare-filename Read contract the index promises.
2. **Bidirectional index coverage.** Every `kb/*.md` except `00-index.md` must be
   linked from `00-index.md`, and every link target in the index must exist on
   disk. Add a page, add its index row — and vice versa.
3. **One H1, matching the index link text.** Each page opens with exactly one
   `# ` H1 line, and the link text the index uses for that page must match that
   H1 exactly. The routing table cannot lie about what a page is called.
4. **Per-doc size cap.** Each page stays under a codepoint cap set well below the
   prompt's truncation threshold, so drift trips CI here rather than silently
   truncating a page in production. Split a page before it grows past the cap.
5. **Shortcut freshness.** Every shortcut `id` in `web/src/shortcutRegistry.ts`
   must appear in `13-shortcuts-and-commands.md`. Add a binding, document it.
6. **Slash-command freshness.** Every `command` in `web/src/slashCommands.ts`
   must appear in `13-shortcuts-and-commands.md`.
7. **Theme freshness.** Every `[data-theme=...]` gamma name in
   `web/src/styles.css` must appear in `12-settings-storage-and-data.md`.

## Writing guidance

- **Audience is a user driving the UI**, not a contributor. Write to the
  question ("how do I stop a run?"), not to the implementation.
- **Ground every claim in the code.** The richest raw material is the `title=`
  tooltips across `web/src` (several are the only prose describing a feature),
  plus `README.md`, `SECURITY.md`, `CLAUDE.md`, `docs/`, and the `SettingsModal`
  hint paragraphs. If a detail isn't in the source, leave it out.
- **Never overstate safety.** Consultant mode and pause-on-dangerous are advisory
  brakes and post-hoc detection, not a sandbox. Keep `08-safety-controls.md`
  honest — the threat model in `SECURITY.md` is the reference.
- **Keep the index a router, not a summary.** `00-index.md` should say which file
  owns a topic, never explain the topic itself.
- **One topic, one page.** Every user-visible feature should be covered by
  exactly one page; cross-link siblings by bare filename rather than repeating.

## When the shortcut/command/theme reference must change

`13-shortcuts-and-commands.md` ends with a "Binding and command reference"
section that lists every shortcut id and slash command verbatim, and
`12-settings-storage-and-data.md` names every theme gamma. These exist so the
freshness gates above have something to match. If you add or rename a binding,
command, or theme in the source, update the matching page in the same PR — that
is the whole point of the coupling.
