import { OhlcvApiError } from '../config'
import type { LocalWatchState } from '../watch/local'
import type { OrderPatch, OrderRequest, SimAnswer, SimEvent, SimSnapshot, TradePatch } from '../trading/api'
import type { SessionListener, TradingSession } from '../trading/session'
import { BarCache, type BarSource, type ReplayBar } from './cache'
import { type AdvanceRequest, type SignalOccurrence, type StopReason, canFill, intersectsWorking, planAdvance } from './clock'
import { type BidAskBar, type Engine, SimError } from './engine'
import { type AdvanceSetting, type ReplayState, serialize } from './persist'
import type { SignalBook } from './signals'
import { type BaseCheck, finerStored, nominalMs, validateBase } from './timeframes'

/** How far back `quoteAt` looks for the last closed base bar, before widening. */
const QUOTE_PROBE_BARS = 50

/** How much of the span a walk fetches at once, in base bars: about one server page
 * (`HttpBarSource` pages at 80% of the 5,000-bar cap). A walk used to fetch the whole span
 * before reading its first bar, so a year at a 1m base was a minute of download nothing could
 * interrupt; fetched a page at a time, a cancel is heard between pages. */
export const WALK_CHUNK_BARS = 4000

/** Longest a walk runs without handing the event loop back, in ms. Once its bars are cached a
 * walk is synchronous work end to end, so without this a Stop click could not even be
 * DELIVERED until the walk had finished. */
export const WALK_YIELD_MS = 50

// GLUE. `ReplayTradingSession` implements `TradingSession` (the seam the whole trading UI
// acts through) over the client-side engine and the bar caches, and is the
// `ReplayController` the control strip drives. It owns the clock: nothing else moves the
// cursor, and every read the chart makes is clamped to it (by the caller, through
// config.ts's read clock, in `onAdvanced`).

export interface AdvanceResult {
  from: number
  to: number
  reason: StopReason
  signal: SignalOccurrence | null
  events: SimEvent[]
  /** Base bars consumed by the engine during this advance. */
  bars: ReplayBar[]
  /** False when the advance seeked instead of walking (nothing could fill), so `bars` is
   * empty by design rather than because the span held none. */
  walked: boolean
  /** What the observer raised on the bar a `watch` stop landed on. Empty for any other
   * reason. */
  observed: ObserverStop[]
}

/** Something an observer raised on a bar that is worth stopping an advance for -- a price
 * watch firing. Only what the controls need to say why the advance stopped. */
export interface ObserverStop {
  label: string
}

/** Something that wants to see the walk as it happens.
 *
 * The engine is not the only consumer of a base bar: a price watch placed on a replay wall
 * is answered by the same bars, at the same granularity, in the same order
 * (`client/replay/watches.ts`). This is the whole of that seam — the session knows there is
 * an observer, and nothing about what it does with a bar. */
export interface ReplayObserver {
  /** True when an advance must WALK base bars even though the account cannot change. An
   * armed watch is such a reason: without this the seek shortcut would step over the whole
   * span it was placed to see. */
  needsBars(): boolean
  /** How many armed things could stop a "next signal" run -- what lets that button work with
   * no signal armed. */
  armedStops(): number
  /** One base bar the engine has just consumed, in walk order. Always the BASE bar, never a
   * refinement's finer parts: whether an order happens to be resting must not change what an
   * observer sees. Returns what it raised on this bar; the advance (Step or "next signal")
   * stops on any. */
  onBar(bar: ReplayBar): ObserverStop[]
  /** The cursor moved without a walk — nothing between was examined. */
  seeked(): void
  /** Whatever this observer keeps in the replay's state blob. */
  toState(): LocalWatchState[]
}

