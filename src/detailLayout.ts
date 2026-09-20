/** CSS viewport must match the requested physical bounds after monitor DPI settles. */
export function detailViewportReady(width: number, height: number, scale: number, physicalWidth: number, physicalHeight: number) {
  if (scale <= 0) return false;
  const tol = Math.max(3, scale * 1.5);
  return Math.abs(width * scale - physicalWidth) <= tol
    && Math.abs(height * scale - physicalHeight) <= tol;
}
