// Folding a derived timeframe out of the base timeframe's tiles, in the browser.
//
// The tile tree holds only the intervals the store physically holds -- 5s/1m/1h/1D/1M. Every
// other timeframe the period bar offers (3m, 15m, 20m, 30m, 2h, 4h, 8h, 3D, 1W, 2W, 3M, 12M,
// 1Y) is folded here, from the tiles of the interval it derives from, rather than published as
// a tree of its own. wmarketdata's `tiles/derived.py` does the identical thing server-side; the
// grid arithmetic on both sides is `Interval`'s, and this file's half of it is the port in
// `../replay/timeframes.ts`, which is asserted against wmarkettypes bar for bar by
// `../replay/fixtures/boundaries.json`.
//
// Two rules carry the whole thing, and neither is about the aggregation:
//
//  1. **A candle is answerable only when the source covers its whole span.** The source's
//     `coveredTo` lands mid-candle almost every time, and a candle folded from half its rows
//     is not a short answer -- it is a real timestamp carrying a wrong high, low and close,
//     which no consumer can tell from a closed bar. So coverage stops at the first candle the
//     source does not cover whole (`foldedCoveredTo`).
//
//  2. **The read widens to whole candles; only the answer is clipped.** A candle opening inside
//     the requested window closes outside it. Folding it from the rows inside the window alone
//     is the same wrong bar by another route, so the source rows are taken to the candle's
//     close and the fold is trimmed afterwards, on the candle's own label.
//
// The schedule is the third thing, and it arrives as DATA rather than as a name: the manifest
// states the instrument's zone and its day -- two offsets from the midnight that dates a
// session, plus whether every calendar day trades -- and every boundary below is computed from
// those (`timeframes.ts`'s `schedule*` functions, pinned against wmarkettypes for all three
// schedules by `fixtures/boundaries.json`).
//
//   forex     (-7, +17)  the day opens 17:00 the evening before its date, closes 17:00 on it
//   crypto    ( 0, +24)  every day trades; a close IS the next open
//   equities  (+9, +16)  opens 09:00, closes 16:00; the overnight belongs to no candle
//
// The equity anchor is 09:00 while the market opens at 09:30 -- the anchor is the hour the
// session falls in, so the first candle of the day carries half an hour less data. A market
// with a different anchor needs no change here, which is the reason the geometry travels
// instead of an asset class.
//
// A manifest from before the field existed says nothing about its day, and nothing is not a
// licence to assume the FX week: that build might have been describing any of the three. Such
// a series is simply not folded until its tree is next built.

import type { KLineData } from 'klinecharts'
import {
  type DayGeometry,
  scheduleIntervalEnd,
  scheduleIntervalStart,
  scheduleIsMarketOpen,
  scheduleNextIntervalStart,
  scheduleWireShift
} from '../replay/timeframes'
import type { TileManifest } from './manifest'

/** The tiled intervals, in the store's own terms: the vendor's minimum intraday interval plus
 * 1m/1h/1D/1M. Mirrors `wmarketdata.apps.ohlcv.source_interval`, which is the single statement
 * of what is stored -- if that gains an interval, this is the other place to say so. */
const STORED = new Set(['5s', '1m', '1h', '1D', '1M'])

const PATTERN = /^([1-9][0-9]*)([smhDWMY])$/

/**
 * The tiled interval `code` folds from, or null when it is tiled itself.
 *
 * The mapping is `source_interval`'s: weeks and n-day from `1D`, years from `1M`, and any
 * other multiple from `1` of its own unit.
 *
 * Sub-minute multiples (`10s`, `30s`) answer null rather than `5s`, because the seconds floor
 * is the VENDOR's (OANDA has no `1s`) and a tile manifest does not carry it. Nothing selects
 * one today — `/capabilities` advertises no seconds interval — and a fold that guessed the
 * floor would be wrong for the first vendor with a different one.
 */
export function sourceInterval(code: string): string | null {
  if (STORED.has(code)) return null
  const m = PATTERN.exec(code)
  if (!m) return null
  const number = Number(m[1])
  const unit = m[2]
  if (unit === 'W') return '1D'
  if (unit === 'Y') return '1M'
  if (number > 1) {
    const base = `1${unit}`
    return STORED.has(base) ? base : null
  }
  return null
}

/** The day geometry a manifest states, or null when it states none (a build from before the
 * field existed). Null is the fold declining, which costs a fallback to /getbars; a wrong
 * answer here would cost wrong bars, and a manifest that says nothing about its schedule
 * might be describing any of the three. */
export function manifestDay(manifest: TileManifest): DayGeometry | null {
  const day = manifest.day
  if (day === undefined || manifest.tz === undefined) return null
  if (typeof day.open !== 'number' || typeof day.close !== 'number') return null
  return { openOffset: day.open, closeOffset: day.close, everyDayTrades: Boolean(day.everyDay) }
}

