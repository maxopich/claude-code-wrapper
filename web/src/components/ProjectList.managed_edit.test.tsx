// @vitest-environment jsdom
//
// Cebab-ws0.10: the edit-config affordance appears for a managed agent and for
// nothing else.
//
// ITS OWN FILE because the existing `ProjectList.test.tsx` renders one fixed
// project through a shared `render` helper, and this needs two projects that
// differ in exactly the field under test — a managed one and an ordinary one,
// side by side in the same list, so "shown" and "not shown" are one assertion
// about one render rather than two runs that could each be wrong.
//
// The server refuses an unmanaged project regardless (`managed_file.test.ts`),
// so this is not the security boundary. It is the promise the UI makes: an
// affordance that appears and then refuses is worse than no affordance.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { Project } from '@cebab/shared/protocol';
import { ProjectList } from './ProjectList';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const MANAGED_ID = 1;
const ORDINARY_ID = 2;

function project(over: Partial<Project>): Project {
  return {
    id: 0,
    name: 'p',
    path: '/tmp/p',
    trusted: false,
    lastUsedAt: null,
    hasClaudeMd: true,
    busInstalled: false,
    busAgentName: null,
    model: null,
    startPermissionMode: null,
    isManaged: false,
    managed: null,
    ...over,
  };
}

function render(activeProjectId: number | null): {
  onEditManagedConfig: ReturnType<typeof vi.fn>;
} {
  const onEditManagedConfig = vi.fn();
  act(() => {
    root.render(
      <ProjectList
        projectScans={{}}
        onCopyToManaged={() => {}}
        onEditManagedConfig={onEditManagedConfig}
        projects={[
          project({
            id: MANAGED_ID,
            name: 'ledger-agent',
            isManaged: true,
            managed: { sourcePath: '/work/ledger', copiedAt: 5 },
          }),
          project({ id: ORDINARY_ID, name: 'my-repo' }),
        ]}
        activeProjectId={activeProjectId}
        activeSessionByProject={{}}
        knownSessions={{ [MANAGED_ID]: [], [ORDINARY_ID]: [] }}
        liveSessions={{}}
        onSelectProject={() => {}}
        onSelectSession={() => {}}
        onNewSession={() => {}}
        onToggleTrust={() => {}}
        modelCatalogue={null}
        modelRefreshingFor={null}
        onSetProjectModel={() => {}}
        onRefreshModelCatalogue={() => {}}
        onSetProjectStartPermissionMode={() => {}}
        onRenameSession={() => {}}
        onDownloadSession={() => Promise.resolve()}
        onBulkSessionOp={() => {}}
        onBulkExportSessions={() => Promise.resolve()}
      />,
    );
  });
  return { onEditManagedConfig };
}

const editRows = () => [...container.querySelectorAll('.session-row-managed-edit')];
const copyRows = () => [...container.querySelectorAll('.session-row-managed-copy')];

describe('the edit-config affordance', () => {
  test('appears for the MANAGED project only', () => {
    render(MANAGED_ID);
    expect(editRows()).toHaveLength(1);
    expect(editRows()[0]!.textContent).toContain('edit config');
  });

  test('the ordinary project gets the COPY row instead — the exact mirror', () => {
    // Expanding the unmanaged one shows copy and not edit. Asserting both ways
    // round is what distinguishes "guarded correctly" from "guard inverted".
    render(ORDINARY_ID);
    expect(editRows()).toHaveLength(0);
    expect(copyRows()).toHaveLength(1);
  });

  test('a managed project is never offered the copy row, and vice versa', () => {
    render(MANAGED_ID);
    expect(copyRows()).toHaveLength(0);
  });

  test('keys on the STRUCTURAL flag, not on provenance', () => {
    // Found in a browser, not in this file: the first version gated on
    // `managed`, which is non-null only when the path predicate holds AND the
    // provenance columns are populated. The SERVER gates on the path alone, so
    // a managed agent with no provenance got no affordance while a write to it
    // would have been accepted — and, through the copy row's inverse test, was
    // offered "copy into Cebab" for an agent already inside Cebab.
    //
    // jsdom could not have caught it, because the fixtures here CONSTRUCT
    // `managed`. What makes this case real is that it sets the two fields
    // apart, which no real row does today and a hand-edited one can.
    act(() => {
      root.render(
        <ProjectList
          projectScans={{}}
          onCopyToManaged={() => {}}
          onEditManagedConfig={() => {}}
          projects={[
            project({ id: MANAGED_ID, name: 'ledger-agent', isManaged: true, managed: null }),
          ]}
          activeProjectId={MANAGED_ID}
          activeSessionByProject={{}}
          knownSessions={{ [MANAGED_ID]: [] }}
          liveSessions={{}}
          onSelectProject={() => {}}
          onSelectSession={() => {}}
          onNewSession={() => {}}
          onToggleTrust={() => {}}
          modelCatalogue={null}
          modelRefreshingFor={null}
          onSetProjectModel={() => {}}
          onRefreshModelCatalogue={() => {}}
          onSetProjectStartPermissionMode={() => {}}
          onRenameSession={() => {}}
          onDownloadSession={() => Promise.resolve()}
          onBulkSessionOp={() => {}}
          onBulkExportSessions={() => Promise.resolve()}
        />,
      );
    });
    expect(editRows()).toHaveLength(1);
    expect(copyRows()).toHaveLength(0);
  });

  test('clicking it names the project so the modal can title itself', () => {
    const { onEditManagedConfig } = render(MANAGED_ID);
    const btn = editRows()[0]!.querySelector('button')!;
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onEditManagedConfig).toHaveBeenCalledWith(MANAGED_ID, 'ledger-agent');
  });

  test('clicking it does not also select the project', () => {
    // The row lives inside the project's own click target; without
    // stopPropagation the click would fall through to `onSelectProject`.
    const onSelect = vi.fn();
    act(() => {
      root.render(
        <ProjectList
          projectScans={{}}
          onCopyToManaged={() => {}}
          onEditManagedConfig={() => {}}
          projects={[
            project({
              id: MANAGED_ID,
              name: 'ledger-agent',
              isManaged: true,
              managed: { sourcePath: '/work/ledger', copiedAt: 5 },
            }),
          ]}
          activeProjectId={MANAGED_ID}
          activeSessionByProject={{}}
          knownSessions={{ [MANAGED_ID]: [] }}
          liveSessions={{}}
          onSelectProject={onSelect}
          onSelectSession={() => {}}
          onNewSession={() => {}}
          onToggleTrust={() => {}}
          modelCatalogue={null}
          modelRefreshingFor={null}
          onSetProjectModel={() => {}}
          onRefreshModelCatalogue={() => {}}
          onSetProjectStartPermissionMode={() => {}}
          onRenameSession={() => {}}
          onDownloadSession={() => Promise.resolve()}
          onBulkSessionOp={() => {}}
          onBulkExportSessions={() => Promise.resolve()}
        />,
      );
    });
    const btn = editRows()[0]!.querySelector('button')!;
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
