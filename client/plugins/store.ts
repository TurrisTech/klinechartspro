import type { Phase, Range, SourceStore } from './types'

// The one window store. Values the client holds for one source (keyed by whatever the
// plugin declares as the source key), plus which time windows have been fetched, so
// panning never re-requests a window it already has. Lives for as long as some binding on
// the wall reads the source; the host drops it with the last one.
//
// `index` decides what a bar holds: the point itself (a scalar series, an AREV vote), or a
// fold of several points that share a bar (krev's top and bottom candidates).

export type IndexFn<P, V> = (point: P, existing: V | undefined) => V

export class WindowStore<P extends { date: number }, V = P> implements SourceStore<P> {
  readonly values = new Map<number, V>()
  /** Fetched windows, merged, ascending. */
  private ranges: Range[] = []
  phase: Phase = 'idle'
  progress: number | null = null
  error: string | null = null
  rev = 0
  /** Free-form notes the source may leave (the server's own key, say), for debugging. */
  meta: Record<string, unknown> = {}

  constructor(
    readonly key: string,
    private readonly index: IndexFn<P, V> = ((p: P) => p as unknown as V) as IndexFn<P, V>
  ) {}

  get size(): number {
    return this.values.size
  }

  set(point: P): void {
    this.values.set(point.date, this.index(point, this.values.get(point.date)))
    this.rev++
  }

  ingest(points: P[], window: Range): void {
    for (const p of points) this.values.set(p.date, this.index(p, this.values.get(p.date)))
    this.addRange(window)
    this.rev++
  }

  covers(window: Range): boolean {
    return this.ranges.some((r) => r.from <= window.from && r.to >= window.to)
  }

  missing(window: Range): Range[] {
    return missingRanges(this.ranges, window)
  }

  addRange(range: Range): void {
    this.ranges = mergeRange(this.ranges, range)
  }

  /** The newest timestamp held, or null. */
  latest(): number | null {
    let max: number | null = null
    for (const t of this.values.keys()) if (max === null || t > max) max = t
    return max
  }

  setPhase(phase: Phase, progress: number | null = null, error: string | null = null): void {
    if (this.phase === phase && this.progress === progress && this.error === error) return
    this.phase = phase
    this.progress = progress
    this.error = error
    this.rev++
  }
}

/** The parts of `window` not covered by `ranges` (0..n sub-windows, in order). */
export function missingRanges(ranges: readonly Range[], window: Range): Range[] {
  let gaps: Range[] = [{ ...window }]
  for (const r of ranges) {
    const next: Range[] = []
    for (const g of gaps) {
      if (r.to <= g.from || r.from >= g.to) {
        next.push(g)
        continue
      }
      if (r.from > g.from) next.push({ from: g.from, to: r.from })
      if (r.to < g.to) next.push({ from: r.to, to: g.to })
    }
    gaps = next
  }
  return gaps
}

/** `ranges` with `range` merged in: overlapping or touching windows become one. */
export function mergeRange(ranges: readonly Range[], range: Range): Range[] {
  const merged: Range[] = []
  let cur = { ...range }
  for (const r of ranges) {
    if (r.to < cur.from || r.from > cur.to) merged.push(r)
    else cur = { from: Math.min(r.from, cur.from), to: Math.max(r.to, cur.to) }
  }
  merged.push(cur)
  merged.sort((a, b) => a.from - b.from)
  return merged
}

// One registry of live stores for the page, keyed by source key. Templates read a store
// back by the key the host put in their extendData; the host creates and drops them.

const stores = new Map<string, SourceStore>()

export function storeFor<S extends SourceStore>(key: string, create: (key: string) => S): S {
  let s = stores.get(key) as S | undefined
  if (!s) {
    s = create(key)
    stores.set(key, s)
  }
  return s
}

export function peekStore<S extends SourceStore = SourceStore>(key: string | undefined): S | undefined {
  return key ? (stores.get(key) as S | undefined) : undefined
}

export function dropStore(key: string): void {
  stores.delete(key)
}

export function liveStores(): ReadonlyMap<string, SourceStore> {
  return stores
}
