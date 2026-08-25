// Serving a history window from tiles, when they cover it.
//
// This sits in front of /getbars, not instead of it. Tiles stop at the last *closed*
// calendar period, so the live edge is never tiled and every window touching it falls
// through to the API — which is also where the forming bar and the websocket updates come
// from, so nothing about the live path changes.

import type { KLineData } from 'klinecharts'
import { barsForTile } from './cache'
import { manifestFor, tilesCovering } from './manifest'

export { tilesBaseUrl } from './manifest'

/**
 * Bars in `[from, to]` from tiles, or null when tiles cannot answer the window.
 *
 * Null means "ask the server", never "no data" — the caller must fall through. Any failure
 * (no manifest, partial coverage, a fetch or decode error) returns null for that reason.
 */
export async function barsFromTiles(
  vendorSymbol: string,
  resolution: string,
  from: number,
  to: number
): Promise<KLineData[] | null> {
  const [vendor, symbol] = vendorSymbol.includes(':')
    ? vendorSymbol.split(':', 2)
    : ['oanda', vendorSymbol]

  const manifest = await manifestFor(vendor, symbol, resolution)
  if (manifest === null) return null

  const entries = tilesCovering(manifest, from, to)
  if (entries === null) return null

  const loaded = await Promise.all(entries.map((entry) => barsForTile(manifest, entry)))
  if (loaded.some((bars) => bars === null)) return null

  // Tiles are written in order and never overlap, so concatenating them is already sorted;
  // only the window edges need trimming.
  const bars: KLineData[] = []
  for (const tile of loaded) {
    for (const bar of tile as KLineData[]) {
      if (bar.timestamp >= from && bar.timestamp <= to) bars.push(bar)
    }
  }
  return bars
}
