import type { KrevPoint, KrevSide } from './api'

// Points the client already holds for one (instrument, interval), plus which time windows
// have been fetched, so panning never re-requests a window it already has. The same shape
// as arev/store.ts, except that a bar can carry two points — a top and a bottom candidate
// can print on the same bar — so values are keyed by bar and then by side.

export interface Range {
  from: number
  to: number
}

export type KrevPhase = 'idle' | 'loading' | 'ready' | 'error'

export type BarPoints = Partial<Record<KrevSide, KrevPoint>>

export class KrevStore {
  readonly values = new Map<number, BarPoints>()
  private ranges: Range[] = []
  phase: KrevPhase = 'idle'
  error: string | null = null
  /** Bumped on every change; the klinecharts template's shouldUpdate compares it. */
  rev = 0

  constructor(readonly storeKey: string) {}

  setMany(points: KrevPoint[], window: Range): void {
    for (const p of points) {
      const bar = this.values.get(p.date) ?? {}
      bar[p.side] = p
      this.values.set(p.date, bar)
    }
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

  setPhase(phase: KrevPhase, error: string | null = null): void {
    if (this.phase === phase && this.error === error) return
    this.phase = phase
    this.error = error
    this.rev++
  }
}

const stores = new Map<string, KrevStore>()

export function storeFor(storeKey: string): KrevStore {
  let s = stores.get(storeKey)
  if (!s) {
    s = new KrevStore(storeKey)
    stores.set(storeKey, s)
  }
  return s
}

export function peekStore(storeKey: string): KrevStore | undefined {
  return stores.get(storeKey)
}

export function dropStore(storeKey: string): void {
  stores.delete(storeKey)
}
