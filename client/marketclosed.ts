import type { KLineData } from 'klinecharts'
import { dayGeometryOf } from './daygeometry'
import {
  type DayGeometry,
  scheduleIntervalStart,
  scheduleIsMarketOpen,
  scheduleWireShift
} from './replay/timeframes'
import type { MarketHours } from './symbols'

// PURE. Drop bars the chart must not draw: rows whose label is not a legal candle open for
// the instrument's own schedule.
//
// The store keeps them on purpose and the server serves exactly what the vendor sent -- they
// are the vendor's bars, not a defect. Measured on prod `oanda:EURUSD:1D` 2026-09-21: 818 of
// 7,148 labels (11%) fall outside the FX week, in two kinds. 556 are Sat 17:00 with a mean
// 631 ticks -- real weekend quoting, from the era when OANDA's week included weekends, last
// seen 2013-02-02. 262 are Fri 17:00 with a mean of 5 ticks, a single print on the weekly-close
// boundary, last seen 2019-10-11. OANDA returns both itself with `complete: true` and real OHLC
// at the alignment the store uses.
//
// They are dropped in the CLIENT and only in the client (user decision, 2026-09-21): no
// indicator value, level or AREV row can sit on a bar that is not a candle open, so the chart
// draws a candle nothing else in the system can annotate.
//
// Run over the real stored series (dev, 2026-09-21), which is how the two conjuncts below were
// shown to both earn their place:
//
//   oanda:EURUSD:1D     7,149 bars   819 dropped (11.5%)   73 ms
//                       556x Sat 17:00, 258x Fri 17:00, and 5x a 19:00 open in the first week
//                       of January 2000 -- inside the FX week, so ONLY the grid check rejects
//                       those, and nothing had noticed them before.
//   coinbase:BTCUSD:1D  4,081 bars     0 dropped           31 ms
//   oanda:EURUSD:1h       844 bars     0 dropped            3 ms
//
// The coinbase zero is the point: filtering with the bare `isMarketOpen` below would have
// deleted every weekend bar in that series. Cost is ~10 us/bar, so a 500-bar chart window is
// ~5 ms and only the AREV lab's 40,000-bar read is anywhere near noticeable.
//
// THE TRAP this module exists to avoid: `replay/timeframes.ts` also exports a bare
// `isMarketOpen(ms, tz)`, and it is the WRONG predicate here -- it hardcodes the 24/5 FX week
// and America/New_York and takes no schedule. Filtering with it would delete every coinbase
// weekend bar (a continuous schedule: Saturday and Sunday are legal candle opens) and read
// schwab on the FX week instead of its own 09:00 anchor. Everything below goes through the
// instrument's resolved `MarketHours`, via the `schedule*` family, which is parity-tested
// against wmarkettypes for all three schedules (`replay/timeframes.test.ts`).

/** Is `wireMs` -- a bar label on the WIRE clock -- a legal candle open of `resolution` under
 * this geometry? Two conditions, and both are load-bearing:
 *
 * - on the grid: the label is its own interval start. This is the only one that catches a
 *   misaligned label on a continuous market, where `scheduleIsMarketOpen` is unconditionally
 *   true.
 * - boundary-open: the grid is open there. This is the only one that catches an FX bar
 *   labelled Saturday 03:00, which sits perfectly on the hourly grid.
 *
 * The wire shift is undone first. Daily-and-coarser bars are session-dated on the wire (+7h
 * forex, 0 crypto, -9h equities), so testing the label as it arrives would be 7 or 9 hours off
 * its true open and would reject everything. */
export function isLegalCandleOpen(
  resolution: string,
  wireMs: number,
  tz: string,
  day: DayGeometry
): boolean {
  const at = wireMs - scheduleWireShift(resolution, day)
  return scheduleIsMarketOpen(at, tz, day) && scheduleIntervalStart(resolution, at, tz, day) === at
}

/** `bars` without the ones whose label is not a legal candle open for `hours`.
 *
 * FAILS OPEN. An instrument with no schedule -- `/instrument` unreachable, an unknown symbol,
 * a schedule with no sessions -- is not filtered at all. Dropping bars on a guess about the
 * week is far worse than drawing a few the indicators cannot annotate, and it is the same
 * choice `tiles/derive.ts` makes when a manifest carries no geometry. */
export function dropMarketClosedBars(
  bars: KLineData[],
  resolution: string,
  hours: MarketHours | null | undefined
): KLineData[] {
  const day = dayGeometryOf(hours)
  if (day === null || !hours) return bars
  const tz = hours.timezone
  const shift = scheduleWireShift(resolution, day)
  // Inlined rather than calling `isLegalCandleOpen` per bar so the wire shift -- which parses
  // the interval code -- is computed once for the window rather than once per row.
  return bars.filter((bar) => {
    const at = bar.timestamp - shift
    return scheduleIsMarketOpen(at, tz, day) && scheduleIntervalStart(resolution, at, tz, day) === at
  })
}
