/**
 * `Cebab-ibb4`: how much of a turn the chat shows.
 *
 * Deliberately the same shape and the same classes as the permission
 * `ModeToggle` beside it — two `aria-pressed` pills under one labelled group.
 * A second visual language for "pick one of two" in the same header would make
 * the row read as two unrelated controls, and this one is the less consequential
 * of the pair: it changes what is drawn, never what runs.
 */
export function TranscriptToggle(props: { quiet: boolean; onChange: (quiet: boolean) => void }) {
  const hintId = 'transcript-toggle-hint';
  const tooltip = props.quiet
    ? 'Showing each turn as its answer. Permission cards, questions and errors always stay. Every step is still on the turn, behind its own count, and in the session log.'
    : 'Showing every tool call and its output, in full.';
  return (
    <div className="mode-toggle transcript-toggle" role="group" aria-label="Transcript detail">
      <span className="label">transcript:</span>
      <span id={hintId} className="sr-only">
        {tooltip}
      </span>
      <button
        type="button"
        className={`pill ${props.quiet ? 'on' : ''}`}
        aria-pressed={props.quiet}
        aria-describedby={hintId}
        onClick={() => props.onChange(true)}
      >
        answers
      </button>
      <button
        type="button"
        className={`pill ${props.quiet ? '' : 'on'}`}
        aria-pressed={!props.quiet}
        aria-describedby={hintId}
        onClick={() => props.onChange(false)}
      >
        everything
      </button>
    </div>
  );
}
