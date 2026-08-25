import { intervalEnd, isMarketOpen, nextIntervalStart, nominalMs, toWireDate } from './timeframes'

// BarCache: one per (instrument, timeframe), over an injected `BarSource`. Holds a
// CONTIGUOUS run of bars at and ahead of an anchor, prefetched so a step consumes cache
// rather than calling the server, and refilled ahead as the anchor advances. No knowledge
// of the chart.
//
// Walk vs seek -- the rule that keeps this correct. A cache is either WALKED (consumed
// contiguously forward: `take`) or SEEKED (dumped whole and reloaded at a new anchor:
// `seek`). Never both, and never a partial append onto a stale run: `ensure` only ever
// extends the run from its own end, and a range that would not touch the run is a seek.

/** A stored bar on the STORE clock (`open` is the candle's canonical open), with the wire
 * date the chart labels it by, and bid/ask when the source has them. */
export interface ReplayBar {
  open: number
  end: number
  date: number
  o: number
  h: number
  l: number
  c: number
  v: number
  bid?: { o: number; h: number; l: number; c: number }
  ask?: { o: number; h: number; l: number; c: number }
}

export type Columns = 'core' | 'all'

export interface BarSource {
  /** Bars of `[from, to)` on the store clock, ascending, unclamped (the cache hides them from
   * the chart until they are consumed). Must page internally past the server's cap. */
  fetch(symbol: string, interval: string, from: number, to: number, columns: Columns): Promise<ReplayBar[]>
}

/** How far ahead of the anchor a cache keeps bars, in bars of its own interval. */
export const PREFETCH_BARS = 400

export class BarCache {
  private bars: ReplayBar[] = []
  /** The instant the cache is loaded from: every held bar opens at or after it. */
  private anchor: number | null = null
  /** How far `[anchor, coveredTo)` has been fetched -- contiguous with the run. */
  private coveredTo: number | null = null
  private inflight: Promise<void> | null = null

  constructor(
    readonly source: BarSource,
    readonly symbol: string,
    readonly interval: string,
    readonly columns: Columns = 'all'
  ) {}

  get size(): number {
    return this.bars.length
  }

  get anchoredAt(): number | null {
    return this.anchor
  }

  get reach(): number | null {
    return this.coveredTo
  }

  /** The held bars, oldest first (a copy). */
  peekAll(): ReplayBar[] {
    return [...this.bars]
  }

  /** Drop everything. */
  dump(): void {
    this.bars = []
    this.anchor = null
    this.coveredTo = null
  }

  /** Dump and re-anchor at `at`: the next `ensure` loads from there. */
  seek(at: number): void {
    this.dump()
    this.anchor = at
    this.coveredTo = at
  }

  /** Whether the run covers `[anchor, until)`. */
  covers(until: number): boolean {
    return this.coveredTo !== null && this.coveredTo >= until
  }

  /** Extend the run so it covers up to `until` (plus a prefetch margin), from its own end
   * only. A cache with no anchor anchors at `from`. */
  async ensure(until: number, from?: number): Promise<void> {
    if (this.anchor === null) {
      if (from === undefined) throw new Error('BarCache.ensure: no anchor; seek first')
      this.seek(from)
    }
    if (this.covers(until)) return
    if (this.inflight) {
      await this.inflight
      if (this.covers(until)) return
    }
    const start = this.coveredTo as number
    const margin = PREFETCH_BARS * nominalMs(this.interval)
    const to = Math.max(until, start + margin)
    this.inflight = this.source
      .fetch(this.symbol, this.interval, start, to, this.columns)
      .then((fetched) => {
        // Only bars strictly after what we hold: the source answers [start, to) but a bar
        // opening exactly at `start` may already be the run's tail.
        const last = this.bars.at(-1)
        for (const bar of fetched) {
          if (last && bar.open <= last.open) continue
          this.bars.push(bar)
        }
        this.coveredTo = Math.max(to, this.coveredTo ?? to)
      })
      .finally(() => {
        this.inflight = null
      })
    await this.inflight
  }

