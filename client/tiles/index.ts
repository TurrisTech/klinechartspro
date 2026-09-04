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
//
// Only the intervals the store physically holds are tiled (5s/1m/1h/1D/1M). Everything else
// is folded here out of its source's tiles rather than fetched as a tree of its own — see
// `derive.ts`, which carries the two rules that fold has to keep.

import type { KLineData } from 'klinecharts'
import { barsForTile } from './cache'
import { fold, foldedCoveredTo, manifestDay, manifestTz, sourceInterval, sourceWindow } from './derive'
import { manifestFor, type TileManifest, tilesUpTo } from './manifest'

export { tilesBaseUrl } from './manifest'

export interface TiledBars {
  bars: KLineData[]
  /** Exclusive instant the tiles run to; `[coveredTo, to]` is the caller's to fetch. */
  coveredTo: number
}

/** Every bar the manifest's tiles hold in `[from, to)`, or null if any of them will not load.
 * Null is never "no bars": a tile that will not load must fall back for the whole window
 * rather than leave a hole in the middle of one. */
async function barsInWindow(manifest: TileManifest, from: number, to: number): Promise<KLineData[] | null> {
  const span = tilesUpTo(manifest, from, to)
  if (span === null) return null
  const loaded = await Promise.all(span.entries.map((entry) => barsForTile(manifest, entry)))
  if (loaded.some((bars) => bars === null)) return null

  // Tiles are written in order and never overlap, so concatenating is already sorted; only
  // the window edges need trimming. `from` is inclusive and `to` exclusive, matching
  // /getbars.
  const bars: KLineData[] = []
  for (const tile of loaded) {
    for (const bar of tile as KLineData[]) {
      if (bar.timestamp >= from && bar.timestamp < to) bars.push(bar)
    }
  }
  return bars
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
  if (manifest !== null) {
    const span = tilesUpTo(manifest, from, to)
    if (span === null) return null
    // The right edge stops at the split boundary rather than at `to`.
    const bars = await barsInWindow(manifest, from, Math.min(to, span.coveredTo))
    return bars === null ? null : { bars, coveredTo: span.coveredTo }
  }
  return foldedFromTiles(vendor, symbol, resolution, from, to)
}

/**
 * The same answer for a timeframe that is not tiled, folded from the one it derives from.
 *
 * The coverage arithmetic is the whole of it. `coveredTo` is the source's, pulled back to the
 * last candle the source covers *whole* — everything after that would be a candle built from
 * part of its rows, which is a wrong bar rather than a missing one — and the source rows are
 * read over a window widened to whole candles, because a candle opening inside the requested
 * window closes outside it.
 */
async function foldedFromTiles(
  vendor: string,
  symbol: string,
  resolution: string,
  from: number,
  to: number
): Promise<TiledBars | null> {
  const code = sourceInterval(resolution)
  if (code === null) return null
  const manifest = await manifestFor(vendor, symbol, code)
  if (manifest === null) return null
  const day = manifestDay(manifest)
  if (day === null) return null

  const tz = manifestTz(manifest)
  const coveredTo = foldedCoveredTo(resolution, code, manifest.coveredTo, tz, day)
  if (from >= coveredTo) return null

  const window = sourceWindow(resolution, code, from, Math.min(to, coveredTo), tz, day)
  // Clamped to the source's own coverage: the widened window legitimately overshoots it (the
  // last candle of a week closes at 17:00 Friday while the fold's coverage runs to Sunday's
  // open, and nothing exists in between). Reading past it would refuse the read outright and
  // lose that candle.
  const sourceTo = Math.min(window.to, manifest.coveredTo)
  if (sourceTo <= window.from) return { bars: [], coveredTo }

  const rows = await barsInWindow(manifest, window.from, sourceTo)
  if (rows === null) return null

  const bars = fold(resolution, code, rows, tz, day).filter(
    (bar) => bar.timestamp >= from && bar.timestamp < Math.min(to, coveredTo)
  )
  return { bars, coveredTo }
}
