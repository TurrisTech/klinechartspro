// Binary search over an ascending list of instants, shared by the lab's pure modules (kept apart
// from readings.ts so that they do not pull in klinecharts' templates with it).

/** Index of the last element of `sorted` that is <= `x`, or -1. */
export function lastAtOrBefore(sorted: readonly number[], x: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}
