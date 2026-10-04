import type { KLineData } from 'klinecharts'
import { resolutionDurationMs } from '../periods'
import type { CandleGrid } from '../replay/timeframes'
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
// dates intraday bars by their open, but daily-and-coarser bars by their canonical date --
// the midnight that dates the session in the instrument's own zone (wdashboard-server's
// services/wiredate.py). For the FX week that is `open + 7h`, because a daily candle opens
// at 17:00 the evening BEFORE the session it belongs to; for crypto it is the open itself
// (a day runs midnight to midnight UTC), and for US equities `open - 9h`. Those clocks
// cannot be compared directly: an FX 1D bar labelled 2026-08-21 opens at 17:00 on 2026-08-20,
// so an hourly chart's 17:00 bar and that daily bar's open are the SAME instant while their
// wire dates are seven hours apart. Every comparison below is therefore made on absolute
// opens, converting each side out of its own interval's wire clock first, and the marker's
// chart bar is then read back off the chart's own array.
//
// The conversion is the PANE'S INSTRUMENT'S, handed in as its `CandleGrid`
// (replay/timeframes.ts). Until 2026-10-04 it was the forex 7h for every instrument, and on
// prod's coinbase BTCUSD that drew every 1D vote on the hourly bar seven hours BEFORE the
// vote existed -- measured on five votes, 2026-08-21 to 09-03, each placed at 17:00 UTC on
// the day it was cast instead of at the next midnight: lookahead, the one thing this module
// exists to make impossible.

/** A bar-axis timestamp as it appears on the wire -> the instant that bar actually opens. */
export function toAbsolute(interval: string, wireMs: number, clock: CandleGrid): number {
  return clock.fromWire(interval, wireMs)
}

/** The inverse of `toAbsolute`, for stating a window back to the server in its own clock. */
export function fromAbsolute(interval: string, absMs: number, clock: CandleGrid): number {
  return clock.toWire(interval, absMs)
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

/** One arev21 signal and the instant it became knowable -- which is also what places it on
 * a chart: on the bar in force at that instant. */
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
  /** The pane's instrument's candle grid: how each interval's wire dates map to opens. */
  clock: CandleGrid
  /** Every arev21 point fetched for the source timeframe; non-signals are ignored here. */
  points: Iterable<ArevPoint>
  /** The source timeframe's bar opens as the wire states them, ascending. */
  grid: number[]
  /** The chart's own bars, ascending, as klinecharts holds them. */
  chartBars: KLineData[]
}

/**
 * Every labelled vote in `points`, with the instant it became knowable: its source bar's
 * close, read as the successor bar's open on `grid`, in absolute time. Unordered, as `points`
 * was.
 *
 * A vote whose bar has no successor in the grid is the NEWEST vote at the live edge, and it is
 * kept, at its bar's own close: `open + one nominal source bar`. It cannot be dropped as "not
 * closed yet", because a vote only exists once its bar has closed -- the research feed writes
 * arev21 off closed bars, and every values route is clamped to closed bars under a replay
 * clock (`services/asof.py`). And its successor is never in the grid there, because the grid
 * is `/getbars`, which serves closed bars only: the successor is the bar still forming. Waiting
 * for it to close held every new vote back one more of its own bars -- a day on 1D -- which a
 * live overlay cannot afford (user, 2026-10-01: a 2h signal the sub-pane showed at 03:00 had
 * no MTF marker).
 *
 * `open + nominal length` is the close for every source this overlay reads: they are 1D or
 * intraday, a fixed number of milliseconds long, and on the FX and crypto grids no US DST
 * transition falls inside one (it is the server's own `get_interval_end`). Where the close is
 * NOT the successor's open -- into a weekend -- `chartBarAt` takes the first chart bar to open
 * after it, which is where the successor's open would have put it.
 */
export function knowableSignals(sourceInterval: string, points: Iterable<ArevPoint>, grid: number[], clock: CandleGrid): ShiftedSignal[] {
  const out: ShiftedSignal[] = []
  if (grid.length === 0) return out
  const gridAbs = grid.map((ms) => toAbsolute(sourceInterval, ms, clock))
  const durationMs = resolutionDurationMs(sourceInterval)
  for (const point of points) {
    const label = arevSignal(point)
    if (!label) continue
    const castAbs = toAbsolute(sourceInterval, point.date, clock)
    // The successor bar: the first grid open strictly after the one the vote was cast on.
    // Strictly, so a vote is never placed back on its own bar.
    const next = upperBound(gridAbs, castAbs)
    const knownAt = next < gridAbs.length ? gridAbs[next] : castAbs + durationMs
    out.push({ sourceDate: point.date, knownAt, p: point.p, up: label === 'long' })
  }
  return out
}

