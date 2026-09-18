/**
 * `Cebab-0fgx`: combine the several things Cebab may append to a turn's system
 * prompt into the one string the SDK accepts.
 *
 * WHY THIS EXISTS AT ALL. `RunOptions.systemPromptAppend` is a single string,
 * and the spreadable-spec idiom that every other option uses
 * (`projectModelSpec`, `mcpStatusNoteSpec`, `projectRulesSpec`) breaks down the
 * moment two specs write the SAME key:
 *
 *     { ...projectRulesSpec(a), ...mcpStatusNoteSpec(b) }
 *
 * is not "both" — it is the second one, silently, with the first discarded and
 * nothing anywhere to say so. Both spreads are present, both functions ran,
 * both look correct at the call site, and the project's rules never reach the
 * model. That is the same shape as the `model: undefined` hazard the spreadable
 * idiom was introduced to kill, so the fix is the same: make the safe thing the
 * only expressible thing, and leave the unsafe spelling unavailable.
 *
 * ORDER IS THE CALLER'S AND IT MATTERS. Sections are joined in the order given.
 * The call site puts the project's standing conventions first and the volatile
 * per-turn note last, so the freshest operational fact sits closest to the
 * user's message; a reader changing that should change it deliberately.
 */

/** Any spec that may contribute an appended section. */
export type AppendSpec = { systemPromptAppend?: string };

/**
 * Blank line between sections, so two appended blocks read as two blocks. A
 * single newline would let the last line of one section and the first line of
 * the next be read as one paragraph, which is how a heading stops looking like
 * a heading.
 */
const SEPARATOR = '\n\n';

/**
 * Join the contributing specs into one spreadable fragment.
 *
 * Returns `{}` when nothing contributed, so a turn with nothing to add stays
 * byte-identical to one from before any of this existed — `buildSdkOptions`
 * guards on truthiness and an empty string would still be no append, but an
 * absent key is the shape the rest of the options use and the one a reader can
 * check at a glance.
 *
 * Empty and whitespace-only sections are dropped rather than joined: a spec
 * that returns `{ systemPromptAppend: '' }` means "nothing to say", and letting
 * it through would open the prompt with a stray blank block.
 */
export function composeSystemPromptAppend(...specs: readonly AppendSpec[]): AppendSpec {
  const sections = specs
    .map((s) => s.systemPromptAppend)
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  if (sections.length === 0) return {};
  return { systemPromptAppend: sections.join(SEPARATOR) };
}
