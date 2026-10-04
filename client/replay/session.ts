import { OhlcvApiError } from '../config'
import type { LocalWatchState } from '../watch/local'
import type { OrderPatch, OrderRequest, SimAnswer, SimEvent, SimSnapshot, TradePatch } from '../trading/api'
import type { SessionListener, TradingSession } from '../trading/session'
import { BarCache, type BarSource, type ReplayBar } from './cache'
import type { ReplayAlertBook } from './alerts'
import { type AdvanceRequest, type AlertOccurrence, type StopReason, canFill, intersectsWorking, planAdvance, targetOf } from './clock'
import { type BidAskBar, type Engine, SimError } from './engine'
import { type AdvanceSetting, type ReplayState, serialize } from './persist'
import { type BaseCheck, type CandleGrid, finerStored, nominalMs, validateBase } from './timeframes'

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

/** Least time between two reports of how far a walk has got, in ms. Four a second is as fast as
 * anyone reads a date; a report at every yield (WALK_YIELD_MS) would be twenty. */
export const WALK_PROGRESS_MS = 250

// GLUE. `ReplayTradingSession` implements `TradingSession` (the seam the whole trading UI
// acts through) over the client-side engine and the bar caches, and is the
// `ReplayController` the control strip drives. It owns the clock: nothing else moves the
// cursor, and every read the chart makes is clamped to it (by the caller, through
// config.ts's read clock, in `onAdvanced`).

export interface AdvanceResult {
  from: number
  to: number
  /** What was asked for: a Step's `interval` × `multiple`, or Next alert's run to the end. */
  request: AdvanceRequest
  reason: StopReason
  /** The alert a Next alert run stopped at; null for any other reason. */
  alert: AlertOccurrence | null
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
  /** How many armed things could stop a Next alert run besides the alerts -- what lets that
   * button work with only price watches armed. */
  armedStops(): number
  /** One base bar the engine has just consumed, in walk order. Always the BASE bar, never a
   * refinement's finer parts: whether an order happens to be resting must not change what an
   * observer sees. Returns what it raised on this bar; the advance (Step or Next alert) stops
   * on any. */
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
  /** Where the running advance started; null when idle. It is what the chart shows until the
   * advance lands: during a walk `cursor` moves bar by bar, far ahead of the panes, so the
   * title bar's clock reads this instead. */
  readonly advanceFrom: number | null
  /** How far the running advance's walk has got: the close of the last whole base bar it
   * consumed, which is also the earliest a Stop could leave the cursor. Null when idle, and
   * throughout an advance that seeks. The walk's reach, NOT the chart's position -- nothing is
   * drawn there until the advance stops. Reported at most every WALK_PROGRESS_MS. */
  readonly walkedTo: number | null
  /** How far a Next alert search has looked ahead: the bar closes it has checked, NOT the
   * chart's position -- nothing moves until it finds one. Null when no search is running.
   * Reported with the walk's progress (`'walk'` change). */
  readonly searchedTo: number | null
  readonly lastStop: AdvanceResult | null
  /** The client alerts Next alert can stop at (enabled, on this instrument). */
  readonly alertCount: number
  /** Armed stops besides the alerts (price watches): Next alert stops at those too. */
  readonly armedStops: number
  readonly storedIntervals: readonly string[]
  readonly intervalsInUse: readonly string[]
  readonly symbol: string
  /** The instrument's candle schedule: where its candles open and close, and the zone its
   * clock reads in (the controls show the cursor on it, as its chart does). */
  readonly grid: CandleGrid
  /** Where the session started, and its account as of now -- what the Results panel scores. */
  readonly startedAt: number
  readonly snapshot: SimSnapshot
  /** Every change to the account (an advance, an order, a close). */
  subscribe(listener: SessionListener): () => void
  setBase(base: string): BaseCheck
  setAdvance(setting: AdvanceSetting): void
  setPauseOnFill(on: boolean): void
  /** Advance by the current advance setting. */
  step(): Promise<AdvanceResult | null>
  advanceBy(request: AdvanceRequest): Promise<AdvanceResult | null>
  /** Advance to where the next enabled alert triggers -- stopping sooner for a firing price
   * watch or a fill pause, as every advance does. Does not move when nothing would stop it. */
  nextAlert(): Promise<AdvanceResult | null>
  /** Ask the running advance to stop at its next natural place. No-op when idle. */
  cancel(): void
  /** A cancel has been asked for and the advance has not stopped yet. */
  readonly cancelling: boolean
  /** `listener` runs on every change the controls should show. `'walk'` says only `walkedTo`
   * moved -- a progress report, several a second through a long walk -- so a listener can
   * update that one line instead of rebuilding everything, the Stop button included. */
  onControlChange(listener: (change?: 'walk') => void): () => void
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
  /** That instrument's candle schedule, from its resolved market hours. Every step, every
   * floor and every bar the session reads is on it. */
  grid: CandleGrid
  cursor: number
  startedAt: number
  base: string
  advance: AdvanceSetting
  pauseOnFill: boolean
  storedIntervals: readonly string[]
  engine: Engine
  barSource: BarSource
  /** The end of the available data: what Next alert advances to at most. */
  dataEnd: () => number
  save: (state: ReplayState) => Promise<void>
  onAdvanced: (result: AdvanceResult) => Promise<void> | void
  /** Fed every base bar the walk consumes, and asked whether the walk is needed at all. */
  observer?: ReplayObserver
  /** Where the client alerts next trigger: what Next alert runs to. */
  alerts?: ReplayAlertBook
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
  advanceFrom: number | null = null
  walkedTo: number | null = null
  searchedTo: number | null = null
  lastStop: AdvanceResult | null = null
  intervalsInUse: string[] = []
  readonly storedIntervals: readonly string[]
  readonly symbol: string
  readonly grid: CandleGrid
  readonly startedAt: number
  private readonly engine: Engine
  private readonly listeners = new Set<SessionListener>()
  private readonly controlListeners = new Set<(change?: 'walk') => void>()
  private baseCache: BarCache
  private readonly refinements = new Map<string, BarCache>()
  private rev = 0
  private saveChain: Promise<void> = Promise.resolve()
  private disposed = false
  private cancelRequested = false

