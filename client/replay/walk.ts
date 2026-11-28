import type { SimEvent } from '../trading/api'
import { BarCache, type BarSource, type ReplayBar } from '../bars/cache'
import { canFill, intersectsWorking } from './clock'
import type { Engine } from '../sim/engine'
import { toBidAsk } from '../sim/bidask'
import type { CandleGrid } from '../time/timeframes'
import { nextTask } from '../bars/yield'
import { coarser, divides, finerStored, nominalMs, sortByLength } from '../time/intervals'

// GLUE. THE WALK: how an advance takes the cursor forward over stored bars, once the session
// (session.ts) has planned where it stops and found that something could happen on the way -- an
// order that could fill, a trade that could close, a watch that could fire. It hands every bar
// over the one way (`handOver`): to the engine first -- refined onto the finer stored bars inside
// it where its range reaches something working (`consume`) -- then to the observer, then the
// cursor to its close; and it stops between two whole bars, on a fill pause, a firing watch or a
// Stop. Two ways to go:
//
//   walk   the base bars from the session's cache, a page at a time (WALK_CHUNK_BARS)
//   skim   the coarsest stored candles nothing can happen on, handed over whole, descending to
//          the base bars only where something could (`summaryIntervals`)
//
// The session keeps everything around it: whether to walk, skim or seek, what a run that found
// nothing puts back, the reason the advance stopped, and who is told. The walk moves the
// session's cursor bar by bar, as it goes -- the controls and the wall read it mid-walk -- and
// hands the event loop back every WALK_YIELD_MS, so a Stop is heard at all.

/** How much of the span a walk fetches at once, in base bars: about one server page
 * (`HttpBarSource` pages at 80% of the 5,000-bar cap). A walk used to fetch the whole span
 * before reading its first bar, so a year at a 1m base was a minute of download nothing could
 * interrupt; fetched a page at a time, a cancel is heard between pages. */
export const WALK_CHUNK_BARS = 4000

/** Longest a walk runs without handing the event loop back, in ms. Once its bars are cached a
 * walk is synchronous work end to end, so without this a Stop click could not even be
 * DELIVERED until the walk had finished. */
const WALK_YIELD_MS = 50

/** Something an observer raised on a bar that is worth stopping an advance for -- a price
 * watch firing. Only what the controls need to say why the advance stopped. */
export interface ObserverStop {
  label: string
}

/** The half of the session's observer (session.ts `ReplayObserver`) the walk talks to.
 *
 * The engine is not the only consumer of a base bar: a price watch placed on a replay wall
 * is answered by the same bars, at the same granularity, in the same order
 * (`client/replay/watches.ts`). This is the whole of that seam — the walk knows there is
 * an observer, and nothing about what it does with a bar. */
export interface WalkObserver {
  /** True when an advance must WALK base bars even though the account cannot change. An
   * armed watch is such a reason: without this the seek shortcut would step over the whole
   * span it was placed to see. */
  needsBars(): boolean
  /** One base bar the engine has just consumed, in walk order. Always the BASE bar, never a
   * refinement's finer parts: whether an order happens to be resting must not change what an
   * observer sees. Returns what it raised on this bar; the advance (Step or Next alert) stops
   * on any. */
  onBar(bar: ReplayBar): ObserverStop[]
  /** Whether nothing it watches could raise anything on any base bar inside the span `bar` --
   * a coarser stored candle -- covers. True lets the walk hand it `bar` (through `onBar`)
   * instead of every base bar inside, which is what makes a price watch months away cost a
   * handful of reads rather than a walk of every minute. Optional: without it every base bar is
   * walked. */
  quietOver?(bar: ReplayBar): boolean
}

/** The session a walk moves. */
export interface WalkHost {
  /** Moved bar by bar to the close of each bar handed over; read where the next page starts. */
  cursor: number
  /** A Stop has been asked for: the walk stops at its next natural place, between two bars. */
  readonly cancelling: boolean
}

