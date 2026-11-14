/** TypeSafe limits each Choice question, independently of accessibility node count. */
export const MAX_JEV_CHOICES = 255;

export function nativeActionBudget(canGoUp: boolean, canComplete: boolean): number {
  // STOP, optional DONE, and optional GO_PARENT / GO_ROOT are added by the broker.
  return MAX_JEV_CHOICES - 1 - Number(canComplete) - (canGoUp ? 2 : 0);
}
