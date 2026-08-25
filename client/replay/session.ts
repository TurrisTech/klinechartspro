import type { OrderPatch, OrderRequest, SimAnswer, SimEvent, SimSnapshot, TradePatch } from '../trading/api'
import type { SessionListener, TradingSession } from '../trading/session'
import { BarCache, type BarSource, type ReplayBar } from './cache'
import { type AdvanceRequest, type SignalOccurrence, type StopReason, hasWorking, intersectsWorking, planAdvance } from './clock'
import { type BidAskBar, type Engine, SimError } from './engine'
import { type AdvanceSetting, type ReplayState, serialize } from './persist'
import type { SignalBook } from './signals'
import { type BaseCheck, finerStored, validateBase } from './timeframes'

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
}

export interface ReplayController {
  readonly cursor: number
  readonly base: string
  readonly advance: AdvanceSetting
  readonly pauseOnFill: boolean
  readonly busy: boolean
  readonly lastStop: AdvanceResult | null
  readonly signals: SignalBook
  readonly storedIntervals: readonly string[]
  readonly intervalsInUse: readonly string[]
  readonly symbol: string
  setBase(base: string): BaseCheck
  setAdvance(setting: AdvanceSetting): void
  setPauseOnFill(on: boolean): void
  /** Advance by the current advance setting. */
  step(): Promise<AdvanceResult | null>
  advanceBy(request: AdvanceRequest): Promise<AdvanceResult | null>
  /** Advance to the next armed signal (to the end of the data if none). */
  nextSignal(): Promise<AdvanceResult | null>
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
      engine: this.engine.toState()
    })
  }

  /** Resolve once every queued save has landed (tests, teardown). */
  flushSaves(): Promise<void> {
    return this.saveChain
  }

  persist(): void {
    if (this.disposed) return
    const state = this.toState()
    // Serialized: saves carry an optimistic rev, so two in flight would conflict.
    this.saveChain = this.saveChain.then(() => this.opts.save(state)).catch((err) => console.warn('[replay] save failed', err))
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

  nextSignal(): Promise<AdvanceResult | null> {
    return this.advanceBy({ toEnd: true, end: this.opts.dataEnd() })
  }

  async advanceBy(request: AdvanceRequest): Promise<AdvanceResult | null> {
    if (this.busy || this.disposed) return null
    this.busy = true
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
      let paused = false
      for (;;) {
        await this.baseCache.ensure(stopAt, this.cursor)
        const bar = this.baseCache.peek()
        if (!bar || bar.end > stopAt) break
        this.baseCache.take(bar.end)
        consumed.push(bar)
        const produced = await this.consume(bar, this.base)
        events.push(...produced)
        this.cursor = bar.end
        if (this.pauseOnFill && produced.some((e) => e.kind === 'fill' || e.kind === 'close')) {
          paused = true
          break
        }
      }
      if (paused) reason = 'fill'
      else this.cursor = stopAt
      const result: AdvanceResult = { from, to: this.cursor, reason, signal: reason === 'signal' ? plan.signal : null, events, bars: consumed }
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
      await this.opts.onAdvanced(result)
      this.persist()
      return result
    } finally {
      this.busy = false
      this.controlsChanged()
    }
  }

  /** Feed one bar of `interval` to the engine -- or, when it can interact with something
   * working, the finer stored bars inside it instead (recursively, down to the finest
   * stored). Refinement changes which bars the engine sees, never where the cursor lands. */
  private async consume(bar: ReplayBar, interval: string): Promise<SimEvent[]> {
    const orders = [...this.engine.orders.values()]
    const trades = [...this.engine.trades.values()]
    if (!hasWorking(orders, trades, this.symbol)) return this.engine.onBar(toBidAsk(bar, this.symbol))
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

/** An engine refusal, shaped like the server's `invalid_request` so the panel's error path
 * (which reads `message`) shows it. */
export class ReplayRequestError extends Error {
  readonly status = 400
  readonly code = 'invalid_request'
  constructor(message: string) {
    super(message)
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
