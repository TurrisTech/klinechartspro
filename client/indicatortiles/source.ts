// A stored indicator's fetch, answered from tiles where they cover the window.
//
// Wraps the ordinary server fetch. The first read of a series always goes to the server; if
// the answer names `tiles`, later reads of that series take whatever part of their window lies
// below the manifest's `coveredTo` from the bucket and only the rest from the server. That
// order matters for a chart: the first window drawn is the newest one, which is the open
// partition anyway, and scrolling back is what tiles make free.
//
// The tiles cannot answer the covered part in full (no manifest, a tile that will not load):
// the server reads those tiles itself, so it is never a gap, only a slower read. Under a bar
// replay the tiles stop at the bar forming at its clock and the server, clamped to the cursor,
// answers from there (`tiles/join.ts`); until 2026-10-11 a replay gave the tiles up outright.

import type { Page, Range } from '../plugins/types'
import { type ReadHorizon, readTiled, type Tiled } from '../tiles/join'
import { manifestFor, readSeries, type TileHint } from './index'
import { POINT_BUILDERS } from './points'

type Fetch<P> = (range: Range, limit: number) => Promise<Page<P>>

const hints = new Map<string, TileHint>()

/** For tests. */
export function resetTileHints(): void {
  hints.clear()
}

/** `server`, answered from the series' tiles wherever they hold the window; `horizon` is where
 * a bar replay stops them (`readHorizon`). */
export function tieredFetch<P extends { date: number }>(
  key: string,
  server: Fetch<P>,
  horizon: () => Promise<ReadHorizon> | ReadHorizon | null = () => null
): Fetch<P> {
  return (range, limit) =>
    readTiled<P>({
      range,
      limit,
      keep: 'first',
      date: (point) => point.date,
      tiles: (window, first) => fromTiles<P>(key, window, first),
      api: async (window, n) => {
        const page = await server(window, n ?? limit)
        if (page.tiles !== undefined) hints.set(key, page.tiles)
        return page
      },
      horizon: horizon()
    })
}

/** The points the tiles hold from `range.from`, or null until the server has named the series'
 * tiles -- or when they hold nothing there, or will not load. */
async function fromTiles<P>(key: string, range: Range, limit: number | null): Promise<Tiled<P> | null> {
  const hint = hints.get(key)
  const build = hint === undefined ? undefined : POINT_BUILDERS[hint.point]
  if (hint === undefined || build === undefined) return null
  const manifest = await manifestFor(hint.path)
  if (manifest === null || manifest.coveredTo === null) return null
  const covered = manifest.coveredTo + manifest.wireShiftMs
  if (range.from >= covered) return null
  const shift = manifest.wireShiftMs
  const rows = await readSeries(hint.path, manifest, range.from - shift, Math.min(range.to, covered) - shift, limit)
  return rows === null ? null : { items: build(rows, shift, hint) as unknown as P[], coveredTo: covered }
}