export interface ReplayController {
  readonly cursor: number
  readonly base: string
  readonly advance: AdvanceSetting
  readonly pauseOnFill: boolean
  readonly busy: boolean
  readonly lastStop: AdvanceResult | null
  readonly signals: SignalBook
  /** Armed stops besides the signals (price watches): "next signal" stops at those too. */
  readonly armedStops: number
  readonly storedIntervals: readonly string[]
  readonly intervalsInUse: readonly string[]
  readonly symbol: string
  setBase(base: string): BaseCheck
  setAdvance(setting: AdvanceSetting): void
  setPauseOnFill(on: boolean): void
  /** Advance by the current advance setting. */
  step(): Promise<AdvanceResult | null>
  advanceBy(request: AdvanceRequest): Promise<AdvanceResult | null>
  /** Advance to the next armed signal or firing price watch (to the end of the data if
   * neither). */
  nextSignal(): Promise<AdvanceResult | null>
  /** Ask the running advance to stop at its next natural place. No-op when idle. */
  cancel(): void
  /** A cancel has been asked for and the advance has not stopped yet. */
  readonly cancelling: boolean
  onControlChange(listener: () => void): () => void
  /** Persist now (a star/arm change). */
  persist(): void
}

export interface ReplaySessionOptions {
  id: string
  name: string
  createdAt: number
  vendor: string
  /** The engine's instrument key, `vendor:TICKER`. */
  symbol: string
  cursor: number
  startedAt: number
  base: string
  advance: AdvanceSetting
  pauseOnFill: boolean
  storedIntervals: readonly string[]
  engine: Engine
  signals: SignalBook
  barSource: BarSource
  /** The end of the available data: what "next signal" advances to at most. */
  dataEnd: () => number
  save: (state: ReplayState) => Promise<void>
  onAdvanced: (result: AdvanceResult) => Promise<void> | void
  /** Fed every base bar the walk consumes, and asked whether the walk is needed at all. */
  observer?: ReplayObserver
}

export class ReplayTradingSession implements TradingSession, ReplayController {
  readonly mode = 'replay' as const
  readonly ready = true
  snapshot: SimSnapshot
  cursor: number
  base: string
  advance: AdvanceSetting
  pauseOnFill: boolean
  busy = false
  lastStop: AdvanceResult | null = null
  intervalsInUse: string[] = []
  readonly signals: SignalBook
  readonly storedIntervals: readonly string[]
  readonly symbol: string
  private readonly engine: Engine
  private readonly listeners = new Set<SessionListener>()
  private readonly controlListeners = new Set<() => void>()
  private baseCache: BarCache
  private readonly refinements = new Map<string, BarCache>()
  private rev = 0
  private saveChain: Promise<void> = Promise.resolve()
  private disposed = false
  private cancelRequested = false

  constructor(private readonly opts: ReplaySessionOptions) {
    this.symbol = opts.symbol
    this.cursor = opts.cursor
    this.base = opts.base
    this.advance = { ...opts.advance }
    this.pauseOnFill = opts.pauseOnFill
    this.storedIntervals = opts.storedIntervals
    this.engine = opts.engine
    this.signals = opts.signals
    this.baseCache = new BarCache(opts.barSource, opts.symbol, opts.base, 'all')
    this.baseCache.seek(this.cursor)
    this.snapshot = this.buildSnapshot()
  }

  // -- TradingSession ----------------------------------------------------------------------

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async watch(_instrument: string): Promise<void> {
    // The replay's instruments are quoted from stored bars as the cursor moves; nothing to
    // watch. Another instrument's orders would need its own base walk -- not offered.
  }

  async placeOrder(order: OrderRequest): Promise<void> {
    this.act(() => {
      const { events } = this.engine.submit({
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        units: order.units,
        price: order.price,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        label: order.label
      })
      return events
    })
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.act(() => [this.engine.cancel(orderId)])
  }

  async modifyOrder(orderId: string, patch: OrderPatch): Promise<void> {
    this.act(() => {
      this.engine.modifyOrder(orderId, { price: patch.price, stopLoss: patch.stopLoss, takeProfit: patch.takeProfit })
      return []
    })
  }

