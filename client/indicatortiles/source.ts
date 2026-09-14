// A stored indicator's fetch, answered from tiles where they cover the window.
//
// Wraps the ordinary server fetch. The first read of a series always goes to the server; if
// the answer names `tiles`, later reads of that series take whatever part of their window lies
// below the manifest's `coveredTo` from the bucket and only the rest from the server. That
// order matters for a chart: the first window drawn is the newest one, which is the open
// partition anyway, and scrolling back is what tiles make free.
//
// Two cases always go to the server whole:
//   * a replay is running (`replaying()`, the read clock): the server clamps every read to the replay
//     cursor, and a tile knows nothing of it;
//   * the tiles cannot answer the covered part in full (no manifest, a tile that will not
//     load): the server reads those tiles itself, so it is never a gap, only a slower read.

import type { Page, Range } from '../plugins/types'
import { manifestFor, readSeries, type TileHint } from './index'
import { POINT_BUILDERS } from './points'

type Fetch<P> = (range: Range, limit: number) => Promise<Page<P>>

const hints = new Map<string, TileHint>()

/** For tests. */
export function resetTileHints(): void {
  hints.clear()
}

export function tieredFetch<P extends { date: number }>(
  key: string,
  server: Fetch<P>,
  replaying: () => boolean = () => false
): Fetch<P> {
  return async (range, limit) => {
    const hint = hints.get(key)
    const build = hint === undefined ? undefined : POINT_BUILDERS[hint.point]
    if (hint !== undefined && build !== undefined && !replaying()) {
      const manifest = await manifestFor(hint.path)
      if (manifest !== null && manifest.coveredTo !== null) {
        const covered = manifest.coveredTo + manifest.wireShiftMs
        if (range.from < covered) {
          const upTo = Math.min(range.to, covered)
          const rows = await readSeries(
            hint.path,
            manifest,
            range.from - manifest.wireShiftMs,
            upTo - manifest.wireShiftMs,
            limit
          )
          if (rows !== null) {
            const points = build(rows, manifest.wireShiftMs, hint) as unknown as P[]
            if (points.length >= limit) {
              const capped = points.slice(0, limit)
              return { points: capped, nextFrom: capped[capped.length - 1].date + 1 }
            }
            if (range.to <= covered) return { points, nextFrom: null }
            const rest = await server({ from: covered, to: range.to }, limit - points.length)
            remember(key, rest)
            return { ...rest, points: points.concat(rest.points) }
          }
        }
      }
    }
    const page = await server(range, limit)
    remember(key, page)
    return page
  }
}

function remember<P>(key: string, page: Page<P>): void {
  if (page.tiles !== undefined) hints.set(key, page.tiles)
}
