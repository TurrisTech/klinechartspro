import type { KLineData } from 'klinecharts'
import { fetchBars } from '../history'
import { nominalMs } from '../replay/timeframes'
import { barsFromTiles } from '../tiles'
import { readHorizon } from '../tiles/join'
import type { Range } from './types'

// The bars a plugin reads for ITSELF -- TradeTalk's daily candles, the AREV lab's prior, the MTF
// overlays' bar grid, the volume profile's finer bars -- as opposed to the bars a pane draws,
// which come through its datafeed. Both go through `fetchBars` (`history.ts`), which joins tiles
// and `/getbars` and under a bar replay stops the tiles at the clock (`tiles/join.ts`). What is
// left here is the paging, and that a plugin reads CLOSED bars only.

/** `/getbars` is bounded by range and 413s past the server's per-request cap, so a page is at
 * most this many NOMINAL bars -- which overcounts (the market is shut about a third of the
 * week), keeping the real reply comfortably under the 5000 cap. */
export const PAGE_BARS = 4000

/**
 * The CLOSED bars of `[from, to)`. Live that is every bar `/getbars` serves -- the forming one
 * arrives over the stream -- but under a bar replay the API rebuilds the bar forming at the clock
 * from the rows that had closed by then, which a pane wants and a plugin does not: TradeTalk would
 * read a day that has not ended, and the MTF overlay places a vote on the bar AFTER the one it was
 * cast on. So the window ends at the replay's horizon, and that bar is never asked for.
 */
export async function fetchClosedBars(vendorSymbol: string, resolution: string, from: number, to: number): Promise<KLineData[]> {
  const horizon = await readHorizon(vendorSymbol, resolution)
  const end = horizon === null ? to : Math.min(to, horizon)
  return end > from ? fetchBars(vendorSymbol, resolution, from, end, null) : []
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
