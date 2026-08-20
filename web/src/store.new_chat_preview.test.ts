import { describe, expect, test } from 'vitest';
import { initialState, reduce, showsNewChatPreview, type AppState } from './store';

/**
 * Cebab-ws0.5: which of two things the chat area shows.
 *
 * The predicate lives here rather than inline in `App.tsx` because it decides
 * what an operator sees before talking to an agent and `App.tsx` has no test
 * file. Both the FALSE cases matter as much as the true one: showing the
 * preview over a live conversation would replace the scrollback, and failing to
 * show it on a freshly-selected project is the bug the bead was filed for.
 */

const PID = 1;

function started(sessionId: string, projectId = PID) {
  return {
    type: 'server' as const,
    msg: {
      type: 'session_started' as const,
      sessionId,
      projectId,
      model: 'opus-4',
      tools: [],
    },
  };
}

function select(projectId = PID, state: AppState = initialState): AppState {
  return reduce(state, { type: 'select_project', projectId });
}

describe('showsNewChatPreview', () => {
  test('a freshly selected project shows the preview', () => {
    // The common path, and the one an affordance on the `new chat` button
    // would have missed entirely: `select_project` sets `activeProjectId` and
    // nothing else, so there is no active session and typing starts one.
    expect(showsNewChatPreview(select())).toBe(true);
  });

  test('CONTROL: nothing selected shows no preview', () => {
    // `ChatView` still owns this case, and its sentence — "Select a project to
    // start a conversation" — is only correct here.
    expect(showsNewChatPreview(initialState)).toBe(false);
  });

  test('CONTROL: a project with a live session shows no preview', () => {
    // Rendering the preview here would replace the conversation the operator
    // is reading.
    let s = select();
    s = reduce(s, started('sess-1'));
    expect(showsNewChatPreview(s)).toBe(false);
  });

  test('new chat on a project that has a session brings the preview back', () => {
    // `new_session` drops the active session id without starting anything, so
    // the operator is back in the state a new conversation begins in.
    let s = select();
    s = reduce(s, started('sess-1'));
    expect(showsNewChatPreview(s)).toBe(false);

    s = reduce(s, { type: 'new_session', projectId: PID });
    expect(showsNewChatPreview(s)).toBe(true);
  });

  test('a session belonging to ANOTHER project does not suppress the preview', () => {
    // The active session map is per project. Keying the answer off "is any
    // session active" reddens here.
    let s = select(PID);
    s = reduce(s, started('other-1', 2));
    s = reduce(s, { type: 'select_project', projectId: PID });
    expect(showsNewChatPreview(s)).toBe(true);
  });
});