  async modifyTrade(tradeId: string, patch: TradePatch): Promise<void> {
    this.act(() => {
      this.engine.modifyTrade(tradeId, { stopLoss: patch.stopLoss, takeProfit: patch.takeProfit })
      return []
    })
  }

  async closeTrade(tradeId: string, units?: number): Promise<void> {
    this.act(() => this.engine.closeTrade(tradeId, units))
  }

  async flatten(symbol?: string): Promise<void> {
    this.act(() => this.engine.flatten(symbol))
  }

  /** Run an engine request; a refusal surfaces as the same error shape the paper session's
   * server would answer with (the panel shows `message`). */
  private act(fn: () => SimEvent[]): void {
    let events: SimEvent[]
    try {
      events = fn()
    } catch (err) {
      if (err instanceof SimError) throw new ReplayRequestError(err.message)
      throw err
    }
    this.touched(events)
  }

  private touched(events: SimEvent[]): void {
    this.rev++
    this.snapshot = this.buildSnapshot()
    for (const listener of [...this.listeners]) {
      try {
        listener(this.snapshot, events)
      } catch (err) {
        console.error('[replay] session listener failed', err)
      }
    }
    this.persist()
  }

  private buildSnapshot(): SimSnapshot {
    const e = this.engine
    const quotes: SimSnapshot['quotes'] = {}
    for (const [k, q] of e.quotes) quotes[k] = { time: q.time, bid: q.bid, ask: q.ask }
    return {
      id: this.opts.id,
      mode: 'replay',
      name: this.opts.name,
      createdAt: this.opts.createdAt,
      rev: this.rev,
      account: {
        currency: e.currency,
        initialBalance: e.initialBalance,
        balance: e.balance,
        unrealizedPnl: e.unrealizedPnl(),
        equity: e.equity()
      },
      quotes,
      orders: [...e.orders.values()].map((o) => ({ ...o })),
      trades: [...e.trades.values()].map((t) => ({ ...t })),
      symbols: [...new Set([this.symbol, ...e.quotes.keys()])].sort()
    }
  }

  // -- persistence -------------------------------------------------------------------------

  toState(): ReplayState {
    return serialize({
      vendor: this.opts.vendor,
      symbol: this.symbol,
      cursor: this.cursor,
      startedAt: this.opts.startedAt,
      base: this.base,
      advance: this.advance,
      pauseOnFill: this.pauseOnFill,
      starred: this.signals.starred,
      armed: this.signals.armed,
      watches: this.opts.observer?.toState() ?? [],
      engine: this.engine.toState()
    })
  }

  /** Resolve once every queued save has landed (tests, teardown). */
  flushSaves(): Promise<void> {
    return this.saveChain
  }

  persist(): void {
    if (this.disposed) return
    // A star/arm change is persisted through here and must also re-render the strip.
    this.controlsChanged()
    const state = this.toState()
    // Serialized: saves carry an optimistic rev, so two in flight would conflict.
    this.saveChain = this.saveChain.then(() => this.opts.save(state)).catch((err) => console.warn('[replay] save failed', err))
  }

  /** The last base bar that closed at or before `at`. Widens the probe when the window is
   * empty -- a cursor just after a weekend has no bars a few minutes behind it.
   *
   * Public because it is also how an observer gets a reading for an instant the walk never
   * passed through: a watch armed before the first step has to be seeded from the bar the
   * cursor is standing on, and this is the one place that knows how to find it. */
  async barAt(at: number): Promise<ReplayBar | null> {
    let span = QUOTE_PROBE_BARS * nominalMs(this.base)
    for (let attempt = 0; attempt < 5; attempt++, span *= 8) {
      const probe = new BarCache(this.opts.barSource, this.symbol, this.base, 'all')
      probe.seek(at - span)
      await probe.ensure(at)
      const last = probe
        .slice(at - span, at)
        .filter((b) => b.end <= at)
        .at(-1)
      if (last) return last
    }
    return null
  }

