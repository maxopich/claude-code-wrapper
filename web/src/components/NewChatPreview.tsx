import {
  AuthorityPreflightBody,
  type PreflightModelSlot,
  type PreflightStartModeSlot,
} from './authority/AuthorityPreflightBody';

// Cebab-ws0.5: what the chat area shows for a selected project with no
// conversation yet — the agent's resolved authority, with the composer
// underneath it.
//
// WHY HERE AND NOT BEHIND A BUTTON. The authority preview existed before this,
// reachable from a trailing ⓘ on the `new chat` row. Two things made that the
// wrong place. `new chat` does not start anything — it drops the project's
// active session id and the session spawns on the first message — so gating it
// gated a click that costs nothing. And the usual way a conversation begins
// never touches that row at all: selecting a project leaves no active session,
// so typing straight into the composer starts one. An affordance on the button
// would have been bypassed by the common path.
//
// The empty chat area is where a new conversation actually begins, so that is
// where the answer goes. It surfaces rather than blocks: an operator who wants
// to type can ignore it entirely, which is why this needs no memory of what has
// been reviewed and cannot swallow a half-typed message.
//
// The copy this replaces was also wrong. `Select a project to start a
// conversation` rendered whenever there was no session — including when a
// project WAS selected, which is exactly this case. `ChatView` keeps that
// sentence for the case it describes correctly: nothing selected at all.

export type NewChatPreviewProps = {
  projectId: number;
  projectName: string;
  model?: PreflightModelSlot;
  startMode?: PreflightStartModeSlot;
};

export function NewChatPreview(props: NewChatPreviewProps) {
  const { projectId, projectName, model, startMode } = props;
  return (
    <div className="chat new-chat-preview">
      <header className="new-chat-preview-header">
        <h2 className="new-chat-preview-title">New chat in {projectName}</h2>
        <p className="new-chat-preview-help">
          What this agent will be able to do, resolved from the settings files its session loads.
          Type below to start — nothing here has to be answered first.
        </p>
      </header>
      <AuthorityPreflightBody
        projectIds={[projectId]}
        {...(model !== undefined && { model })}
        {...(startMode !== undefined && { startMode })}
      />
    </div>
  );
}
