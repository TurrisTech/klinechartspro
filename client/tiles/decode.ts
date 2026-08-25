// Parquet -> KLineData, on a worker when one can be had.
//
// Tile columns are integers (see wmarketdata's bin/build_chart_tiles.py): `ts` is the wire
// timestamp in epoch ms and `o/h/l/c` are prices scaled by 10**precision. Scaling is what
// lets the writer use DELTA_BINARY_PACKED, which is where the 6.6x size reduction over the
// stored float64 Parquet comes from -- so unscaling here is not bookkeeping, it is the other
// half of the format.

import type { KLineData } from 'klinecharts'
import { decodeColumns, type DecodeRequest, type DecodeResponse } from './worker'

type Columns = NonNullable<DecodeResponse['columns']>

let worker: Worker | null | undefined
let nextId = 1
const pending = new Map<number, (value: Columns | Error) => void>()

function ensureWorker(): Worker | null {
  if (worker !== undefined) return worker
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<DecodeResponse>) => {
      const settle = pending.get(event.data.id)
      if (settle === undefined) return
      pending.delete(event.data.id)
      settle(event.data.columns ?? new Error(event.data.error ?? 'tile decode failed'))
    }
    worker.onerror = () => {
      // The worker is unusable from here on; fail everything waiting and fall back inline.
      for (const [, settle] of pending) settle(new Error('tile decode worker crashed'))
      pending.clear()
      worker?.terminate()
      worker = null
    }
  } catch {
    worker = null
  }
  return worker
}

function columnsFor(bytes: ArrayBuffer, precision: number): Promise<Columns> {
  const active = ensureWorker()
  if (active === null) return decodeColumns(bytes, precision) as Promise<Columns>
  return new Promise<Columns>((resolve, reject) => {
    const id = nextId++
    pending.set(id, (value) => (value instanceof Error ? reject(value) : resolve(value)))
    // The buffer is transferred, not copied. The caller has already handed its copy to the
    // Cache API, so losing this one is fine.
    active.postMessage({ id, bytes, precision } satisfies DecodeRequest, [bytes])
  })
}

/**
 * Decode one tile's bytes into bars.
 *
 * `precision` comes from the manifest rather than being inferred: a tile holds only the
 * scaled integers, and guessing the scale from their magnitude would put EURUSD's 108058 and
 * USDJPY's 15712 on the same footing and misprice both.
 */
export async function decodeTile(bytes: ArrayBuffer, precision: number): Promise<KLineData[]> {
  const scale = 10 ** precision
  const { ts, o, h, l, c, v } = await columnsFor(bytes, precision)
  const bars: KLineData[] = new Array(ts.length)
  for (let i = 0; i < ts.length; i++) {
    bars[i] = {
      timestamp: ts[i],
      open: o[i] / scale,
      high: h[i] / scale,
      low: l[i] / scale,
      close: c[i] / scale,
      volume: v[i]
    }
  }
  return bars
}
