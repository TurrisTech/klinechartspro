// The AREV lab's signal rules, as pure functions over one generation's points in date order.
//
// The adaptive rules answer one question: is `p` unusual COMPARED WITH WHAT IT HAS BEEN LATELY?
// "Lately" is a span of days -- the last 90 days of p, not the last 50 of anything -- which is
// the same shape of window the model itself is trained on, and it is what makes the lines
// computable in a browser: the history to load is the window, exactly, rather than an estimate
// of how many bars hold N of something.
//
//   * A bar counts when its `p` is finite and at least `minNeighbours` samples stand behind it.
//     `samplesOnly` narrows that to the bars the model actually predicts on (`atCross`), which is
//     what the published rule and the server's variants do -- see config.ts.
//   * A bar's lines come from the counting bars strictly before it -- the previous `window` of
//     them for rank, those within `days` for median, the labels within `days` for prior -- so a
//     line is known at the bar's close and never moves afterwards.
//   * An arrow is an ENTRY: a counting bar in the long zone (`p >= hi`, and not also `p <= lo`)
//     whose predecessor was not; the short side mirrors it. Extremes come in runs, so a level
//     trigger would print an arrow on every bar of a trend.
//   * The fixed rule is the published one, a LEVEL: every counting bar with `|p - 0.5| >=
//     confidence`, long when p > 0.5 (wdashboard-server services/arev.py `signal_of`).
//
// Quantiles are numpy's default (linear interpolation), which is what the server uses. The
// server holds the same rules in services/arev21outlier.py -- `rolling_lines` counts bars for
// rank and spans days for median, exactly as here -- and generates the fixture `rules.test.ts`
// runs (wdashboard-server tests/arevlab/), which pins the quantile, the band, both rolling
// windows and the arrows. A rule changed on one side fails on the other.

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

/** A window holding fewer values than this states nothing about what is usual, so its bars are
 * left blank rather than given a line drawn from a handful of points. */
export const MIN_WINDOW_VALUES = 20

export function countingBars(points: readonly LabPoint[], minNeighbours: number, samplesOnly: boolean): boolean[] {
  return points.map((pt) => Number.isFinite(pt.p) && pt.n >= minNeighbours && (!samplesOnly || pt.atCross))
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

/** Per point, a statistic of the counting bars in `[date - spanMs, date)`; NaN where that window
 * holds fewer than MIN_WINDOW_VALUES. Points ascending by date. */
function rollingSpan(
  points: readonly LabPoint[],
  counts: readonly boolean[],
  spanMs: number,
  stat: (sorted: readonly number[]) => [number, number, number]
): RuleLines {
  const size = points.length
  const lines = { centre: nanArray(size), hi: nanArray(size), lo: nanArray(size) }
  const sorted: number[] = []
  // The values in the window, oldest first -- the two pointers are `head` (the next point to
  // admit) and `tail` (the oldest still inside the span).
  const held: LabPoint[] = []
  let head = 0
  let tail = 0
  for (let i = 0; i < size; i++) {
    const date = points[i].date
    // Strictly before this bar, so a bar never judges itself.
    while (head < i) {
      if (counts[head]) {
        insertSorted(sorted, points[head].p)
        held.push(points[head])
      }
      head++
    }
    while (tail < held.length && held[tail].date < date - spanMs) {
      removeSorted(sorted, held[tail].p)
      tail++
    }
    if (sorted.length >= MIN_WINDOW_VALUES) {
      const [c, h, l] = stat(sorted)
      lines.centre[i] = c
      lines.hi[i] = h
      lines.lo[i] = l
    }
  }
  return lines
}

/** Per point, a statistic of the previous `window` COUNTING BARS -- a count, not a span, which
 * is what rank asks for: the top and bottom of p's last N readings, however long those took.
 * NaN until that many precede it. */
function rollingCount(
  points: readonly LabPoint[],
  counts: readonly boolean[],
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
    if (counts[i]) {
      insertSorted(sorted, points[i].p)
      arrival.push(points[i].p)
      if (arrival.length > window) removeSorted(sorted, arrival.shift() as number)
    }
  }
  return lines
}

/** rank's window is a count of bars (the user, 2026-09-17): the last `window` counting bars,
 * whatever span they cover. Its lines are percentiles of exactly that many readings, so what
 * "the top" means does not change with how busy the market has been. */
export function rankLines(points: readonly LabPoint[], counts: readonly boolean[], window: number, q: number): RuleLines {
  return rollingCount(points, counts, window, (s) => [quantileSorted(s, 0.5), quantileSorted(s, q), quantileSorted(s, 1 - q)])
}

export function medianLines(points: readonly LabPoint[], counts: readonly boolean[], spanMs: number, width: number): RuleLines {
  return rollingSpan(points, counts, spanMs, (s) => {
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
export function fixedSides(points: readonly LabPoint[], counts: readonly boolean[], confidence: number): Int8Array {
  const side = new Int8Array(points.length)
  points.forEach((pt, i) => {
    if (counts[i] && Math.abs(pt.p - 0.5) >= confidence) side[i] = pt.p > 0.5 ? 1 : -1
  })
  return side
}

/** +1 / -1 / 0 per point: a counting bar entering its long or short zone. NaN lines compare
 * false, so no arrow fires before a rule's window has filled. */
export function entrySides(points: readonly LabPoint[], counts: readonly boolean[], lines: RuleLines): Int8Array {
  const side = new Int8Array(points.length)
  let prevUp = false
  let prevDown = false
  points.forEach((pt, i) => {
    if (!counts[i]) return
    const up = pt.p >= lines.hi[i] && !(pt.p <= lines.lo[i])
    const down = pt.p <= lines.lo[i] && !(pt.p >= lines.hi[i])
    if (up && !prevUp) side[i] = 1
    else if (down && !prevDown) side[i] = -1
    prevUp = up
    prevDown = down
  })
  return side
}
