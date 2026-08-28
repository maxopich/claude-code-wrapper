import { useAssistant } from './AssistantContext';

/**
 * Cebab-8x8.3.2: the assistant widget's first-open state.
 *
 * Four suggested-question chips targeting the documented gaps the assistant
 * exists to answer — clicking one sends it as the operator's first message.
 * The copy names concepts (Multi-Agent tab, chain vs orchestrator, Templates,
 * the Trust toggle) a new operator can't discover from the UI alone.
 */

const SUGGESTED_QUESTIONS = [
  'What does the Multi-Agent tab do?',
  "What's the difference between a chain and an orchestrator?",
  'What is a Template?',
  'How does the Trust toggle change what Claude can do?',
] as const;

export function AssistantEmptyState() {
  const { sendMessage } = useAssistant();
  return (
    <div className="assistant-empty">
      <p className="assistant-empty-lead">
        Ask about Cebab — how the app works, what a feature does, or how to get started.
      </p>
      <ul className="assistant-chips" role="list">
        {SUGGESTED_QUESTIONS.map((q) => (
          <li key={q}>
            <button type="button" className="assistant-chip" onClick={() => sendMessage(q)}>
              {q}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
