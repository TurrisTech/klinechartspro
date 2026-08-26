// Serving history from tiles.
//
// Tiles hold every *closed* calendar period, so they answer historical reads in full. The
// one thing they never hold is the period currently forming — that comes from /getbars,
// which is where the forming bar and the websocket already come from, and the caller joins
// the two at `coveredTo`.
//
// The join means a window crossing that boundary is answered from both, not abandoned to
// the API wholesale. Any discontinuity left in the result is therefore a real market gap —
// a weekend, a holiday — and never an artefact of where the tiles happen to stop.

import type { KLineData } from 'klinecharts'
import { barsForTile } from './cache'
import { manifestFor, tilesUpTo } from './manifest'

export { tilesBaseUrl } from './manifest'

export interface TiledBars {
  bars: KLineData[]
  /** Exclusive instant the tiles run to; `[coveredTo, to]` is the caller's to fetch. */
  coveredTo: number
}

/**
 * Bars from tiles for as much of `[from, to]` as tiled history reaches.
 *
 * Null means tiles can contribute nothing to this window and the caller should fetch the
 * whole of it — never "no data". A non-null answer may still stop short of `to`, at
 * `coveredTo`; the caller owns the remainder.
 */
export async function barsFromTiles(
  vendorSymbol: string,
  resolution: string,
  from: number,
  to: number
): Promise<TiledBars | null> {
  const [vendor, symbol] = vendorSymbol.includes(':')
    ? vendorSymbol.split(':', 2)
    : ['oanda', vendorSymbol]

  const manifest = await manifestFor(vendor, symbol, resolution)
  if (manifest === null) return null

  const span = tilesUpTo(manifest, from, to)
  if (span === null) return null

  const loaded = await Promise.all(span.entries.map((entry) => barsForTile(manifest, entry)))
  // A tile that will not load is not a gap to paper over: fall back for the whole window
  // rather than return a series with a hole in the middle of it.
  if (loaded.some((bars) => bars === null)) return null

  // Tiles are written in order and never overlap, so concatenating is already sorted; only
  // the window edges need trimming. `from` is inclusive and `to` exclusive, matching
  // /getbars, and the right edge stops at the split boundary rather than `to`.
  const tileEnd = Math.min(to, span.coveredTo)
  const bars: KLineData[] = []
  for (const tile of loaded) {
    for (const bar of tile as KLineData[]) {
      if (bar.timestamp >= from && bar.timestamp < tileEnd) bars.push(bar)
    }
  }
  return { bars, coveredTo: span.coveredTo }
}