/** The chart's bar opens in absolute time, for `chartBarAt`. */
export function chartOpens(chartInterval: string, chartBars: KLineData[], clock: CandleGrid): number[] {
  return chartBars.map((bar) => toAbsolute(chartInterval, bar.timestamp, clock))
}

/**
 * Index of the chart bar in force at `knownAt` (absolute), or -1 when no loaded bar is.
 *
 * The last one to have opened at or before it. At or before, not strictly after, so a
 * source close that coincides exactly with a chart bar's open lands ON that bar -- which is
 * the aligned case and the common one (a 1D close at 17:00 is an hourly bar's open, a 4h
 * close at 08:00 is an hourly and a 2h bar's open). -1 when it became knowable before the
 * loaded window began (its place is off screen to the left, not on the leftmost bar).
 *
 * The last chart bar is the one bar whose END the chart does not state: every other is
 * bounded by its successor's open. Left unbounded it swallows everything after it -- every
 * vote from the controller's forward fetch pad, and at the live edge every vote newer than
 * the loaded bars, resolves to "the last bar" and stacks there. That is not a cosmetic
 * pile-up but lookahead: votes that had not been cast yet, drawn on the newest candle. So it
 * is bounded by the chart interval's nominal length, which decides only WHETHER to draw and
 * never WHERE -- and which is exact for every interval that can reach this, because a source
 * is never finer than the chart and no source is coarser than 1D, so the chart is 1D or
 * intraday. Those bars are a fixed number of milliseconds long: a daily candle spans 17:00 to
 * 17:00 with no US DST transition inside it, and an intraday one is its own unit. A vote
 * falling inside the still-forming last bar is kept, which is the point of bounding rather
 * than dropping the last bar outright.
 *
 * The same bound applies to EVERY bar, not only the last: a bar that had already closed by
 * `knownAt` was not in force then, and the signal belongs on the next bar to open. That is
 * the case whenever `knownAt` falls in a gap between chart bars -- a source bar's close into
 * the weekend (`knowableSignals`), or a chart bar missing from the data -- where taking the
 * bar before the gap would draw a vote on a candle that had finished before it was cast.
 */
export function chartBarAt(knownAt: number, chartAbs: number[], chartInterval: string): number {
  const at = upperBound(chartAbs, knownAt) - 1
  if (at < 0) return -1
  if (knownAt < chartAbs[at] + resolutionDurationMs(chartInterval)) return at
  return at + 1 < chartAbs.length ? at + 1 : -1
}

/**
 * Place each source-timeframe signal on the chart bar that was open when it became
 * knowable, keyed by that bar's own timestamp.
 *
 * A signal is dropped rather than approximated in three cases, all of which are the
 * honest answer:
 *
 *   * it became knowable before the first chart bar loaded — its marker is off screen to
 *     the left, not on the leftmost bar;
 *   * it became knowable after the last chart bar had closed — the bar it belongs on is
 *     not loaded, so it is not drawn at all rather than heaped onto the newest one;
 *   * the source timeframe is finer than the chart's, which `shiftSignals` refuses
 *     outright (see `isFinerThan`) — hundreds of sub-bar votes collapsing onto one
 *     candle is not a reading of anything, and the caller says so in the legend instead.
 */
export function shiftSignals(input: ShiftInput): Map<number, ShiftedSignal[]> {
  const { sourceInterval, chartInterval, clock, points, grid, chartBars } = input
  const placed = new Map<number, ShiftedSignal[]>()
  if (chartBars.length === 0 || grid.length === 0) return placed
  if (isFinerThan(sourceInterval, chartInterval)) return placed

  // Both sides onto one clock before anything is compared. See the module note: the wire
  // dates these two intervals on different clocks whenever exactly one of them is
  // daily-or-coarser, which is the common case for this overlay.
  const chartAbs = chartOpens(chartInterval, chartBars, clock)

  for (const signal of knowableSignals(sourceInterval, points, grid, clock)) {
    const at = chartBarAt(signal.knownAt, chartAbs, chartInterval)
    if (at < 0) continue
    const key = chartBars[at].timestamp
    const existing = placed.get(key)
    if (existing) existing.push(signal)
    else placed.set(key, [signal])
  }
  return placed
}
