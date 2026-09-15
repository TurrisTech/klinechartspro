import type { ArevGeneration } from '../arev/api'
import type { LabPoint } from './rules'

// The labels the `prior` rule counts, rebuilt in the browser from the bars exactly as each
// generation labels a sample (wtradingresearch indicators/wy/), and stamped at the first bar at
// which each is knowable -- which is what keeps the prior at bar t free of lookahead: only labels
// stamped strictly before t count.
//
//   * arev19 / arev20 / arev21 / arev23: a sample's label is +1 when the NEXT sample closes
//     higher than it did (a tie is -1), stamped at that next sample's bar.
//   * arev22: a sample's label is +1 when the body midpoint `(open + close) / 2` of the bar
//     HORIZON bars later is above the sample bar's (a tie is -1), stamped at that later bar.
//
// Rebuilt labels matched arev21's stored training rows on 99.9-100% of samples on every EURUSD
// timeframe (notes/research/arev21-outlier/README.md §1). One thing the browser cannot see: a
// sample the model skipped because its RSI features were still warming up still has a row here
// -- only the first few dozen bars of a series.

export interface LabBar {
  date: number
  open: number
  close: number
}

export interface Labels {
  /** Stamps ascending. */
  stamps: number[]
  /** 1 where the label is up. */
  ups: Uint8Array
}

/** arev22's fixed label horizon (wtradingresearch arev22.DEFAULT_HORIZON). */
export const AREV22_HORIZON = 10

export function buildLabels(generation: ArevGeneration, points: readonly LabPoint[], bars: readonly LabBar[]): Labels {
  const index = new Map<number, number>()
  for (let i = 0; i < bars.length; i++) index.set(bars[i].date, i)
  const pairs: Array<[number, number]> = []
  if (generation === 'arev22') {
    for (const pt of points) {
      if (!pt.atCross) continue
      const i = index.get(pt.date)
      if (i === undefined || i + AREV22_HORIZON >= bars.length) continue
      const later = bars[i + AREV22_HORIZON]
      const midNow = (bars[i].open + bars[i].close) / 2
      const midLater = (later.open + later.close) / 2
      pairs.push([later.date, midNow < midLater ? 1 : 0])
    }
    pairs.sort((a, b) => a[0] - b[0])
  } else {
    let prevClose = Number.NaN
    for (const pt of points) {
      if (!pt.atCross) continue
      const i = index.get(pt.date)
      if (i === undefined) {
        // A sample whose bar is not loaded breaks the chain: the next label would pair two
        // samples that were not consecutive.
        prevClose = Number.NaN
        continue
      }
      const close = bars[i].close
      if (Number.isFinite(prevClose)) pairs.push([pt.date, prevClose < close ? 1 : 0])
      prevClose = close
    }
  }
  return { stamps: pairs.map((p) => p[0]), ups: Uint8Array.from(pairs.map((p) => p[1])) }
}

/** Fewer labels than this before a bar and its prior is not a rate worth drawing. */
export const MIN_PRIOR_LABELS = 50

/** Per point, the up-rate of the last `count` labels stamped strictly before its date; NaN
 * where fewer than min(count, MIN_PRIOR_LABELS) exist. `dates` ascending. */
export function priorCentre(dates: readonly number[], labels: Labels, count: number): Float64Array {
  const cum = new Float64Array(labels.ups.length + 1)
  for (let i = 0; i < labels.ups.length; i++) cum[i + 1] = cum[i] + labels.ups[i]
  const out = new Float64Array(dates.length).fill(Number.NaN)
  const floor = Math.min(count, MIN_PRIOR_LABELS)
  let k = 0 // labels stamped strictly before dates[i]; dates ascend, so it only moves forward
  dates.forEach((date, i) => {
    while (k < labels.stamps.length && labels.stamps[k] < date) k++
    const taken = Math.min(count, k)
    if (taken < floor || taken === 0) return
    out[i] = (cum[k] - cum[k - taken]) / taken
  })
  return out
}
