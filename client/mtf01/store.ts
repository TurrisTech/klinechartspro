import { mergeRange, missingRanges, truncate } from '../plugins/store'
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

  /** The parts of `window` not yet fetched. Shared with `WindowStore` -- this store differs
   * in what a bar HOLDS, never in how coverage is tracked, and two copies of that arithmetic
   * only gave the two stores a way to disagree. */
  missing(window: Range): Range[] {
    return missingRanges(this.ranges, window)
  }

  addRange(range: Range): void {
    this.ranges = mergeRange(this.ranges, range)
  }

  /** Drop coverage at or after `from`, and both kinds of row held there -- the replay's
   * cursor moved, so a window fetched under the old clock held nothing for bars that had
   * not closed yet (`WindowStore.forgetAfter`, and `plugins/horizon.ts` for what `from` is).
   *
   * The dedup set has to be pruned WITH the rows, and it is the only part of this that is
   * not mechanical: `seen` is keyed by a row's OWN candle (`stage|interval|barDate`), not by
   * the bar it draws on, which is what the maps are keyed by. Drop a row and leave its key
   * behind and the refetch is deduplicated away -- the row is gone from the chart for good,
   * which is a worse bug than the one this method exists to fix. So the keys are rebuilt
   * from the rows actually being dropped, never guessed from the map key. */
  forgetAfter(from: number): void {
    this.ranges = truncate(this.ranges, from)
    for (const [date, rows] of [...this.events]) {
      if (date < from) continue
      for (const e of rows) this.seen.delete(eventKey(e))
      this.events.delete(date)
    }
    for (const [date, rows] of [...this.trades]) {
      if (date < from) continue
      for (const t of rows) this.seen.delete(tradeKey(t))
      this.trades.delete(date)
    }
    this.rev++
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

