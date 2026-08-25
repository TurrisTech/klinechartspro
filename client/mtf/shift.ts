import type { KLineData } from 'klinecharts'
import { resolutionDurationMs, resolutionToPeriod } from '../periods'
import { arevSignal, type ArevPoint } from '../arev/api'

// Where a higher-timeframe vote belongs on a lower-timeframe chart.
//
// A vote cast on a 4h bar is not KNOWN until that bar closes — the sample that produced
// it is the bar's own extreme, and the bar is not finished being extreme until it is
// finished. Drawing it on the bar it was cast on would put information on the chart
// four hours before it existed, which is the ordinary way a multi-timeframe overlay
// invents an edge it does not have. So every vote is shifted forward by one bar of ITS
// OWN timeframe: a 1D vote dated 2026-08-20 draws on 2026-08-21, a 4h vote at 04:00
// draws at 08:00.
//
// "One bar forward" is a market question, not an arithmetic one, which is why this
// module is handed a bar GRID rather than a duration. A 4h bar opening Friday 13:00 New
// York is followed by one opening Sunday 17:00; `t + 4h` would place its vote inside the
// weekend, on a bar that does not exist. The grid comes from the server (api.ts), which
// owns the candle boundaries — see the workspace CLAUDE.md's "Candle boundary rules".
//
// The second thing this module does is reconcile two different bar CLOCKS. The wire
// dates intraday bars by their open, but daily-and-coarser bars by their canonical date
// — 00:00 New York of the session, which is `open + 7h`, because a daily candle opens at
// 17:00 the evening BEFORE the session it belongs to (wdashboard-server's
// services/wiredate.py). Those two clocks cannot be compared directly: the 1D bar
// labelled 2026-08-21 opens at 17:00 on 2026-08-20, so an hourly chart's 17:00 bar and
// that daily bar's open are the SAME instant while their wire dates are seven hours
// apart. Every comparison below is therefore made on absolute opens, converting each
// side out of its own interval's wire clock first, and the marker's chart bar is then
// read back off the chart's own array. Comparing wire dates directly is the bug this
// exists to make impossible; it would put every daily signal seven hours late.

/** 17:00 (the session anchor a daily-or-coarser candle opens at) to 00:00. Mirrors
 * wdashboard-server's `wiredate.SESSION_DATE_OFFSET_MS`, mirrored rather than derived
 * for the same reason the server states it as a constant: US DST transitions happen at
 * 02:00 local and never inside a 17:00 -> 00:00 window, so the offset is exact in
 * absolute time and there is no zone to look up. */
const SESSION_DATE_OFFSET_MS = 7 * 3_600_000

/** Whether this interval's bars are dated by canonical date on the wire. Mirrors
 * `wiredate.session_dated`: the `D`/`W`/`M`/`Y` units, never the intraday ones. */
export function sessionDated(interval: string): boolean {
  const period = resolutionToPeriod(interval)
  if (!period) return false
  return (
    period.timespan === 'day' ||
    period.timespan === 'week' ||
    period.timespan === 'month' ||
    period.timespan === 'year'
  )
}

/** A bar-axis timestamp as it appears on the wire -> the instant that bar actually opens. */
export function toAbsolute(interval: string, wireMs: number): number {
  return sessionDated(interval) ? wireMs - SESSION_DATE_OFFSET_MS : wireMs
}

/** The inverse of `toAbsolute`, for stating a window back to the server in its own clock. */
export function fromAbsolute(interval: string, absMs: number): number {
  return sessionDated(interval) ? absMs + SESSION_DATE_OFFSET_MS : absMs
}

/** Whether `source` is a strictly finer timeframe than `chart`.
 *
 * Compared on NOMINAL durations, which is what `resolutionDurationMs` is for (periods.ts
 * documents it as ordering-only). That is sound here because it decides an ordering
 * between two interval CODES, never a bar boundary — and no two codes this client offers
 * are close enough for a mean-month or mean-year approximation to reorder them. */
export function isFinerThan(source: string, chart: string): boolean {
  return resolutionDurationMs(source) < resolutionDurationMs(chart)
}

/** One arev21 signal, placed on the chart bar at which it became knowable. */
export interface ShiftedSignal {
  /** Wire date of the SOURCE bar the vote was cast on — what the research row is keyed by. */
  sourceDate: number
  /** The instant the source bar closed: its successor's open, in absolute time. */
  knownAt: number
  /** P(price rises to the next sample), as the server computed it. */
  p: number
  /** The server's label: `'long'` argues up. Read off the published label, not off `p`. */
  up: boolean
}

