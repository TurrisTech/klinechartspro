import type { ArevPoint } from '../arev/api'

// What the client holds for one (instrument, SOURCE timeframe) pair, plus which windows
// have been fetched so panning never re-requests a window it already has. Modelled on
// arev/store.ts, with two differences that both come from this being a multi-timeframe
// overlay rather than a pane of its own:
//
//   * it holds the source timeframe's BAR GRID beside the votes, because placing a vote
//     one bar forward needs the grid (see shift.ts) and the two are fetched together
//     over the same window, so one set of ranges covers both;
//   * it is keyed by the source timeframe, NOT by the chart's. Two panes showing 1h and
//     4h charts with the 1D overlay ticked share one store, because what they are both
//     reading is the 1D votes -- the chart's own interval only enters at drawing time.
//
// Windows are tracked in the SOURCE interval's own wire dates. That is a constant offset
// from absolute time for a fixed interval (shift.ts: zero intraday, +7h daily-and-
// coarser), so it orders and merges identically; mixing clocks would not.

export interface Range {
  from: number
  to: number
}

export type MtfPhase = 'idle' | 'loading' | 'ready' | 'error'

export class MtfStore {
  /** Source-bar wire date -> the arev21 vote cast on it. */
  readonly values = new Map<number, ArevPoint>()
  /** Source-bar wire dates, ascending and deduplicated -- the grid shift.ts walks. */
  private gridSet = new Set<number>()
  private gridSorted: number[] | null = null
  /** Fetched windows, merged, ascending. */
  private ranges: Range[] = []
  phase: MtfPhase = 'idle'
  error: string | null = null
  /** Bumped on every change; the klinecharts template's shouldUpdate compares it. */
  rev = 0

  constructor(readonly storeKey: string) {}

  setMany(points: ArevPoint[], grid: number[], window: Range): void {
    for (const point of points) this.values.set(point.date, point)
    for (const ms of grid) this.gridSet.add(ms)
    // Invalidated rather than re-sorted here: a pan can land several windows before any
    // template asks to draw, and sorting once on demand beats sorting once per fetch.
    if (grid.length > 0) this.gridSorted = null
    this.addRange(window)
    this.rev++
  }

  /** The source bar grid, ascending. Sorted lazily -- see setMany. */
  grid(): number[] {
    if (this.gridSorted === null) this.gridSorted = [...this.gridSet].sort((a, b) => a - b)
    return this.gridSorted
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

  setPhase(phase: MtfPhase, error: string | null = null): void {
    if (this.phase === phase && this.error === error) return
    this.phase = phase
    this.error = error
    this.rev++
  }
}

const stores = new Map<string, MtfStore>()

export function storeFor(storeKey: string): MtfStore {
  let store = stores.get(storeKey)
  if (!store) {
    store = new MtfStore(storeKey)
    stores.set(storeKey, store)
  }
  return store
}

export function peekStore(storeKey: string): MtfStore | undefined {
  return stores.get(storeKey)
}

export function dropStore(storeKey: string): void {
  stores.delete(storeKey)
}
