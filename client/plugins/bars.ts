import type { KLineData } from 'klinecharts'
import { getReadClock } from '../config'
import { dayGeometryOf } from '../daygeometry'
import { fetchBars } from '../history'
import { instrumentConfig } from '../instrumentconfig'
import { gridFor, nominalMs } from '../replay/timeframes'
import { knownThrough } from './horizon'
import type { Range } from './types'

// The bars a plugin reads for ITSELF -- TradeTalk's daily candles, the AREV lab's prior, the MTF
// overlays' bar grid -- as opposed to the bars a pane draws, which come through its datafeed.
// Three plugins read them, and each used to do it for itself: the same chunking, the same
// `fetchBars` call, and the same gap under a bar replay (below).

/** `/getbars` is bounded by range and 413s past the server's per-request cap, so a page is at
 * most this many NOMINAL bars -- which overcounts (the market is shut about a third of the
 * week), keeping the real reply comfortably under the 5000 cap. */
const PAGE_BARS = 4000

/**
 * The CLOSED bars of `[from, to)`, tiles first and `/getbars` for the rest (`fetchBars`).
 *
 * Under a bar replay's read clock, only the bars the replay has seen close. `/getbars` is
 * clamped by the server (`asof`, added to every API read), but the tiles are read straight from
 * the bucket and nothing clamps them -- so a bar forming at the cursor came back whole, with the
 * high, low and close it would only reach later, and a window reaching past the cursor read
 * bars that had not happened. Clamped here, at the horizon the host forgets a source from on a
 * step (`knownThrough`), so the two agree: live, every bar `fetchBars` returns is closed already.
 */
export async function fetchClosedBars(vendorSymbol: string, resolution: string, from: number, to: number): Promise<KLineData[]> {
  const bars = await fetchBars(vendorSymbol, resolution, from, to, null)
  const clock = getReadClock()
  if (clock === null) return bars
  const hours = (await instrumentConfig(vendorSymbol))?.marketHours
  const horizon = knownThrough(resolution, clock, gridFor({ timezone: hours?.timezone, dayGeometry: dayGeometryOf(hours) ?? undefined }))
  return bars.filter((bar) => bar.timestamp < horizon)
}

/** One page of a plugin's bar source over `range`, and where the next one starts. */
export async function closedBarPage(vendorSymbol: string, resolution: string, range: Range): Promise<{ bars: KLineData[]; nextFrom: number | null }> {
  const to = Math.min(range.to, range.from + PAGE_BARS * nominalMs(resolution))
  return { bars: await fetchClosedBars(vendorSymbol, resolution, range.from, to), nextFrom: to < range.to ? to : null }
}