interface ReplayWalkerOptions {
  host: WalkHost
  engine: Engine
  barSource: BarSource
  /** The engine's instrument key, `vendor:TICKER`: the one instrument walked. */
  symbol: string
  grid: CandleGrid
  /** What the refinement may descend to. */
  storedIntervals: readonly string[]
  /** Fed every base bar the walk consumes. */
  observer?: WalkObserver
  /** Whether an instant is in the viewer's quiet hours (quiet.ts), where a milestone reached is
   * not heard (`heard`). Absent: nothing is silenced. */
  silenced?: (at: number) => boolean
}

/** Where a walk has got: what it handed the observer, why it stopped. */
export interface WalkState {
  /** The base it walks in: what a bar is handed over as, and what the skim descends to. */
  base: string
  consumed: ReplayBar[]
  observed: ObserverStop[]
  cancelled: boolean
  /** Something can fill: the engine is fed what is handed over, and a candle whose range reaches
   * a resting order, a stop loss or a take profit is not handed over whole. */
  fillable: boolean
  /** Whether a fill or a close ends the advance, and whether one did. */
  pauseOn: boolean
  paused: boolean
  /** What the engine produced on the way. */
  events: SimEvent[]
  /** The last bar handed over: its close is the quote the engine lands on. */
  last: ReplayBar | null
  sliceStart: number
  report: () => void
}

/** The stored intervals a skim reads in place of base bars: coarser than the base, made of
 * whole base candles, a day at most -- coarsest first (1D then 1h over a 1m base). */
export function summaryIntervals(storedIntervals: readonly string[], base: string): string[] {
  const day = nominalMs('1D')
  return sortByLength(storedIntervals.filter((code) => coarser(code, base) && divides(base, code) && nominalMs(code) <= day)).reverse()
}

/** What ends a run to the next event (and a Step or Play with Pause on fill): a fill, a close --
 * a stop loss, take profit, trailing or breakeven stop hit -- or a milestone reached (outside
 * quiet hours: one reached inside them is never heard, `heard`). */
function stopsARun(event: SimEvent): boolean {
  return event.kind === 'fill' || event.kind === 'close' || event.kind === 'milestone'
}

/** One session's walks. Holds the caches the refinement reads finer bars from, for the session's
 * life. */
export class ReplayWalker {
  private readonly refinements = new Map<string, BarCache>()

  constructor(private readonly opts: ReplayWalkerOptions) {}

  /** THE WALK of the base bars in `cache` up to `stopAt`, one page of the span at a time. */
  async walk(cache: BarCache, stopAt: number, trail: WalkState): Promise<void> {
    const host = this.opts.host
    const chunk = WALK_CHUNK_BARS * nominalMs(trail.base)
    let reach = host.cursor
    trail.sliceStart = performance.now()
    walk: for (;;) {
      // Before the page downloads: that wait is the likeliest to look like a hang.
      trail.report()
      // One page of the span at a time (WALK_CHUNK_BARS). `reach` moves on by a whole
      // chunk even when the chunk held no bar -- a weekend, a gap in the store -- so the
      // walk always ends, at `stopAt`.
      reach = Math.min(stopAt, Math.max(reach, host.cursor) + chunk)
      await cache.ensure(reach, host.cursor)
      for (;;) {
        const bar = cache.peek()
        if (!bar || bar.end > reach) break
        // The natural place to stop: between two whole base bars.
        if (host.cancelling) {
          trail.cancelled = true
          break walk
        }
        cache.take(bar.end)
        if (await this.handOver(bar, trail)) break walk
        if (performance.now() - trail.sliceStart > WALK_YIELD_MS) {
          trail.report()
          await nextTask()
          trail.sliceStart = performance.now()
        }
      }
      if (reach >= stopAt) break
      if (host.cancelling) {
        trail.cancelled = true
        break
      }
    }
  }