  /** Feed the engine the closing quote at `at`. Primes the ticket before the first step, and
   * lands a seek (an advance that consumed no bars) on a real price. */
  private async quoteAt(at: number): Promise<boolean> {
    const last = await this.barAt(at)
    if (!last) return false
    const bar = toBidAsk(last, this.symbol)
    this.engine.onQuote({ symbol: this.symbol, time: at, bid: bar.bidClose, ask: bar.askClose })
    return true
  }

  /** Before the first step the engine has no quote: take the base bar closing at the cursor
   * (the last one the cursor has passed) so the ticket prices at once. */
  async primeQuote(): Promise<void> {
    if (this.engine.quotes.has(this.symbol)) return
    if (!(await this.quoteAt(this.cursor))) return
    this.snapshot = this.buildSnapshot()
    for (const listener of [...this.listeners]) listener(this.snapshot, [])
  }

  // -- ReplayController ----------------------------------------------------------------------

  onControlChange(listener: () => void): () => void {
    this.controlListeners.add(listener)
    return () => {
      this.controlListeners.delete(listener)
    }
  }

  private controlsChanged(): void {
    for (const l of [...this.controlListeners]) {
      try {
        l()
      } catch (err) {
        console.error('[replay] control listener failed', err)
      }
    }
  }

  get armedStops(): number {
    return this.opts.observer?.armedStops() ?? 0
  }

  setIntervalsInUse(list: readonly string[]): BaseCheck {
    this.intervalsInUse = [...new Set(list)]
    const check = validateBase(this.base, this.intervalsInUse, this.storedIntervals)
    this.controlsChanged()
    return check
  }

  setBase(base: string): BaseCheck {
    const check = validateBase(base, this.intervalsInUse, this.storedIntervals)
    if (!check.ok || this.busy) return check.ok ? { ok: false, reason: 'busy' } : check
    if (base !== this.base) {
      this.base = base
      // A new base is a new walk: the old run is meaningless at another granularity.
      this.baseCache = new BarCache(this.opts.barSource, this.symbol, base, 'all')
      this.baseCache.seek(this.cursor)
      this.persist()
    }
    this.controlsChanged()
    return check
  }

  setAdvance(setting: AdvanceSetting): void {
    this.advance = { interval: setting.interval, multiple: Math.max(1, Math.floor(setting.multiple)) }
    this.persist()
    this.controlsChanged()
  }

  setPauseOnFill(on: boolean): void {
    this.pauseOnFill = on
    this.persist()
    this.controlsChanged()
  }

  step(): Promise<AdvanceResult | null> {
    return this.advanceBy({ interval: this.advance.interval, multiple: this.advance.multiple })
  }

  /** An advance to the end of the data that stops at the first armed signal -- or, like any
   * advance, at the first bar an observer raises something on (a price watch firing). */
  nextSignal(): Promise<AdvanceResult | null> {
    return this.advanceBy({ toEnd: true, end: this.opts.dataEnd() })
  }

  /** Ask the running advance to stop at its next natural place: before the next base bar it
   * would consume, or -- asked while the advance is still planning -- before it moves at all.
   * Whole base bars only, so the engine and the watches never see a bar half-walked, and the
   * cursor lands on a bar's close exactly as a fill pause leaves it. A seek (nothing could
   * fill, nothing watched) is one read and is not interrupted. */
  cancel(): void {
    if (!this.busy || this.cancelRequested) return
    this.cancelRequested = true
    this.controlsChanged()
  }

  get cancelling(): boolean {
    return this.cancelRequested
  }