  /** Consume (remove and return) every held bar that has CLOSED by `until` (`end <= until`).
   * The walk: contiguous, forward, never a bar twice. */
  take(until: number): ReplayBar[] {
    let n = 0
    while (n < this.bars.length && this.bars[n].end <= until) n++
    const taken = this.bars.splice(0, n)
    if (taken.length > 0) this.anchor = Math.max(this.anchor ?? 0, taken[taken.length - 1].end)
    return taken
  }

  /** Drop held bars opening before `ms` without consuming anything else -- a display cache
   * letting go of what every pane has moved past. The anchor follows. */
  trimBefore(ms: number): void {
    let n = 0
    while (n < this.bars.length && this.bars[n].open < ms) n++
    if (n > 0) this.bars.splice(0, n)
    if (this.anchor !== null && this.anchor < ms) this.anchor = Math.min(ms, this.coveredTo ?? ms)
  }

  /** Make the run cover `[from, to)`: a `from` before the anchor is a seek (dump and reload
   * there), anything else an `ensure`. For display caches that read by `slice`. */
  async cover(from: number, to: number): Promise<void> {
    if (this.anchor === null || from < this.anchor) this.seek(from)
    await this.ensure(to)
  }

  /** The next bar in the run (not consumed), or null. */
  peek(): ReplayBar | null {
    return this.bars[0] ?? null
  }

  /** The held bars opening in `[from, to)`, without consuming. */
  slice(from: number, to: number): ReplayBar[] {
    return this.bars.filter((b) => b.open >= from && b.open < to)
  }
}

/** Compose the forming `interval` bar from finer bars inside its bucket (`bucketOpen` on
 * the store clock). Null when no finer bar has closed inside it. */
export function composeForming(interval: string, bucketOpen: number, parts: readonly ReplayBar[]): ReplayBar | null {
  if (parts.length === 0) return null
  const first = parts[0]
  const last = parts[parts.length - 1]
  const bar: ReplayBar = {
    open: bucketOpen,
    end: intervalEnd(interval, bucketOpen),
    date: toWireDate(interval, bucketOpen),
    o: first.o,
    h: Math.max(...parts.map((p) => p.h)),
    l: Math.min(...parts.map((p) => p.l)),
    c: last.c,
    v: parts.reduce((s, p) => s + p.v, 0)
  }
  if (parts.every((p) => p.bid && p.ask)) {
    bar.bid = {
      o: (first.bid as NonNullable<ReplayBar['bid']>).o,
      h: Math.max(...parts.map((p) => (p.bid as NonNullable<ReplayBar['bid']>).h)),
      l: Math.min(...parts.map((p) => (p.bid as NonNullable<ReplayBar['bid']>).l)),
      c: (last.bid as NonNullable<ReplayBar['bid']>).c
    }
    bar.ask = {
      o: (first.ask as NonNullable<ReplayBar['ask']>).o,
      h: Math.max(...parts.map((p) => (p.ask as NonNullable<ReplayBar['ask']>).h)),
      l: Math.min(...parts.map((p) => (p.ask as NonNullable<ReplayBar['ask']>).l)),
      c: (last.ask as NonNullable<ReplayBar['ask']>).c
    }
  }
  return bar
}

export interface Gap {
  after: number
  before: number
}

/** The gaps in a run of bars that are NOT the market-closed window: a bar whose next
 * candle on the grid opened while the market was open, yet the next held bar is later.
 * Stored data legitimately skips candles with no ticks, so a gap is reported, not fatal --
 * the caller decides (a chart append asserts none against what it pushed). */
export function nonWeekendGaps(interval: string, bars: readonly ReplayBar[]): Gap[] {
  const gaps: Gap[] = []
  for (let i = 1; i < bars.length; i++) {
    const expected = nextIntervalStart(interval, bars[i - 1].open)
    if (bars[i].open > expected && isMarketOpen(expected)) gaps.push({ after: bars[i - 1].open, before: bars[i].open })
  }
  return gaps
}