/** First index of `sorted` holding a value strictly greater than `x`, or `sorted.length`. */
function upperBound(sorted: number[], x: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

export interface ShiftInput {
  sourceInterval: string
  chartInterval: string
  /** Every arev21 point fetched for the source timeframe; non-signals are ignored here. */
  points: Iterable<ArevPoint>
  /** The source timeframe's bar opens as the wire states them, ascending. */
  grid: number[]
  /** The chart's own bars, ascending, as klinecharts holds them. */
  chartBars: KLineData[]
}

/**
 * Place each source-timeframe signal on the chart bar that was open when it became
 * knowable, keyed by that bar's own timestamp.
 *
 * A signal is dropped rather than approximated in three cases, all of which are the
 * honest answer:
 *
 *   * its source bar has no successor in the grid — the bar has not closed yet, so the
 *     vote is not knowable and drawing it would be lookahead;
 *   * it became knowable before the first chart bar loaded — its marker is off screen to
 *     the left, not on the leftmost bar;
 *   * it became knowable after the last chart bar had closed — the bar it belongs on is
 *     not loaded, so it is not drawn at all rather than heaped onto the newest one;
 *   * the source timeframe is finer than the chart's, which `shiftSignals` refuses
 *     outright (see `isFinerThan`) — hundreds of sub-bar votes collapsing onto one
 *     candle is not a reading of anything, and the caller says so in the legend instead.
 */
export function shiftSignals(input: ShiftInput): Map<number, ShiftedSignal[]> {
  const { sourceInterval, chartInterval, points, grid, chartBars } = input
  const placed = new Map<number, ShiftedSignal[]>()
  if (chartBars.length === 0 || grid.length === 0) return placed
  if (isFinerThan(sourceInterval, chartInterval)) return placed

  // Both sides onto one clock before anything is compared. See the module note: the wire
  // dates these two intervals on different clocks whenever exactly one of them is
  // daily-or-coarser, which is the common case for this overlay.
  const gridAbs = grid.map((ms) => toAbsolute(sourceInterval, ms))
  const chartAbs = chartBars.map((bar) => toAbsolute(chartInterval, bar.timestamp))

  for (const point of points) {
    const label = arevSignal(point)
    if (!label) continue
    const castAbs = toAbsolute(sourceInterval, point.date)
    // The successor bar: the first grid open strictly after the one the vote was cast on.
    // Strictly, so a vote is never placed back on its own bar.
    const next = upperBound(gridAbs, castAbs)
    if (next >= gridAbs.length) continue // not closed yet, or the grid stops here
    const knownAt = gridAbs[next]
    // The chart bar in force at that instant: the last one to have opened at or before
    // it. At or before, not strictly after, so a source close that coincides exactly with
    // a chart bar's open lands ON that bar -- which is the aligned case and the common
    // one (a 1D close at 17:00 is an hourly bar's open, a 4h close at 08:00 is an hourly
    // and a 2h bar's open).
    const at = upperBound(chartAbs, knownAt) - 1
    if (at < 0) continue // knowable before the loaded window began
    // The last chart bar is the one bar whose END the chart does not state: every other
    // is bounded by its successor's open. Left unbounded it swallows everything after it
    // -- every vote from the controller's forward fetch pad, and at the live edge every
    // vote newer than the loaded bars, resolves to "the last bar" and stacks there. That
    // is not a cosmetic pile-up but lookahead: votes that had not been cast yet, drawn on
    // the newest candle. Bounded by the chart interval's nominal length, which decides
    // only WHETHER to draw and never WHERE -- and which is exact for every interval that
    // can reach this line, because a source is never finer than the chart (above) and no
    // source is coarser than 1D, so the chart is 1D or intraday. Those bars are a fixed
    // number of milliseconds long: a daily candle spans 17:00 to 17:00 with no US DST
    // transition inside it, and an intraday one is its own unit. A vote falling inside
    // the still-forming last bar is kept, which is the point of bounding rather than
    // dropping the last bar outright.
    if (at === chartBars.length - 1 && knownAt >= chartAbs[at] + resolutionDurationMs(chartInterval)) continue
    const key = chartBars[at].timestamp
    const signal: ShiftedSignal = { sourceDate: point.date, knownAt, p: point.p, up: label === 'long' }
    const existing = placed.get(key)
    if (existing) existing.push(signal)
    else placed.set(key, [signal])
  }
  return placed
}
