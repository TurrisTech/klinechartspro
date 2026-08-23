import type { KLineData } from 'klinecharts'
import { apiGet } from '../config'
import { isNoData, type GetBarsResponse } from '../ohlcv'
import { fetchArevValues, type ArevPoint } from '../arev/api'

// The multi-timeframe AREV21 overlay's data layer. It reads two things per source
// timeframe, and needs both:
//
//   * the arev21 votes for that timeframe, off `GET /arev/values` — the same wire the
//     AREV sub-panes use, asked at an interval that is NOT the chart's;
//   * that timeframe's own BAR GRID, off `GET /getbars` — because a vote has to be drawn
//     at the bar after the one it was cast on (see shift.ts), and "the bar after" is a
//     question only the server's candle boundaries can answer.
//
// The second fetch is the whole reason this module exists rather than reusing
// arev/api.ts as-is. A source bar's successor cannot be computed here: a 4h bar opening
// Friday 13:00 New York is followed by one opening SUNDAY 17:00, not by 17:00 the same
// day, because the market is shut in between; a daily bar's successor skips the weekend
// the same way, and a monthly one lands on the evening before the next month's first
// market day. `t + duration` is wrong at every one of those boundaries, and this client
// deliberately owns no candle-boundary rules (see the workspace CLAUDE.md: "The client
// never buckets"). Asking for the grid is how it stays out of that business.
//
// Nor can the votes stand in for the grid. They are nearly dense — arev21 records a row
// per bar, 105,033 of them against ~105,000 EURUSD 1h bars since 2010 — so "the next
// vote" is ALMOST always "the next bar". Almost: a bar whose five-year window held no
// samples abstains and has no row at all, and using the next vote there would shift the
// marker past the bar it belongs on, silently and only sometimes. A grid that is right
// by construction beats one that is right 99.9% of the time and gives no sign when it
// is not.

// The generation this overlay draws. arev21 is the one sampled at fresh price extremes
// rather than at WMA crosses, which is what makes it worth reading across timeframes:
// its samples are a property of price alone, so a 4h extreme and a 1D extreme mean the
// same thing at two scales.
export const MTF_GENERATION = 'arev21' as const

// The timeframes offered in the picker: exactly the intervals arev21 has actually been
// generated on for EURUSD (verified on pg-algo.dev, 2026-08-23 — 3m, 5m, 15m, 30m, 1h,
// 4h, 8h and 1D, ~3.5M prediction rows in total). Deliberately not every interval the
// server can serve bars for: a picker entry for 1W or 1M would be a checkbox that can
// only ever draw an empty pane, because no run has ever written those rows.
//
// Ordered shortest-first, and that order is load-bearing twice over — it is the order
// the picker lists them in, and it is what the controller assigns drawing lanes from,
// so a 4h marker always sits closer to the candle than a 1D one.
export const MTF_INTERVALS = ['3m', '5m', '15m', '30m', '1h', '4h', '8h', '1D'] as const
export type MtfInterval = (typeof MTF_INTERVALS)[number]

export function isMtfInterval(code: string): code is MtfInterval {
  return (MTF_INTERVALS as readonly string[]).includes(code)
}

export type { ArevPoint }

/** arev21 votes for one source timeframe over `[from, to)`, in that timeframe's own wire
 * dates. A `no_data` answer (no run has written this symbol/interval) comes back as an
 * empty list: nothing to draw is a legitimate answer here, not a failure. */
export async function fetchMtfPoints(
  vendorSymbol: string,
  interval: MtfInterval,
  from: number,
  to: number,
  limit: number | null
): Promise<ArevPoint[]> {
  const result = await fetchArevValues(vendorSymbol, interval, MTF_GENERATION, from, to, limit)
  return result.s === 'no_data' ? [] : result.points
}

/** The source timeframe's bar opens over `[from, to)`, ascending — the grid shift.ts
 * walks to find each vote's successor bar. Only the timestamps are used; `/getbars` has
 * no date-only column selector (`columns` is `core` | `all`), so the OHLC comes along
 * and is dropped here rather than being carried through every store and template. */
export async function fetchMtfBarGrid(
  vendorSymbol: string,
  interval: MtfInterval,
  from: number,
  to: number
): Promise<number[]> {
  const body = await apiGet<GetBarsResponse>('/getbars', {
    symbol: vendorSymbol,
    resolution: interval,
    from,
    to
  })
  // `no_data` is the documented empty answer; `[]` is never sent.
  if (isNoData(body) || !Array.isArray(body)) return []
  return body.map((bar) => bar.date)
}

export type { KLineData }
