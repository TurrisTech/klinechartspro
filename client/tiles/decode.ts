// Parquet -> KLineData.
//
// Tile columns are integers (see wmarketdata's bin/build_chart_tiles.py): `ts` is the wire
// timestamp in epoch ms and `o/h/l/c` are prices scaled by 10**precision. Scaling is what lets
// the writer use DELTA_BINARY_PACKED, which is where the 6.6x size reduction over the stored
// float64 Parquet comes from -- so unscaling here is not bookkeeping, it is the other half of
// the format.
//
// Decoding happens on the main thread, deliberately, after a Web Worker version was shipped and
// removed. Three things went wrong with it, and the third is why it is not simply fixed:
//
//   1. `new Worker(new URL("./worker.ts", import.meta.url))` is emitted verbatim by the
//      production build -- Bun.build does not follow it from an HTML entrypoint -- so the URL
//      resolved to /worker.ts, hit nginx's SPA fallback and loaded index.html as a module.
//   2. A module *load* failure is asynchronous, so the try/catch around construction never saw
//      it; the error handler then rejected every queued decode instead of falling back, which
//      surfaced as "history fetch failed" on the first pan of every page load.
//   3. The request transferred its ArrayBuffer to the worker, so by the time the failure was
//      known the buffer was detached and no retry was possible.
//
// The worker also resolved differently in dev (Bun's dev server serves the TS directly) and in
// production, so the path that ran in front of users was never the path under test. Decoding
// inline costs ~17ms for a 1.2k-bar tile and ~33ms for a 7.1k-bar one, measured in Chrome, once
// per tile per page load -- the decoded bars are then cached in memory. That is a real cost and
// a worker would remove it, but it needs a build that actually emits one and a single
// resolution path across dev and production; until then this is the version that works.

import type { KLineData } from 'klinecharts'
import { parquetRead } from 'hyparquet'

/**
 * Decode one tile's bytes into bars.
 *
 * `precision` comes from the manifest rather than being inferred: a tile holds only the scaled
 * integers, and guessing the scale from their magnitude would put EURUSD's 108058 and USDJPY's
 * 15712 on the same footing and misprice both.
 */
export async function decodeTile(bytes: ArrayBuffer, precision: number): Promise<KLineData[]> {
  const scale = 10 ** precision
  const cols: Record<string, number[]> = { ts: [], o: [], h: [], l: [], c: [], v: [] }
  await parquetRead({
    file: bytes,
    columns: ['ts', 'o', 'h', 'l', 'c', 'v'],
    // onChunk hands back column data directly; onComplete would transpose it into rows first,
    // which is work we would only undo.
    onChunk: (chunk: { columnName: string; columnData: ArrayLike<unknown> }) => {
      const target = cols[chunk.columnName]
      if (target === undefined) return
      for (let i = 0; i < chunk.columnData.length; i++) target.push(Number(chunk.columnData[i]))
    }
  })
  const { ts, o, h, l, c, v } = cols
  const bars: KLineData[] = new Array(ts.length)
  for (let i = 0; i < ts.length; i++) {
    bars[i] = { timestamp: ts[i], open: o[i] / scale, high: h[i] / scale, low: l[i] / scale, close: c[i] / scale, volume: v[i] }
  }
  return bars
}