  async advanceBy(request: AdvanceRequest): Promise<AdvanceResult | null> {
    if (this.busy || this.disposed) return null
    this.busy = true
    this.cancelRequested = false
    this.controlsChanged()
    const from = this.cursor
    try {
      const provisional = planAdvance(from, request, [])
      const end = Math.min(provisional.target, this.opts.dataEnd())
      const occurrences = await this.signals.nextSignalsAt(this.symbol, from, end)
      const plan = planAdvance(from, { toEnd: true, end }, occurrences)
      let reason: StopReason = plan.reason === 'signal' ? 'signal' : 'toEnd' in request || end < provisional.target ? 'end' : 'target'
      const stopAt = plan.stopAt
      const events: SimEvent[] = []
      const consumed: ReplayBar[] = []
      let observed: ObserverStop[] = []
      let paused = false
      // Asked while the signals were being looked up: stop before moving at all.
      let cancelled = this.cancelRequested
      // Walk the base bars only when one of them could actually do something. With nothing
      // resting and nothing protected the account cannot change however the price moves, so
      // the advance SEEKS: the cursor lands on the same instant, the engine takes the closing
      // quote there, and a months-long jump costs one read instead of a hundred thousand bars.
      // ...or when an observer needs the bars. A watch armed on this wall is answered by the
      // walk, so it is as good a reason to walk as a resting order is: seeking past the span
      // would step over the very move it was placed to see.
      const walked =
        canFill([...this.engine.orders.values()], [...this.engine.trades.values()], this.symbol) ||
        (this.opts.observer?.needsBars() ?? false)
      if (cancelled) {
        // Neither walk nor seek: the cursor stays where it was.
      } else if (walked) {
        const chunk = WALK_CHUNK_BARS * nominalMs(this.base)
        let reach = this.cursor
        let sliceStart = performance.now()
        walk: for (;;) {
          // One page of the span at a time (WALK_CHUNK_BARS). `reach` moves on by a whole
          // chunk even when the chunk held no bar -- a weekend, a gap in the store -- so the
          // walk always ends, at `stopAt`.
          reach = Math.min(stopAt, Math.max(reach, this.cursor) + chunk)
          await this.baseCache.ensure(reach, this.cursor)
          for (;;) {
            const bar = this.baseCache.peek()
            if (!bar || bar.end > reach) break
            // The natural place to stop: between two whole base bars.
            if (this.cancelRequested) {
              cancelled = true
              break walk
            }
            this.baseCache.take(bar.end)
            consumed.push(bar)
            const produced = await this.consume(bar, this.base)
            events.push(...produced)
            // After the engine, so anything an observer raises sees the account as this bar
            // left it -- and the BASE bar, not the refinement's parts.
            const raised = this.opts.observer?.onBar(bar) ?? []
            this.cursor = bar.end
            if (this.pauseOnFill && produced.some((e) => e.kind === 'fill' || e.kind === 'close')) {
              paused = true
              break walk
            }
            // A firing watch ends ANY advance, a Step as much as "next signal": it is the move
            // the watch was placed to catch, and walking on past it would put the cursor, and
            // every pane, somewhere other than where it happened.
            if (raised.length > 0) {
              observed = raised
              break walk
            }
            if (performance.now() - sliceStart > WALK_YIELD_MS) {
              await nextTask()
              sliceStart = performance.now()
            }
          }
          if (reach >= stopAt) break
          if (this.cancelRequested) {
            cancelled = true
            break
          }
        }
      } else {
        this.baseCache.seek(stopAt)
        await this.quoteAt(stopAt)
        this.opts.observer?.seeked()
      }
      if (paused) reason = 'fill'
      else if (cancelled) reason = 'cancel'
      else if (observed.length === 0) this.cursor = stopAt
      // A watch firing on the very bar the advance was going to stop at anyway leaves a signal
      // stop a signal stop: that is the one the user armed the run for, and the watch has its
      // own row in the Notification Center. Against `target` or `end` it is the more useful
      // answer.
      else if (!(this.cursor === stopAt && reason === 'signal')) reason = 'watch'
      if (reason !== 'watch') observed = []
      const result: AdvanceResult = { from, to: this.cursor, reason, signal: reason === 'signal' ? plan.signal : null, events, bars: consumed, walked, observed }
      this.lastStop = result
      this.rev++
      this.snapshot = this.buildSnapshot()
      for (const listener of [...this.listeners]) {
        try {
          listener(this.snapshot, events)
        } catch (err) {
          console.error('[replay] session listener failed', err)
        }
      }
      // A cancel that landed before anything moved changed nothing the chart shows; telling it
      // the clock moved would only make every plugin forget and refetch its forming bar.
      if (!(cancelled && this.cursor === from)) await this.opts.onAdvanced(result)
      this.persist()
      return result
    } finally {
      this.busy = false
      this.cancelRequested = false
      this.controlsChanged()
    }
  }

