import type { ModelCatalogueEntry, SessionPermissionMode } from '@cebab/shared/protocol';
import { AuthorityPanel } from './AuthorityPanel';
import { ModelPicker } from '../ModelPicker';
import { PermissionModePicker } from '../PermissionModePicker';

// Cebab-ws0.5: the contents of an authority preview — what the operator reads
// before talking to an agent — with no chrome of its own.
//
// It was the body of `AuthorityPreflightModal`, lifted out when a second
// surface appeared: the empty chat area now opens a new conversation onto this
// same view. Two hand-maintained copies of one panel drift, and the drift here
// would be the worst kind — the two surfaces would disagree about what an agent
// can do, with nothing to say which one was right. Same argument that pulled
// `sendProjects` and `respondWithProjectAuthority` into single functions.
//
// `wantLive` is passed straight through to every panel: a preview is read
// before an action, so it may not show a snapshot nobody measured.

/**
 * The model-picker slot. Optional, so the three multi-agent call sites keep
 * opening a review-only view unchanged.
 *
 * Only meaningful for a SINGLE project — an aggregate preview reviews several
 * at once, and one picker cannot speak for all of them. Rendered only when
 * `projectIds.length === 1`; an aggregate view showing one project's model
 * would be worse than showing none.
 */
export type PreflightModelSlot = {
  entries: ModelCatalogueEntry[];
  value: string | null;
  onChange: (model: string | null) => void;
  onRefresh: () => void;
  refreshing: boolean;
  capturedAt: number | null;
};

/**
 * The starting-permission-mode slot. Same optionality and the same
 * single-project restriction as the model slot above — and for a sharper reason
 * here, since the options' MEANING depends on the project's Trust flag, so one
 * control genuinely cannot speak for several projects at once.
 */
export type PreflightStartModeSlot = {
  value: SessionPermissionMode | null;
  trusted: boolean;
  onChange: (mode: SessionPermissionMode | null) => void;
};

export type AuthorityPreflightBodyProps = {
  projectIds: number[];
  model?: PreflightModelSlot;
  startMode?: PreflightStartModeSlot;
};

export function AuthorityPreflightBody(props: AuthorityPreflightBodyProps) {
  const { projectIds, model, startMode } = props;
  const isAggregate = projectIds.length > 1;

  return (
    <>
      {model && !isAggregate && (
        <section className="authority-preflight-model" data-testid="preflight-model">
          <h4 className="authority-preflight-model-title">Model</h4>
          <p className="gate-modal-help">
            Which model this project&apos;s sessions ask for. Applies to the next turn; a run
            already in flight keeps the model it started on.
          </p>
          <ModelPicker
            entries={model.entries}
            value={model.value}
            onChange={model.onChange}
            onRefresh={model.onRefresh}
            refreshing={model.refreshing}
            capturedAt={model.capturedAt}
          />
        </section>
      )}
      {startMode && !isAggregate && (
        <section className="authority-preflight-model" data-testid="preflight-start-mode">
          <h4 className="authority-preflight-model-title">Starting permission mode</h4>
          <PermissionModePicker
            value={startMode.value}
            trusted={startMode.trusted}
            onChange={startMode.onChange}
          />
        </section>
      )}
      <div className="authority-preflight-panels">
        {projectIds.map((id) => (
          <AuthorityPanel key={id} projectId={id} mode="preflight" wantLive />
        ))}
      </div>
    </>
  );
}