  /**
   * THE SKIM: the walk of `[from, to)` by the coarsest candles nothing can happen on. Each whole
   * candle of `levels[level]` inside the span is asked about first: when it is quiet -- no watch
   * could fire on any bar inside it, and its bid/ask range reaches no resting order, stop loss or
   * take profit -- it is handed over as one bar and the cursor moves past it; otherwise the walk
   * descends into it a level finer, down to the base bars, which are handed over one by one
   * exactly as a walk hands them (to the engine first, then the watches). The parts of the span
   * no whole candle covers -- the head before the first, the tail after the last, a hole in the
   * coarser store -- descend the same way; a stretch the market is closed throughout is passed
   * over.
   *
   * So a watch, or a stop loss, a month away costs one read of daily candles and, near the
   * level, one of hours and one of minutes, where the walk read every minute between. What
   * happens, and where, is the walk's answer: `neverWithin` (client/alerts/conditions.ts) only
   * skips a candle on which no watch could have fired, `intersectsWorking` (clock.ts) one on
   * which nothing could have filled -- the engine takes such a candle whole, and only its quote
   * and clock move, as they would over the bars inside it -- and the base bars decide the rest.
   * True when it stopped (a watch fired, a fill or a close paused it, or a Stop was pressed).
   */
  async skim(level: number, from: number, to: number, levels: readonly string[], trail: WalkState): Promise<boolean> {
    if (to <= from) return false
    // A span shorter than one candle of this level holds none whole: on to the next, unread.
    if (level < levels.length && to - from < nominalMs(levels[level])) return this.skim(level + 1, from, to, levels, trail)
    const { barSource, symbol, grid } = this.opts
    if (level === levels.length) {
      for (const bar of await barSource.fetch(symbol, trail.base, from, to, 'all', grid)) {
        if (bar.open < from || bar.end > to) continue
        if (await this.breathe(trail)) return true
        if (await this.handOver(bar, trail)) return true
      }
      return false
    }
    const candles = (await barSource.fetch(symbol, levels[level], from, to, 'all', grid)).filter((b) => b.open >= from && b.end <= to)
    let at = from
    for (const candle of candles) {
      if (candle.open > at && !this.closedThroughout(at, candle.open, trail.base) && (await this.skim(level + 1, at, candle.open, levels, trail))) return true
      if (await this.breathe(trail)) return true
      if (this.quietOver(candle, trail)) {
        // Nothing can happen on it, so nothing does: the watches' baseline moves on, and the
        // engine takes its quote and clock. Whatever it reports all the same is kept, and ends the
        // run as a fill on a base bar would -- never dropped.
        if (await this.handOver(candle, trail, true)) return true
      } else if (await this.skim(level + 1, candle.open, candle.end, levels, trail)) return true
      at = candle.end
    }
    if (at < to && !this.closedThroughout(at, to, trail.base)) return this.skim(level + 1, at, to, levels, trail)
    return false
  }

  /** Hand `bar` over, the one way every walk does: to the engine when something can fill --
   * refined onto the finer stored bars inside it (`consume`), unless it is a candle the skim
   * found quiet and hands over `whole` -- then to the observer, then the cursor to its close.
   * True when the walk stops on it: a fill or a close paused it, or the observer raised
   * something on it (never on a `whole` candle: it was handed over because nothing could). */
  private async handOver(bar: ReplayBar, trail: WalkState, whole = false): Promise<boolean> {
    const fed = !trail.fillable ? [] : whole ? this.opts.engine.onBar(toBidAsk(bar, this.opts.symbol)) : await this.consume(bar, trail.base)
    const produced = this.heard(fed)
    trail.events.push(...produced)
    // After the engine, so anything an observer raises sees the account as this bar left it --
    // and the BASE bar, not the refinement's parts.
    const raised = this.opts.observer?.onBar(bar) ?? []
    trail.consumed.push(bar)
    trail.last = bar
    this.opts.host.cursor = bar.end
    if (trail.pauseOn && produced.some(stopsARun)) {
      trail.paused = true
      return true
    }
    // A firing watch ends ANY advance, a Step as much as Next alert: it is the move the watch
    // was placed to catch, and walking on past it would put the cursor, and every pane,
    // somewhere other than where it happened.
    if (!whole && raised.length > 0) {
      trail.observed = raised
      return true
    }
    return false
  }

  /** What of the events a bar produced the run HEARS: every one, but a milestone -- a trade's
   * "Notify at" -- reached in quiet hours (user, 2026-11-26: "align notify at to be an alert, it
   * stays silent during quiet hours and doesn't alert at the end"). The engine has recorded it
   * reached -- the trade did get there, at that instant -- so it is not told later either; but it
   * ends no run, rings nothing and opens no panel. Fills and closes are the account, and are
   * always heard ("fills and exits should alert even during quiet hours"). */
  private heard(produced: SimEvent[]): SimEvent[] {
    const silenced = this.opts.silenced
    if (!silenced || produced.length === 0) return produced
    return produced.filter((event) => event.kind !== 'milestone' || !silenced(event.time))
  }

