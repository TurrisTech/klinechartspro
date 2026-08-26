import type { Phase, Range, SourceStore } from '../plugins/types'
import type { Mtf01Event, Mtf01Trade } from './api'

// What the client holds for one (instrument, interval), plus which windows have been
// fetched, so panning never re-requests a window it already has. plugins/store.ts's WindowStore with two
// row kinds instead of one, and with explicit identity keys: an mtf01 row is placed on the
// bar it became ACTIONABLE on, so several arrows from different timeframes routinely land
// on one bar of a coarse chart, and paging can hand the same row back twice (events and
// trades are capped independently by the server, so a page boundary drawn by one overlaps
// the other). A row's identity is therefore its own candle, not the bar it draws on.

const eventKey = (e: Mtf01Event): string => `${e.stage}|${e.interval}|${e.barDate}`
const tradeKey = (t: Mtf01Trade): string => `${t.ltfInterval}|${t.barDate}`

export class Mtf01Store implements SourceStore<Mtf01Event> {
  /** Events by the chart bar they draw on, in arrival (time) order. */
  readonly events = new Map<number, Mtf01Event[]>()
  readonly trades = new Map<number, Mtf01Trade[]>()
  private readonly seen = new Set<string>()
  private ranges: Range[] = []
  phase: Phase = 'idle'
  error: string | null = null
  cascade: string | null = null
  /** Bumped on every change; the klinecharts template's shouldUpdate compares it. */
  rev = 0

  progress: number | null = null

  constructor(readonly key: string) {}

  /** Both kinds: the host's one gap loop covers them together. */
  get size(): number {
    return this.events.size + this.trades.size
  }

  ingest(events: Mtf01Event[], window: Range, arrays?: Record<string, { date: number }[]>): void {
    // `points` is the cascade events; the declared `trades` array rides beside them on
    // the same response over the same window, so one ingest covers both kinds.
    const trades = (arrays?.trades ?? []) as Mtf01Trade[]
    for (const e of events) {
      const key = eventKey(e)
      if (this.seen.has(key)) continue
      this.seen.add(key)
      const bar = this.events.get(e.date) ?? []
      bar.push(e)
      this.events.set(e.date, bar)
    }
    for (const t of trades) {
      const key = tradeKey(t)
      if (this.seen.has(key)) continue
      this.seen.add(key)
      const bar = this.trades.get(t.date) ?? []
      bar.push(t)
      this.trades.set(t.date, bar)
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

  setCascade(cascade: string | null): void {
    if (cascade == null || this.cascade === cascade) return
    this.cascade = cascade
    this.rev++
  }

  setPhase(phase: Phase, progress: number | null = null, error: string | null = null): void {
    this.progress = progress
    if (this.phase === phase && this.error === error) return
    this.phase = phase
    this.error = error
    this.rev++
  }
}