  constructor(private readonly opts: ReplaySessionOptions) {
    this.symbol = opts.symbol
    this.grid = opts.grid
    this.startedAt = opts.startedAt
    this.cursor = opts.cursor
    this.base = opts.base
    this.advance = { ...opts.advance }
    this.pauseOnFill = opts.pauseOnFill
    this.storedIntervals = opts.storedIntervals
    this.engine = opts.engine
    this.baseCache = new BarCache(opts.barSource, opts.symbol, opts.base, opts.grid, 'all')
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
      startedAt: this.startedAt,
      base: this.base,
      advance: this.advance,
      pauseOnFill: this.pauseOnFill,
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
    // A watch placed or removed is persisted through here and must also re-render the controls
    // (it is what enables Next alert with no alert).
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
      const probe = new BarCache(this.opts.barSource, this.symbol, this.base, this.grid, 'all')
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

  onControlChange(listener: (change?: 'walk') => void): () => void {
    this.controlListeners.add(listener)
    return () => {
      this.controlListeners.delete(listener)
    }
  }

  private controlsChanged(change?: 'walk'): void {
    for (const l of [...this.controlListeners]) {
      try {
        l(change)
      } catch (err) {
        console.error('[replay] control listener failed', err)
      }
    }
  }

  get armedStops(): number {
    return this.opts.observer?.armedStops() ?? 0
  }

  get alertCount(): number {
    return this.opts.alerts?.count() ?? 0
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
      this.baseCache = new BarCache(this.opts.barSource, this.symbol, base, this.grid, 'all')
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

  /** Advance to where the next enabled alert triggers. Like any advance it stops sooner at a
   * fill pause or a firing price watch; and with no alert ahead it still runs to the end of the
   * data when a price watch is armed (that is the run the watch was placed for). With neither
   * there is nowhere to go, and the cursor stays where it is: a replay cannot step back, so
   * running to the end of the data on a search that found nothing would cost the whole
   * session. */
  nextAlert(): Promise<AdvanceResult | null> {
    return this.advanceBy({ toEnd: true, end: this.opts.dataEnd() }, { alerts: true })
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

  async advanceBy(request: AdvanceRequest, options: { alerts?: boolean } = {}): Promise<AdvanceResult | null> {
    if (this.busy || this.disposed) return null
    this.busy = true
    this.cancelRequested = false
    const from = this.cursor
    this.advanceFrom = from
    this.controlsChanged()
    try {
      const target = targetOf(from, request, this.grid)
      const end = Math.min(target, this.opts.dataEnd())
      const alert = options.alerts ? await this.findAlert(from, end) : null
      const plan = planAdvance(from, { toEnd: true, end }, this.grid, alert)
      let reason: StopReason = plan.reason === 'alert' ? 'alert' : 'toEnd' in request || end < target ? 'end' : 'target'
      const stopAt = plan.stopAt
      const events: SimEvent[] = []
      const consumed: ReplayBar[] = []
      let observed: ObserverStop[] = []
      let paused = false
      // Asked while the alerts were being searched: stop before moving at all.
      let cancelled = this.cancelRequested
      // Next alert found nothing, and no price watch could stop the run either: nowhere to go.
      const nowhere = options.alerts === true && plan.reason !== 'alert' && !cancelled && this.armedStops === 0
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
      if (cancelled || nowhere) {
        // Neither walk nor seek: the cursor stays where it was.
      } else if (walked) {
        const chunk = WALK_CHUNK_BARS * nominalMs(this.base)
        let reach = this.cursor
        let sliceStart = performance.now()
        // Tell the controls how far the walk has got, or a months-long walk shows a frozen
        // chart and a Stop button and cannot be told from a hung one. The cursor, not `reach`:
        // a chunk is fetched ahead of the bars in it, and the date shown must never be past
        // where a Stop would leave the cursor. Throttled, and skipped when nothing moved.
        let reportedAt = Number.NEGATIVE_INFINITY
        const report = (): void => {
          const now = performance.now()
          if (this.walkedTo === this.cursor || now - reportedAt < WALK_PROGRESS_MS) return
          this.walkedTo = this.cursor
          reportedAt = now
          this.controlsChanged('walk')
        }
        walk: for (;;) {
          // Before the page downloads: that wait is the likeliest to look like a hang.
          report()
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
            // A firing watch ends ANY advance, a Step as much as Next alert: it is the move
            // the watch was placed to catch, and walking on past it would put the cursor, and
            // every pane, somewhere other than where it happened.
            if (raised.length > 0) {
              observed = raised
              break walk
            }
            if (performance.now() - sliceStart > WALK_YIELD_MS) {
              report()
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
      // The walk is over, however it ended: from here the controls say why it stopped.
      this.walkedTo = null
      if (paused) reason = 'fill'
      else if (cancelled) reason = 'cancel'
      else if (nowhere) reason = 'none'
      else if (observed.length === 0) this.cursor = stopAt
      // A watch firing on the very bar the advance was going to stop at anyway leaves an alert
      // stop an alert stop: that is the one the user ran for, and the watch has its own row in
      // the Notification Center. Against `target` or `end` it is the more useful answer.
      else if (!(this.cursor === stopAt && reason === 'alert')) reason = 'watch'
      if (reason !== 'watch') observed = []
      const result: AdvanceResult = { from, to: this.cursor, request, reason, alert: reason === 'alert' ? plan.alert : null, events, bars: consumed, walked, observed }
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
      // An advance that did not move (a cancel before the first bar, a Next alert with nowhere
      // to go) changed nothing the chart shows; telling it the clock moved would only make every
      // plugin forget and refetch its forming bar.
      if (this.cursor !== from) await this.opts.onAdvanced(result)
      this.persist()
      return result
    } finally {
      this.busy = false
      this.cancelRequested = false
      this.advanceFrom = null
      this.walkedTo = null
      this.searchedTo = null
      this.controlsChanged()
    }
  }

  /** The alert Next alert runs to, searched ahead of the cursor. A Stop press is heard between
   * the search's chunks, and its progress is reported the way a walk's is. */
  private async findAlert(from: number, end: number): Promise<AlertOccurrence | null> {
    const book = this.opts.alerts
    if (!book || book.count() === 0) return null
    let reportedAt = Number.NEGATIVE_INFINITY
    try {
      return await book.next(from, end, {
        shouldStop: () => this.cancelRequested || this.disposed,
        onProgress: (reached) => {
          const now = performance.now()
          if (now - reportedAt < WALK_PROGRESS_MS) return
          reportedAt = now
          this.searchedTo = reached
          this.controlsChanged('walk')
        }
      })
    } catch (err) {
      console.error('[replay] the alert search failed', err)
      return null
    } finally {
      this.searchedTo = null
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
      c = new BarCache(this.opts.barSource, this.symbol, interval, this.grid, 'all')
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
