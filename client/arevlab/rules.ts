// The AREV lab's signal rules, as pure functions over one generation's points in date order.
//
// Semantics are the server's (wdashboard-server services/arev21outlier.py), ported rather than
// re-imagined, and `rules.test.ts` holds a fixture generated from that module so the two cannot
// drift:
//
//   * A VALID sample is a sample bar (`atCross`) with `n >= minNeighbours` and a finite p.
//   * A bar's lines come from information strictly BEFORE it -- the previous `window` valid
//     samples, or the labels stamped before it -- so a line is known at the bar's close.
//   * An adaptive arrow is an ENTRY: a valid sample in the long zone (`p >= hi`, and not also
//     `p <= lo`) whose previous valid sample was not; the short side mirrors it. Fresh extremes
//     come in runs, so a level trigger would print an arrow on every bar of a trend.
//   * The fixed rule is the published one, a LEVEL: every valid sample with `|p - 0.5| >=
//     confidence`, long when p > 0.5 and short otherwise (services/arev.py `signal_of`).
//
// Quantiles are numpy's default (linear interpolation), which is what the server uses.

export interface LabPoint {
  date: number
  p: number
  n: number
  atCross: boolean
}

export interface RuleLines {
  centre: Float64Array
  hi: Float64Array
  lo: Float64Array
}

export function validSamples(points: readonly LabPoint[], minNeighbours: number): boolean[] {
  return points.map((pt) => pt.atCross && pt.n >= minNeighbours && Number.isFinite(pt.p))
}

function nanArray(size: number): Float64Array {
  return new Float64Array(size).fill(Number.NaN)
}

/** numpy.quantile(sorted, q) with the default linear method; `sorted` ascending, non-empty. */
export function quantileSorted(sorted: readonly number[], q: number): number {
  const pos = q * (sorted.length - 1)
  const lower = Math.floor(pos)
  const upper = Math.ceil(pos)
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower)
}

function insertSorted(sorted: number[], value: number): void {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid] < value) lo = mid + 1
    else hi = mid
  }
  sorted.splice(lo, 0, value)
}

function removeSorted(sorted: number[], value: number): void {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid] < value) lo = mid + 1
    else hi = mid
  }
  sorted.splice(lo, 1)
}

/** Per point, a statistic of the previous `window` valid samples' p, strictly before it; NaN
 * until that many precede it. */
function rollingWindow(
  points: readonly LabPoint[],
  valid: readonly boolean[],
  window: number,
  stat: (sorted: readonly number[]) => [number, number, number]
): RuleLines {
  const size = points.length
  const lines = { centre: nanArray(size), hi: nanArray(size), lo: nanArray(size) }
  const sorted: number[] = []
  const arrival: number[] = []
  for (let i = 0; i < size; i++) {
    if (sorted.length === window) {
      const [c, h, l] = stat(sorted)
      lines.centre[i] = c
      lines.hi[i] = h
      lines.lo[i] = l
    }
    if (valid[i]) {
      const p = points[i].p
      insertSorted(sorted, p)
      arrival.push(p)
      if (arrival.length > window) removeSorted(sorted, arrival.shift() as number)
    }
  }
  return lines
}

export function rankLines(points: readonly LabPoint[], valid: readonly boolean[], window: number, q: number): RuleLines {
  return rollingWindow(points, valid, window, (s) => [quantileSorted(s, 0.5), quantileSorted(s, q), quantileSorted(s, 1 - q)])
}

export function medianLines(points: readonly LabPoint[], valid: readonly boolean[], window: number, width: number): RuleLines {
  return rollingWindow(points, valid, window, (s) => {
    const m = quantileSorted(s, 0.5)
    return [m, m + width, m - width]
  })
}

export function fixedLines(size: number, confidence: number): RuleLines {
  return {
    centre: new Float64Array(size).fill(0.5),
    hi: new Float64Array(size).fill(0.5 + confidence),
    lo: new Float64Array(size).fill(0.5 - confidence)
  }
}

/** Lines ± `width` around a per-point centre (the prior). */
export function bandLines(centre: Float64Array, width: number): RuleLines {
  return {
    centre,
    hi: centre.map((c) => c + width),
    lo: centre.map((c) => c - width)
  }
}

/** The published fixed rule: a level, not an entry. */
export function fixedSides(points: readonly LabPoint[], valid: readonly boolean[], confidence: number): Int8Array {
  const side = new Int8Array(points.length)
  points.forEach((pt, i) => {
    if (valid[i] && Math.abs(pt.p - 0.5) >= confidence) side[i] = pt.p > 0.5 ? 1 : -1
  })
  return side
}

/** +1 / -1 / 0 per point: a valid sample entering its long or short zone. NaN lines compare
 * false, so no arrow fires before a rule has its window. */
export function entrySides(points: readonly LabPoint[], valid: readonly boolean[], lines: RuleLines): Int8Array {
  const side = new Int8Array(points.length)
  let prevUp = false
  let prevDown = false
  points.forEach((pt, i) => {
    if (!valid[i]) return
    const up = pt.p >= lines.hi[i] && !(pt.p <= lines.lo[i])
    const down = pt.p <= lines.lo[i] && !(pt.p >= lines.hi[i])
    if (up && !prevUp) side[i] = 1
    else if (down && !prevDown) side[i] = -1
    prevUp = up
    prevDown = down
  })
  return side
}
