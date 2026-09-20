/** CSS viewport must match the requested physical bounds after monitor DPI settles. */
export function detailViewportReady(width: number, height: number, scale: number, physicalWidth: number, physicalHeight: number) {
  if (scale <= 0) return false;
  const tol = Math.max(3, scale * 1.5);
  return Math.abs(width * scale - physicalWidth) <= tol
    && Math.abs(height * scale - physicalHeight) <= tol;
}

/** A timeout is failure, never permission to show a partially resized WebView. */
export function waitForDetailLayout(matches: () => boolean, present: () => Promise<boolean>, timeout: () => void) {
  let stopped = false, stable = 0;
  const deadline = Date.now() + 5000;
  let timer: ReturnType<typeof setTimeout>;
  const check = async () => {
    if (stopped) return;
    stable = matches() ? stable + 1 : 0;
    if (stable >= 2) {
      try { if (await present()) return; } catch { /* Retry transient IPC failures within the deadline. */ }
    }
    if (stopped) return;
    if (Date.now() >= deadline) { timeout(); return; }
    timer = setTimeout(() => { void check(); }, 50);
  };
  timer = setTimeout(() => { void check(); }, 0);
  return () => { stopped = true; clearTimeout(timer); };
}
