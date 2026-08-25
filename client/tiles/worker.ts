// Tile decoding, off the main thread.
//
// Measured on this workstation: a 30k-bar 1m tile costs ~37 ms to decode, a 65k-bar 5s tile
// ~70 ms. That is a dropped frame or two on the main thread, during a pan, which is exactly
// when the chart must stay smooth.
//
// The cost is inherent to the format rather than incidental: DELTA_BINARY_PACKED is ~3.7x
// slower to decode than PLAIN but 4x smaller (118 KB vs 480 KB for the same month). Keeping
// the small file and paying for it on a worker is strictly better than shipping four times
// the bytes over the network, into the cache, and onto disk -- at 25 Mbps the delta tile is
// still ahead end to end (~75 ms vs ~165 ms) even before the cache makes the transfer free.

import { parquetRead } from 'hyparquet'

export interface DecodeRequest {
  id: number
  bytes: ArrayBuffer
  precision: number
}

export interface DecodeResponse {
  id: number
  /** Columns, not row objects — six Transferables beat 30k structured-cloned objects. */
  columns?: { ts: Float64Array; o: Int32Array; h: Int32Array; l: Int32Array; c: Int32Array; v: Int32Array }
  error?: string
}

export async function decodeColumns(
  bytes: ArrayBuffer,
  _precision: number
): Promise<DecodeResponse['columns']> {
  const acc: Record<string, number[]> = { ts: [], o: [], h: [], l: [], c: [], v: [] }
  await parquetRead({
    file: bytes,
    columns: ['ts', 'o', 'h', 'l', 'c', 'v'],
    // onChunk hands back column data directly; onComplete would transpose it into rows
    // first, which is work we would only undo.
    onChunk: (chunk: { columnName: string; columnData: ArrayLike<unknown> }) => {
      const target = acc[chunk.columnName]
      if (target === undefined) return
      for (let i = 0; i < chunk.columnData.length; i++) target.push(Number(chunk.columnData[i]))
    }
  })
  return {
    // ts is epoch ms, past 2^32 and beyond Int32Array; float64 holds it exactly well past
    // any date this project will see.
    ts: Float64Array.from(acc.ts),
    o: Int32Array.from(acc.o),
    h: Int32Array.from(acc.h),
    l: Int32Array.from(acc.l),
    c: Int32Array.from(acc.c),
    v: Int32Array.from(acc.v)
  }
}

// Guarded so this module can also be imported directly by the main thread as a fallback
// when Worker construction fails (a blocked blob: URL, an old bundler target).
// `self` is typed as Window in a module compiled against the DOM lib; inside a worker it
// is a DedicatedWorkerGlobalScope, whose postMessage takes a transfer list. Declared
// structurally rather than by pulling in the WebWorker lib, which would collide with DOM.
interface WorkerScope {
  postMessage(message: DecodeResponse, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null
}
const scope = self as unknown as WorkerScope

if (typeof scope.postMessage === 'function' && typeof document === 'undefined') {
  scope.onmessage = async (event: MessageEvent<DecodeRequest>) => {
    const { id, bytes, precision } = event.data
    try {
      const columns = (await decodeColumns(bytes, precision)) as NonNullable<
        DecodeResponse['columns']
      >
      scope.postMessage({ id, columns } satisfies DecodeResponse, [
        columns.ts.buffer,
        columns.o.buffer,
        columns.h.buffer,
        columns.l.buffer,
        columns.c.buffer,
        columns.v.buffer
      ])
    } catch (err) {
      scope.postMessage({ id, error: String(err) } satisfies DecodeResponse)
    }
  }
}