  /** Whether nothing could happen on `candle`: no watch could fire on it, and -- when something
   * can fill -- its bid/ask range, from the last quote on, reaches no resting order, stop loss or
   * take profit. From the last quote, because a price can GAP through a level without any bar's
   * range holding it: a buy limit at 1.0900 with Friday's close at 1.1000 and Sunday's open at
   * 1.0800 fills at the open, and Sunday's candles alone never reach 1.0900. */
  private quietOver(candle: ReplayBar, trail: WalkState): boolean {
    const { observer, engine, symbol } = this.opts
    if (observer?.needsBars() && !observer.quietOver?.(candle)) return false
    if (!trail.fillable) return true
    const bid = candle.bid ?? { l: candle.l, h: candle.h }
    const ask = candle.ask ?? { l: candle.l, h: candle.h }
    const quote = engine.quotes.get(symbol)
    const band = {
      bidLow: Math.min(bid.l, quote?.bid ?? bid.l),
      bidHigh: Math.max(bid.h, quote?.bid ?? bid.h),
      askLow: Math.min(ask.l, quote?.ask ?? ask.l),
      askHigh: Math.max(ask.h, quote?.ask ?? ask.h)
    }
    return !intersectsWorking(band, [...engine.orders.values()], [...engine.trades.values()], symbol)
  }

  /** Between two bars of a skim: hand the event loop back now and then, report the progress,
   * and say whether a Stop was pressed (the natural place to stop). */
  private async breathe(trail: WalkState): Promise<boolean> {
    if (performance.now() - trail.sliceStart > WALK_YIELD_MS) {
      trail.report()
      await nextTask()
      trail.sliceStart = performance.now()
    }
    if (!this.opts.host.cancelling) return false
    trail.cancelled = true
    return true
  }

  /** Whether the market is closed from `from` until `to` (a weekend between two daily candles):
   * no candle of any interval opens in it, so there is nothing to read. */
  private closedThroughout(from: number, to: number, base: string): boolean {
    return !this.opts.grid.isOpen(from) && this.opts.grid.nextStart(base, from) >= to
  }

  /** Feed one bar of `interval` to the engine -- or, when it can interact with something
   * working, the finer stored bars inside it instead (recursively, down to the finest
   * stored). Refinement changes which bars the engine sees, never where the cursor lands. */
  private async consume(bar: ReplayBar, interval: string): Promise<SimEvent[]> {
    const { engine, symbol } = this.opts
    const orders = [...engine.orders.values()]
    const trades = [...engine.trades.values()]
    if (!canFill(orders, trades, symbol)) return engine.onBar(toBidAsk(bar, symbol))
    const band = bar.bid && bar.ask ? { bidLow: bar.bid.l, bidHigh: bar.bid.h, askLow: bar.ask.l, askHigh: bar.ask.h } : { bidLow: bar.l, bidHigh: bar.h, askLow: bar.l, askHigh: bar.h }
    if (!intersectsWorking(band, orders, trades, symbol)) return engine.onBar(toBidAsk(bar, symbol))
    const finer = finerStored(interval, this.opts.storedIntervals)
    const next = finer.at(-1)
    if (next === undefined) return engine.onBar(toBidAsk(bar, symbol))
    const cache = this.refinement(next)
    cache.seek(bar.open)
    await cache.ensure(bar.end)
    const parts = cache.take(bar.end).filter((p) => p.open >= bar.open && p.end <= bar.end)
    if (parts.length === 0) return engine.onBar(toBidAsk(bar, symbol))
    const events: SimEvent[] = []
    for (const part of parts) events.push(...(await this.consume(part, next)))
    return events
  }

  private refinement(interval: string): BarCache {
    let c = this.refinements.get(interval)
    if (!c) {
      c = new BarCache(this.opts.barSource, this.opts.symbol, interval, this.opts.grid, 'all')
      this.refinements.set(interval, c)
    }
    return c
  }

  dispose(): void {
    for (const c of this.refinements.values()) c.dump()
  }
}
