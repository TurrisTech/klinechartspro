import type { ArevPoint } from './api'

// Points the client already holds for one (generation, instrument, interval), plus which
// time windows have been fetched, so panning never re-requests a window it already has.
// The same shape as indicators/store.ts's SeriesStore, but holding a three-valued AREV
// point per bar instead of one scalar, and with no replay/queue phases — the server only
// ever reads rows, so an answer is 'ready' or it failed.

export interface Range {
  from: number
  to: number
}

export type ArevPhase = 'idle' | 'loading' | 'ready' | 'error'

export class ArevStore {
  readonly values = new Map<number, ArevPoint>()
  /** Fetched windows, merged, ascending. */
  private ranges: Range[] = []
  phase: ArevPhase = 'idle'
  error: string | null = null
  /** Bumped on every change; the klinecharts template's shouldUpdate compares it. */
  rev = 0

  constructor(readonly storeKey: string) {}

  setMany(points: ArevPoint[], window: Range): void {
    for (const p of points) this.values.set(p.date, p)
    this.addRange(window)
    this.rev++
  }

  /** The parts of `window` not yet fetched (0..2 sub-windows, in order). */
  missing(window: Range): Range[] {
    let gaps: Range[] = [{ ...window }]
    for (const r of this.ranges) {
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

  addRange(range: Range): void {
    const merged: Range[] = []
    let cur = { ...range }
    for (const r of this.ranges) {
      if (r.to < cur.from || r.from > cur.to) merged.push(r)
      else cur = { from: Math.min(r.from, cur.from), to: Math.max(r.to, cur.to) }
    }
    merged.push(cur)
    merged.sort((a, b) => a.from - b.from)
    this.ranges = merged
  }

  setPhase(phase: ArevPhase, error: string | null = null): void {
    if (this.phase === phase && this.error === error) return
    this.phase = phase
    this.error = error
    this.rev++
  }
}

const stores = new Map<string, ArevStore>()

export function storeFor(storeKey: string): ArevStore {
  let s = stores.get(storeKey)
  if (!s) {
    s = new ArevStore(storeKey)
    stores.set(storeKey, s)
  }
  return s
}

export function peekStore(storeKey: string): ArevStore | undefined {
  return stores.get(storeKey)
}

export function dropStore(storeKey: string): void {
  stores.delete(storeKey)
}
