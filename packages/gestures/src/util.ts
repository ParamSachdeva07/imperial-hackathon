/**
 * Index access that fails loudly instead of yielding `undefined`
 * (the repo compiles with `noUncheckedIndexedAccess`). MediaPipe always returns
 * 21 landmarks per hand, so a miss here is a real bug, not a case to handle.
 */
export function at<T>(arr: ArrayLike<T>, i: number): T {
  const v = arr[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range (length ${arr.length})`);
  return v;
}