  /** Feed one bar of `interval` to the engine -- or, when it can interact with something
   * working, the finer stored bars inside it instead (recursively, down to the finest
   * stored). Refinement changes which bars the engine sees, never where the cursor lands. */
  private async consume(bar: ReplayBar, interval: string): Promise<SimEvent[]> {
    const orders = [...this.engine.orders.values()]
    const trades = [...this.engine.trades.values()]
    if (!canFill(orders, trades, this.symbol)) return this.engine.onBar(toBidAsk(bar, this.symbol))
    const band = bar.bid && bar.ask ? { bidLow: bar.bid.l, bidHigh: bar.bid.h, askLow: bar.ask.l, askHigh: bar.ask.h } : { bidLow: bar.l, bidHigh: bar.h, askLow: bar.l, askHigh: bar.h }
    if (!intersectsWorking(band, orders, trades, this.symbol)) return this.engine.onBar(toBidAsk(bar, this.symbol))
    const finer = finerStored(interval, this.storedIntervals)
    const next = finer.at(-1)
    if (next === undefined) return this.engine.onBar(toBidAsk(bar, this.symbol))
    const cache = this.refinement(next)
    cache.seek(bar.open)
    await cache.ensure(bar.end)
    const parts = cache.take(bar.end).filter((p) => p.open >= bar.open && p.end <= bar.end)
    if (parts.length === 0) return this.engine.onBar(toBidAsk(bar, this.symbol))
    const events: SimEvent[] = []
    for (const part of parts) events.push(...(await this.consume(part, next)))
    return events
  }

  private refinement(interval: string): BarCache {
    let c = this.refinements.get(interval)
    if (!c) {
      c = new BarCache(this.opts.barSource, this.symbol, interval, 'all')
      this.refinements.set(interval, c)
    }
    return c
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.controlListeners.clear()
    this.baseCache.dump()
    for (const c of this.refinements.values()) c.dump()
  }
}

/** Hand the event loop back for one turn, so a click, a paint or a due timer can run.
 *
 * NOT `setTimeout(0)`: a hidden tab clamps chained timers to about a second each (measured in
 * this project's Chrome: ten chained zero-delay timers took 3.1 s, while ten MessageChannel
 * turns took 2 ms), so a walk left running behind another tab would yield once a second and
 * crawl. `scheduler.yield()` is built for exactly this and lets input through; a MessageChannel
 * turn is the fallback where it does not exist -- neither is throttled in a hidden tab. */
function nextTask(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (typeof scheduler?.yield === 'function') return scheduler.yield()
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

/** An engine refusal, as the server's `invalid_request` would arrive (the panel shows an
 * `OhlcvApiError`'s message and a generic line for anything else). */
export class ReplayRequestError extends OhlcvApiError {
  constructor(message: string) {
    super(400, 'invalid_request', message)
    this.name = 'ReplayRequestError'
  }
}

export function toBidAsk(bar: ReplayBar, symbol: string): BidAskBar {
  const bid = bar.bid ?? { o: bar.o, h: bar.h, l: bar.l, c: bar.c }
  const ask = bar.ask ?? { o: bar.o, h: bar.h, l: bar.l, c: bar.c }
  return {
    symbol,
    time: bar.open,
    end: bar.end,
    bidOpen: bid.o,
    bidHigh: bid.h,
    bidLow: bid.l,
    bidClose: bid.c,
    askOpen: ask.o,
    askHigh: ask.h,
    askLow: ask.l,
    askClose: ask.c
  }
}

export type { SimAnswer }