/** The instrument's own clock, from the manifest -- never a constant. Only ever read once
 * `manifestSchedule` has confirmed the manifest states one. */
export function manifestTz(manifest: TileManifest): string {
  return manifest.tz ?? 'America/New_York'
}

/**
 * The wire instant a folded series answers in full, from its source's.
 *
 * The open of the first candle the source does NOT cover whole, so a caller clips with `<`
 * exactly as it does against a manifest's own `coveredTo`.
 *
 * The market-closed case is the one worth stating: a tile period boundary routinely lands in
 * the weekend, and flooring an instant there gives a candle open the grid runs through but no
 * candle ever opens on. Stepping to the next real open covers both that and the ordinary
 * "this candle is complete" case, because `nextIntervalStart` steps over the closed window
 * rather than into it.
 */
export function foldedCoveredTo(
  code: string,
  source: string,
  sourceCoveredTo: number,
  tz: string,
  day: DayGeometry
): number {
  const trueMs = sourceCoveredTo - scheduleWireShift(source, day)
  const open = scheduleIntervalStart(code, trueMs, tz, day)
  const complete = scheduleIntervalEnd(code, open, tz, day) <= trueMs
  const first =
    complete || !scheduleIsMarketOpen(open, tz, day)
      ? scheduleNextIntervalStart(code, open, tz, day)
      : open
  return first + scheduleWireShift(code, day)
}

/** The wire instant a folded series begins at: the candle holding the source's first bar.
 *
 * Deliberately not rounded up -- the first candle of a series is folded from whatever history
 * starts with, which is what /getbars returns for the same range.
 *
 * The window path does not need this (it clips against the SOURCE's `coveredFrom`, on the
 * source's own clock, inside `tilesUpTo`). It is here as the pair of `foldedCoveredTo` and
 * because the server's `covered_from_ms` answers `get_first_timestamp` from it -- the two
 * edges of a folded series are stated together or one of them drifts. */
export function foldedCoveredFrom(
  code: string,
  source: string,
  sourceCoveredFrom: number,
  tz: string,
  day: DayGeometry
): number {
  const trueMs = sourceCoveredFrom - scheduleWireShift(source, day)
  return (
    scheduleIntervalStart(code, trueMs, tz, day) + scheduleWireShift(code, day)
  )
}

/** The source range whose rows fold into every `code` candle of `[from, to)`, as WIRE instants
 * on the source's clock. Both edges widen to whole candles; the right edge is the one that
 * matters (rule 2 above). */
export function sourceWindow(
  code: string,
  source: string,
  from: number,
  to: number,
  tz: string,
  day: DayGeometry
): { from: number; to: number } {
  const shift = scheduleWireShift(code, day)
  const sourceShift = scheduleWireShift(source, day)
  const lo = scheduleIntervalStart(code, from - shift, tz, day)
  const lastOpen = scheduleIntervalStart(code, to - shift - 1, tz, day)
  const hi = scheduleIntervalEnd(code, lastOpen, tz, day)
  return { from: lo + sourceShift, to: Math.max(hi, to - shift) + sourceShift }
}

/**
 * Fold source bars into `code` candles.
 *
 * `bars` are the source's, on its own wire clock and ascending; the result is on the target's.
 * Market-closed rows are dropped first, which is what `aggregate_ohlcv` does server-side and
 * the reason `isMarketOpen` is in the port at all -- stored data can carry rows the calculation
 * must not see.
 *
 * Grouping is a single pass over already-sorted rows rather than a map keyed by bucket: the
 * source is ordered, so a bucket ends exactly where its open changes.
 */
export function fold(
  code: string,
  source: string,
  bars: readonly KLineData[],
  tz: string,
  day: DayGeometry
): KLineData[] {
  const out: KLineData[] = []
  const sourceShift = scheduleWireShift(source, day)
  const shift = scheduleWireShift(code, day)
  let openMs = Number.NaN
  let current: KLineData | null = null
  for (const bar of bars) {
    const at = bar.timestamp - sourceShift
    if (!scheduleIsMarketOpen(at, tz, day)) continue
    const bucket = scheduleIntervalStart(code, at, tz, day)
    if (current === null || bucket !== openMs) {
      if (current !== null) out.push(current)
      openMs = bucket
      current = {
        timestamp: bucket + shift,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume ?? 0
      }
      continue
    }
    current.high = Math.max(current.high, bar.high)
    current.low = Math.min(current.low, bar.low)
    current.close = bar.close
    current.volume = (current.volume ?? 0) + (bar.volume ?? 0)
  }
  if (current !== null) out.push(current)
  return out
}
