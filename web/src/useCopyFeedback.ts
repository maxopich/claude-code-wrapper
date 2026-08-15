import { useState } from 'react';
import { copyToClipboard } from './clipboard';

/** How long the confirmed state shows before reverting to the idle label. */
const CONFIRM_MS = 1200;

/**
 * "Copy, then say so" — the copied-state + timed-reset pair, lifted out of
 * `CopyButton` so a *text* button can behave the same way as the icon one.
 *
 * U42: `ArtifactsView`'s "Copy path" called `navigator.clipboard.writeText`
 * inside a `try` with an empty `catch`, so the operator learned nothing on
 * success and nothing on failure — the two outcomes were pixel-identical. The
 * obvious fix, "reuse the shared copy button", would have swapped a labelled
 * text button for a bare icon; extracting the behaviour instead lets both
 * presentations share one implementation.
 *
 * `copy()` returns whether the write succeeded, so a caller that wants to
 * report failure can. Nothing does today: the confirmed state appearing (or
 * not) is itself the signal, and inventing an error toast for a clipboard
 * permission denial would be louder than the event deserves.
 */
export function useCopyFeedback(): { copied: boolean; copy: (text: string) => Promise<boolean> } {
  const [copied, setCopied] = useState(false);

  async function copy(text: string): Promise<boolean> {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), CONFIRM_MS);
    }
    return ok;
  }

  return { copied, copy };
}
