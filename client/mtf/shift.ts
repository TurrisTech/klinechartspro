import type { KLineData } from 'klinecharts'
import { resolutionDurationMs } from '../periods'
import type { CandleGrid } from '../replay/timeframes'

// Where a higher-timeframe signal belongs on a lower-timeframe chart.
//
// A signal cast on a 4h bar is not KNOWN until that bar closes — the sample that produced
// it is the bar's own extreme, and the bar is not finished being extreme until it is
// finished. Drawing it on the bar it was cast on would put information on the chart
// four hours before it existed, which is the ordinary way a multi-timeframe overlay
// invents an edge it does not have. So every signal is drawn on the chart bar that was open
// at the instant it became knowable.
//
// That instant is the server's (`GET /mtf/graph`, wdashboard-server services/mtfgraph.py): the
// source candle's close, `get_interval_end`, on the instrument's own schedule -- a market
// question the server owns the rules for (the workspace CLAUDE.md's "Candle boundary rules").
// Until 0.56.0 this module worked it out itself, as the successor bar's open off a fetched bar
// grid; the two place every signal on the same chart bar, because no chart bar opens inside
// the market-closed gap where they differ.
//
// What is left here is the chart's half, and it has to reconcile two different bar CLOCKS. The wire
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
 * bounded by its successor's open. Left unbounded it swallows everything after it -- at the
 * live edge every signal newer than the loaded bars would resolve to "the last bar" and stack
 * there. That is not a cosmetic
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
 * the weekend, or a chart bar missing from the data -- where taking the
 * bar before the gap would draw a vote on a candle that had finished before it was cast.
 */
export function chartBarAt(knownAt: number, chartAbs: number[], chartInterval: string): number {
  const at = upperBound(chartAbs, knownAt) - 1
  if (at < 0) return -1
  if (knownAt < chartAbs[at] + resolutionDurationMs(chartInterval)) return at
  return at + 1 < chartAbs.length ? at + 1 : -1
}
