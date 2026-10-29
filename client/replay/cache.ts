import { type CandleGrid, divides, nominalMs, sortByLength } from './timeframes'

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
   * the chart until they are consumed). Must page internally past the server's cap. `grid` is
   * the instrument's schedule: it turns a wire label into a candle's open and close. */
  fetch(symbol: string, interval: string, from: number, to: number, columns: Columns, grid: CandleGrid): Promise<ReplayBar[]>
  /** Load ahead what reads of `intervals` from `at` on will need, before they are made. Optional:
   * a source without it fetches when asked. */
  warm?(symbol: string, intervals: readonly string[], at: number, grid: CandleGrid): Promise<void>
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
    /** The instrument's schedule: the cache's bars are opened, closed and dated on it. */
    readonly grid: CandleGrid,
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
      .fetch(this.symbol, this.interval, start, to, this.columns, this.grid)
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

  /** Make the run cover `[from, to)`: a `from` before the anchor or past the run's end is a
   * seek (dump and reload there), anything else an `ensure`. For display caches that read by
   * `slice`. Past the end matters after a jump: extending the run from its own end would read
   * every bar of the gap -- a day of 5s bars (~17,000, five pages one after another) for a
   * forming candle that needs the last few minutes of it. */
  async cover(from: number, to: number): Promise<void> {
    if (this.anchor === null || from < this.anchor || (this.coveredTo !== null && from > this.coveredTo)) this.seek(from)
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

/** The stored intervals a forming `interval` candle is composed from, coarsest first and ending
 * at `base`: every stored interval coarser than the base that the base tiles and that tiles
 * `interval`. A 1D pane on a 5s base with 1m and 1h stored composes from 1h, 1m, 5s, so its
 * forming candle at 06:00 is thirteen 1h bars rather than 9,360 5s ones. With nothing stored
 * known, the base alone. `stored` must be what the vendor really stores (`probeStoredIntervals`
 * cuts the probe to it): an interval the server only folds is not a rung.
 *
 * Whether it is the same candle the base alone would make depends on the vendor, and was measured
 * on prod (2026-10-26 and -29; each stored bar against its finer stored bars aggregated, every
 * field, bid and ask included):
 *
 * - oanda: exact. 1D against 1h on 1,003 session-days of seven instruments 2010-2026 (Sunday
 *   opens, month ends, both DST changes), against 1m on 56 and 5s on 4; 1h and 1m against 5s on
 *   five symbol-days.
 * - coinbase: prices exact on the backfilled history; a few recent live-written hours differ in
 *   one price by up to 0.06% (at most 6 of 336 an instrument). Volume differs on most bars,
 *   because each interval's decimal volume is rounded to a whole unit on its own (wmarketdata
 *   `sources/coinbase/_util`): a BTC minute is about 2 BTC, so the coarser rung is the more
 *   accurate volume, not the less.
 * - schwab: not exact, and nothing could make it so. Its daily is the exchange's official bar --
 *   closing-auction close (differs from the last minute's on 56 of 59 SPY days), consolidated
 *   volume (1.2-2.1x the minutes') -- not an aggregate of anything stored. It stays a rung of
 *   1W and 1M all the same: a week is folded from those very days (94 of 94 SPY weeks equal),
 *   so the forming week ends as the bar that replaces it, matches the 1D pane beside it, and
 *   agrees on every finished day with the server's `asof` rebuild (which folds closed 1D bars);
 *   composed from minutes, every finished day of it would show about a third less volume than
 *   the closed weeks to its left. */
export function composeLadder(interval: string, base: string, stored: readonly string[]): string[] {
  const between = stored.filter((s) => s !== base && s !== interval && nominalMs(s) > nominalMs(base) && nominalMs(s) < nominalMs(interval) && divides(base, s) && divides(s, interval))
  return [...sortByLength(between).reverse(), base]
}

/** The bars of one ladder interval a forming candle takes: those opening in `[from, to)`. */
export interface ComposeSpan {
  interval: string
  from: number
  to: number
}

/** Where the forming candle opening at `bucketOpen` takes its bars from with the cursor at
 * `cursor`: each ladder interval in turn takes its whole candles that closed by the cursor, from
 * where the coarser one stopped, and the base (last) takes the rest. Consecutive and in time
 * order; an empty span is left out. */
export function composeSpans(bucketOpen: number, cursor: number, ladder: readonly string[], grid: CandleGrid): ComposeSpan[] {
  const spans: ComposeSpan[] = []
  let from = bucketOpen
  ladder.forEach((interval, i) => {
    let to = cursor
    if (i < ladder.length - 1) {
      // The candle the cursor is inside has not closed: this interval stops at its open.
      const open = grid.start(interval, cursor - 1)
      if (grid.end(interval, open) > cursor) to = Math.max(from, open)
    }
    if (to > from) spans.push({ interval, from, to })
    from = Math.max(from, to)
  })
  return spans
}

/** Compose the forming `interval` bar from finer bars inside its bucket (`bucketOpen` on
 * the store clock), closed and labelled on the instrument's schedule. Null when no finer bar
 * has closed inside it. */
export function composeForming(interval: string, bucketOpen: number, parts: readonly ReplayBar[], grid: CandleGrid): ReplayBar | null {
  if (parts.length === 0) return null
  const first = parts[0]
  const last = parts[parts.length - 1]
  const bar: ReplayBar = {
    open: bucketOpen,
    end: grid.end(interval, bucketOpen),
    date: grid.toWire(interval, bucketOpen),
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
export function nonWeekendGaps(interval: string, bars: readonly ReplayBar[], grid: CandleGrid): Gap[] {
  const gaps: Gap[] = []
  for (let i = 1; i < bars.length; i++) {
    const expected = grid.nextStart(interval, bars[i - 1].open)
    if (bars[i].open > expected && grid.isOpen(expected)) gaps.push({ after: bars[i - 1].open, before: bars[i].open })
  }
  return gaps
}
