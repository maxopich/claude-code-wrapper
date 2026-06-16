// Robust copy-to-clipboard with a legacy fallback. Lifted from the local helper
// in authority/McpServersList.tsx so message copy buttons (and any future
// caller) share one implementation. Returns whether the copy succeeded so the
// caller can show success/failure feedback.
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the execCommand fallback */
  }
  try {
    // Older browsers / non-secure contexts without the async Clipboard API.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
