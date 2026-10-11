import type { KLineData } from 'klinecharts'
import { getReadClock } from '../config'
import { dayGeometryOf } from '../daygeometry'
import { fetchBars } from '../history'
import { instrumentConfig } from '../instrumentconfig'
import { type CandleGrid, gridFor, nominalMs, sessionDated } from '../replay/timeframes'
import { barsFromTiles } from '../tiles'
import { knownThrough } from './horizon'
import type { Range } from './types'

// The bars a plugin reads for ITSELF -- TradeTalk's daily candles, the AREV lab's prior, the MTF
// overlays' bar grid, the volume profile's finer bars -- as opposed to the bars a pane draws,
// which come through its datafeed. Four plugins read them, and each used to do it for itself:
// the same chunking, the same `fetchBars` call, and the same gap under a bar replay (below).
//
// The same rule decides which of a plugin's TILED points a replay may see (`closedFilter`): the
// book tiles hold, per bar, the snapshot knowable by that bar's close.

/** `/getbars` is bounded by range and 413s past the server's per-request cap, so a page is at
 * most this many NOMINAL bars -- which overcounts (the market is shut about a third of the
 * week), keeping the real reply comfortably under the 5000 cap. */
export const PAGE_BARS = 4000

/** Whether a bar dated `date` (its wire date) on `resolution` had closed by `clock`. On the
 * instrument's own grid that is the horizon the host forgets a source from (`knownThrough`).
 * With no schedule an intraday bar is judged by its nominal length, and a session-dated one --
 * whose day cannot be placed without one -- is not admitted at all. */
export function closedBy(resolution: string, date: number, clock: number, grid: CandleGrid | null): boolean {
  if (grid) return date < knownThrough(resolution, clock, grid)
  return !sessionDated(resolution) && date + nominalMs(resolution) <= clock
}

/** Under a bar replay's read clock, the test a point dated on `resolution` must pass to be seen:
 * its bar has closed by the clock. Null live, when everything served is closed already. */
export async function closedFilter(vendorSymbol: string, resolution: string): Promise<((date: number) => boolean) | null> {
  const clock = getReadClock()
  if (clock === null) return null
  const hours = (await instrumentConfig(vendorSymbol))?.marketHours
  const grid = gridFor({ timezone: hours?.timezone, dayGeometry: dayGeometryOf(hours) ?? undefined })
  return (date) => closedBy(resolution, date, clock, grid)
}

/**
 * The CLOSED bars of `[from, to)`, tiles first and `/getbars` for the rest (`fetchBars`).
 *
 * Under a bar replay's read clock, only the bars the replay has seen close. `/getbars` is
 * clamped by the server (`asof`, added to every API read), but the tiles are read straight from
 * the bucket and nothing clamps them -- so a bar forming at the cursor came back whole, with the
 * high, low and close it would only reach later, and a window reaching past the cursor read
 * bars that had not happened. Live, every bar `fetchBars` returns is closed already.
 */
export async function fetchClosedBars(vendorSymbol: string, resolution: string, from: number, to: number): Promise<KLineData[]> {
  const [bars, closed] = await Promise.all([fetchBars(vendorSymbol, resolution, from, to, null), closedFilter(vendorSymbol, resolution)])
  return closed === null ? bars : bars.filter((bar) => closed(bar.timestamp))
}

/** One page of a plugin's bar source over `range`, and where the next one starts: at most
 * `apiPage` nominal bars, or `tilePage` where the tiles hold the window -- a page read from the
 * bucket costs no request, so a source that reaches far back may take bigger ones. */
export async function closedBarPage(
  vendorSymbol: string,
  resolution: string,
  range: Range,
  pages: { apiPage?: number; tilePage?: number } = {}
): Promise<{ bars: KLineData[]; nextFrom: number | null }> {
  const ms = nominalMs(resolution)
  const apiPage = pages.apiPage ?? PAGE_BARS
  const tilePage = pages.tilePage ?? apiPage
  let to = Math.min(range.to, range.from + apiPage * ms)
  if (tilePage > apiPage) {
    const tiled = await barsFromTiles(vendorSymbol, resolution, range.from, range.to)
    if (tiled !== null && tiled.coveredTo > range.from) to = Math.min(range.to, tiled.coveredTo, range.from + tilePage * ms)
  }
  return { bars: await fetchClosedBars(vendorSymbol, resolution, range.from, to), nextFrom: to < range.to ? to : null }
}
