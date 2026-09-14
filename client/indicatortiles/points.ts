// Tile rows -> the points a server reader would have answered with.
//
// A tile stores what the database table stores, never what the wire derives from it: for AREV
// that is the vote sum, the neighbour count and the sample-bar flag. The wire's `p`,
// `confidence` and `signal` are computed here exactly as `wdashboard_server/services/arev.py`
// `ArevReader._point` computes them -- same IEEE arithmetic, same thresholds, which the server
// sends beside `tiles.path` rather than this client keeping its own copy.

import type { SeriesRows, TileHint } from './index'

export interface ArevPoint {
  date: number
  prediction: number
  n: number
  p: number
  confidence: number
  atCross: boolean
  signal: boolean
}

export function arevPoints(rows: SeriesRows, wireShiftMs: number, hint: TileHint): ArevPoint[] {
  const predictions = rows.columns.prediction ?? []
  const neighbours = rows.columns.neighbours ?? []
  const crosses = rows.columns.at_cross ?? []
  const signalConfidence = hint.signalConfidence ?? Number.POSITIVE_INFINITY
  const minNeighbours = hint.minNeighbours ?? Number.POSITIVE_INFINITY
  const out: ArevPoint[] = new Array(rows.ts.length)
  for (let i = 0; i < rows.ts.length; i++) {
    const total = Number(predictions[i])
    const n = Math.trunc(Number(neighbours[i]))
    const p = (total / n + 1) / 2
    const confidence = Math.abs(p - 0.5)
    const atCross = Boolean(crosses[i])
    out[i] = {
      date: rows.ts[i] + wireShiftMs,
      prediction: total,
      n,
      p,
      confidence,
      atCross,
      signal: atCross && n >= minNeighbours && confidence >= signalConfidence
    }
  }
  return out
}

/** Point builders by the name a hint gives. A hint naming one this client does not have is
 * served entirely by the server, which is always correct and only slower. */
export const POINT_BUILDERS: Record<string, (rows: SeriesRows, wireShiftMs: number, hint: TileHint) => { date: number }[]> = {
  arev: arevPoints
}
