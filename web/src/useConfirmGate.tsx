import { useCallback, useState, type ReactElement } from 'react';
import { ConfirmGateModal, type ConfirmGateModalProps } from './components/ConfirmGateModal';

/**
 * Turns `if (window.confirm(x)) doThing()` into something themable, testable
 * and consistent, without asking every call site to hand-roll modal state.
 *
 * ```tsx
 * const { gate, requestConfirm } = useConfirmGate();
 * // ...
 * <button onClick={() => requestConfirm({ title: '…', body: <p>…</p>, onConfirm: doThing })} />
 * {gate}
 * ```
 *
 * A hook rather than a context (U16): the four native `confirm` sites live in
 * four different components — three of them in different parts of one file —
 * and a provider would mean threading something through the tree for a modal
 * that is always local to the control that opened it.
 *
 * `gate` is `null` when nothing is pending, so rendering it unconditionally is
 * free. `requestConfirm` is stable; the pending request is replaced wholesale,
 * so a second call while one is open swaps the question rather than stacking
 * two dialogs (which `useModalSurface`'s inert walk would handle badly).
 */
export type ConfirmRequest = Omit<ConfirmGateModalProps, 'onCancel'> & {
  /** Optional — the gate always closes on cancel; this is for callers that
   *  need to clean up state they set up in anticipation. */
  onCancel?: () => void;
};

export function useConfirmGate(): {
  gate: ReactElement | null;
  requestConfirm: (req: ConfirmRequest) => void;
} {
  const [pending, setPending] = useState<ConfirmRequest | null>(null);

  const requestConfirm = useCallback((req: ConfirmRequest) => {
    setPending(req);
  }, []);

  const gate = pending ? (
    <ConfirmGateModal
      {...pending}
      onConfirm={() => {
        // Close FIRST, then act. The action may unmount the component that
        // owns this hook (ending a session, uninstalling the project being
        // listed), and a setState on the way out would be dropped — leaving
        // the modal on screen if the unmount never came.
        setPending(null);
        pending.onConfirm();
      }}
      onCancel={() => {
        setPending(null);
        pending.onCancel?.();
      }}
    />
  ) : null;

  return { gate, requestConfirm };
}
