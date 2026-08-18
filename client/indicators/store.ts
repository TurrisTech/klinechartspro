import type { IndicatorPoint } from './api'

// Values the client already holds for one series (keyed by SeriesIdentity.key() as the server
// reports it), plus which time windows have been fetched, so panning never re-requests a
// window it already has -- decision 14: uniformly, with no knowledge of storage mode. Lives
// for as long as some pane shows the series; dropped with the last user (controller.ts).

export interface Range {
  from: number
  to: number
}

export type SeriesPhase = 'idle' | 'loading' | 'queued' | 'replaying' | 'ready' | 'error'

export class SeriesStore {
  readonly values = new Map<number, number | null>()
  /** Fetched windows, merged, ascending. */
  private ranges: Range[] = []
  phase: SeriesPhase = 'idle'
  progress: number | null = null
  error: string | null = null
  /** Bumped on every change; the klinecharts template's shouldUpdate compares it. */
  rev = 0

  constructor(readonly seriesKey: string) {}

  set(point: IndicatorPoint): void {
    this.values.set(point.date, point.value)
    this.rev++
  }

  setMany(points: IndicatorPoint[], window: Range): void {
    for (const p of points) this.values.set(p.date, p.value)
    this.addRange(window)
    this.rev++
  }

  covers(window: Range): boolean {
    return this.ranges.some((r) => r.from <= window.from && r.to >= window.to)
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

  /** The newest timestamp held, or null. */
  latest(): number | null {
    let max: number | null = null
    for (const t of this.values.keys()) if (max === null || t > max) max = t
    return max
  }

  setPhase(phase: SeriesPhase, progress: number | null = null, error: string | null = null): void {
    if (this.phase === phase && this.progress === progress && this.error === error) return
    this.phase = phase
    this.progress = progress
    this.error = error
    this.rev++
  }
}

const stores = new Map<string, SeriesStore>()

export function storeFor(seriesKey: string): SeriesStore {
  let s = stores.get(seriesKey)
  if (!s) {
    s = new SeriesStore(seriesKey)
    stores.set(seriesKey, s)
  }
  return s
}

export function peekStore(seriesKey: string): SeriesStore | undefined {
  return stores.get(seriesKey)
}

export function dropStore(seriesKey: string): void {
  stores.delete(seriesKey)
}

// Debug hook: `window.__wdIndicators.stores` lets a console (or a headless test) inspect what
// the client holds per series -- read-only by convention, never used by the app itself.
declare global {
  interface Window {
    __wdIndicators?: { stores: Map<string, SeriesStore>; debug?: () => unknown[] }
  }
}
if (typeof window !== 'undefined') window.__wdIndicators = { ...(window.__wdIndicators ?? {}), stores }
