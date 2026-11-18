/** Mean per-channel change (0-255) above which a frame counts as a new shot. */
export const AMBIENT_CUT_THRESHOLD = 28;

/** Mean absolute difference of two RGBA buffers of the same size, ignoring alpha. */
export function frameDifference(previous: ArrayLike<number>, next: ArrayLike<number>): number {
  const pixels = Math.min(previous.length, next.length) / 4;
  if (!pixels) return 0;
  let total = 0;
  for (let i = 0; i < pixels * 4; i += 4)
    total +=
      Math.abs(next[i] - previous[i]) +
      Math.abs(next[i + 1] - previous[i + 1]) +
      Math.abs(next[i + 2] - previous[i + 2]);
  return total / (pixels * 3);
}

/** Whether the light should jump straight to the new frame instead of easing toward it. */
export function isSceneCut(previous: ArrayLike<number> | null, next: ArrayLike<number>): boolean {
  return !!previous && frameDifference(previous, next) > AMBIENT_CUT_THRESHOLD;
}
