import type {
  BreakevenRequest,
  ManagementPatch,
  MilestoneRequest,
  SimBreakeven,
  SimEvent,
  SimMilestone,
  SimOrder,
  SimOrderType,
  SimSide,
  SimTrade,
  SimTrailingStop,
  TrailRequest
} from '../trading/api'

// PURE. The TypeScript port of wdashboard-server's fill engine (wdashboard_server/sim/
// engine.py), which is the specification: same types, same events, same ids, no I/O.
// Parity is enforced by `engine.test.ts`, which runs the SAME case file the Python suite
// runs (`fixtures/engine_cases.json`, vendored by scripts/sync-engine-fixtures.sh) -- a
// divergence in the rules fails a test in both repos.
//
// The model is OANDA's (see engine.py's docstring for the full statement):
// - a market order fills now: a buy at the ask, a sell at the bid;
// - a limit rests and fills at its price or better (the better open on a gap-through);
// - a stop rests and becomes a market order: at the trigger, or the worse open on a gap;
// - every fill opens an independent trade (hedging; a position is derived);
// - a long closes on the bid, a short on the ask; SL/TP evaluate on the closing side and
//   fill at their price, except across a gap (SL at the worse open, TP at the better open);
// - one bar reaching both SL and TP takes the stop (conservative);
// - P&L in the quote currency; balance = sum of realized P&L.
//
// EXIT MANAGEMENT (engine.py's docstring, 2026-11-15) rides on an order and is carried to its
// trade: a TRAILING STOP moves the trade's one stop loss behind the best closing-side price, from
// the fill or once `activation` in profit, by at least `step`, only ever tighter and only on new
// ground; an AUTO-BREAKEVEN moves it to the entry plus `offset` the first time the closing side is
// `trigger` in profit; a MILESTONE (a signed distance from the entry) emits a `milestone` event
// the first time a price reaches it. All three are judged on a price the trade survived: a quote,
// a bar's CLOSE for the trail and breakeven, and a bar's range for a milestone on a trade open
// before the bar. Thresholds and stop/target hits compare within one part in 1e9 of the price.

export type CloseReason = 'manual' | 'stop_loss' | 'take_profit' | 'flatten'

/** At most this many milestones on an order or trade, and a label at most this long. */
export const MAX_MILESTONES = 12
export const MAX_MILESTONE_LABEL = 24
const REL_TOL = 1e-9

function tolerance(price: number): number {
  return REL_TOL * Math.max(1, Math.abs(price))
}

export class SimError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SimError'
  }
}

export interface Quote {
  symbol: string
  time: number
  bid: number
  ask: number
}

/** A bar carrying both sides. `time` is its open; `end` its close instant. */
export interface BidAskBar {
  symbol: string
  time: number
  end: number
  bidOpen: number
  bidHigh: number
  bidLow: number
  bidClose: number
  askOpen: number
  askHigh: number
  askLow: number
  askClose: number
}

/** The engine's own record of an order/trade: the wire shape (`SimOrder`/`SimTrade`) IS the
 * state, so a snapshot is a copy and persistence a JSON dump. */
export type Order = SimOrder
export type Trade = SimTrade
export type Event = SimEvent

/** The tri-state an amendment uses: `undefined` leaves a field alone, `null` clears it. */
export type Amend = number | null | undefined

export type { BreakevenRequest, ManagementPatch, MilestoneRequest, TrailRequest }

export interface SubmitRequest {
  symbol: string
  side: SimSide
  type: SimOrderType
  units: number
  price?: number | null
  stopLoss?: number | null
  takeProfit?: number | null
  label?: string | null
  trailingStop?: TrailRequest | null
  breakeven?: BreakevenRequest | null
  milestones?: MilestoneRequest[] | null
}

export interface EngineState {
  initialBalance: number
  currency: string
  balance: number
  clock: number
  nextId: number
  quotes: Record<string, Quote>
  orders: Order[]
  trades: Trade[]
}

function pnl(side: SimSide, units: number, entry: number, exit: number): number {
  const delta = side === 'buy' ? exit - entry : entry - exit
  return delta * units
}

function event(kind: Event['kind'], time: number, fields: Partial<Event> = {}): Event {
  return { kind, time, orderId: null, tradeId: null, price: null, reason: null, ...fields }
}

export class Engine {
  balance: number
  clock = 0
  readonly orders = new Map<string, Order>()
  readonly trades = new Map<string, Trade>()
  /** Newest quote per symbol: what a market order fills against, what P&L marks to. */
  readonly quotes = new Map<string, Quote>()
  /** How many times exit management has moved a stop: a trail emits no event, but the account
   * changed. Not state. */
  adjustments = 0
  private nextId = 1

  constructor(
    readonly initialBalance = 100_000,
    readonly currency = 'USD'
  ) {
    this.balance = initialBalance
  }

  // -- persistence -----------------------------------------------------------------------

  toState(): EngineState {
    return {
      initialBalance: this.initialBalance,
      currency: this.currency,
      balance: this.balance,
      clock: this.clock,
      nextId: this.nextId,
      quotes: Object.fromEntries(this.quotes),
      orders: [...this.orders.values()].map(copyRecord),
      trades: [...this.trades.values()].map(copyRecord)
    }
  }

  static fromState(state: EngineState): Engine {
    const engine = new Engine(state.initialBalance, state.currency)
    engine.balance = state.balance
    engine.clock = state.clock
    engine.nextId = state.nextId
    for (const [k, q] of Object.entries(state.quotes)) engine.quotes.set(k, { ...q })
    // A replay saved before exit management has none: it reads as none.
    for (const o of state.orders) engine.orders.set(o.id, withManagement(copyRecord(o)))
    for (const t of state.trades) engine.trades.set(t.id, { ...withManagement(copyRecord(t)), stopMovedBy: t.stopMovedBy ?? null })
    return engine
  }

  /** Put this engine back as `state` had it -- in place, since the session holds it: a run that
   * found nothing to stop at is taken back whole. */
  restore(state: EngineState): void {
    const from = Engine.fromState(state)
    this.balance = from.balance
    this.clock = from.clock
    this.nextId = from.nextId
    this.quotes.clear()
    for (const [k, q] of from.quotes) this.quotes.set(k, q)
    this.orders.clear()
    for (const [k, o] of from.orders) this.orders.set(k, o)
    this.trades.clear()
    for (const [k, t] of from.trades) this.trades.set(k, t)
  }

  private id(prefix: string): string {
    return `${prefix}${this.nextId++}`
  }

  // -- queries ---------------------------------------------------------------------------

  openTrades(symbol?: string): Trade[] {
    return [...this.trades.values()].filter((t) => t.closedAt === null && (symbol === undefined || t.symbol === symbol))
  }

  pendingOrders(symbol?: string): Order[] {
    return [...this.orders.values()].filter((o) => o.status === 'pending' && (symbol === undefined || o.symbol === symbol))
  }

  closedTrades(): Trade[] {
    return [...this.trades.values()].filter((t) => t.closedAt !== null)
  }

  unrealizedPnl(): number {
    let total = 0
    for (const trade of this.openTrades()) {
      const q = this.quotes.get(trade.symbol)
      if (q) total += pnl(trade.side, trade.units, trade.entryPrice, trade.side === 'buy' ? q.bid : q.ask)
    }
    return total
  }

  equity(): number {
    return this.balance + this.unrealizedPnl()
  }

  netPosition(symbol: string): number {
    let net = 0
    for (const t of this.openTrades(symbol)) net += t.side === 'buy' ? t.units : -t.units
    return net
  }

  // -- requests --------------------------------------------------------------------------

  submit(request: SubmitRequest): { order: Order; events: Event[] } {
    const { symbol, side, type, units } = request
    if (!(units > 0)) throw new SimError('units must be positive')
    if (side !== 'buy' && side !== 'sell') throw new SimError(`unknown side '${side}'`)
    if (type !== 'market' && type !== 'limit' && type !== 'stop') throw new SimError(`unknown order type '${type}'`)
    const quote = this.quotes.get(symbol)
    if (!quote) throw new SimError(`no price yet for ${symbol}`)
    let price: number | null = request.price ?? null
    if (type === 'market') price = null
    else {
      if (price === null || !(price > 0)) throw new SimError(`a ${type} order needs a price`)
      checkRestingPrice(side, type, price, quote)
    }
    const stopLoss = request.stopLoss ?? null
    const takeProfit = request.takeProfit ?? null
    checkProtection(side, stopLoss, takeProfit, price ?? (side === 'buy' ? quote.ask : quote.bid))
    checkManagement(request.trailingStop ?? null, request.breakeven ?? null, request.milestones ?? null)
    const order: Order = {
      id: this.id('o'),
      symbol,
      side,
      type,
      units,
      price,
      stopLoss,
      takeProfit,
      status: 'pending',
      createdAt: Math.max(this.clock, quote.time),
      filledAt: null,
      fillPrice: null,
      tradeId: null,
      label: request.label ?? null,
      trailingStop: orderTrail(request.trailingStop ?? null),
      breakeven: orderBreakeven(request.breakeven ?? null),
      milestones: orderMilestones(request.milestones ?? null)
    }
    this.orders.set(order.id, order)
    const events: Event[] = []
    if (type === 'market') {
      events.push(this.fill(order, side === 'buy' ? quote.ask : quote.bid, order.createdAt))
      // The fill is a price the new trade has seen: a trail with no stop has one now.
      const trade = this.trades.get(order.tradeId as string) as Trade
      const mark = closing(trade.side, quote.bid, quote.ask)
      events.push(...this.manage(trade, mark, mark, mark, order.createdAt))
    }
    return { order, events }
  }

  cancel(orderId: string): Event {
    const order = this.orders.get(orderId)
    if (!order) throw new SimError(`unknown order ${orderId}`)
    if (order.status !== 'pending') throw new SimError(`order ${orderId} is ${order.status}`)
    order.status = 'cancelled'
    return event('cancel', this.clock, { orderId })
  }

  modifyOrder(orderId: string, patch: { price?: number; stopLoss?: Amend; takeProfit?: Amend } & ManagementPatch): Order {
    const order = this.orders.get(orderId)
    if (!order) throw new SimError(`unknown order ${orderId}`)
    if (order.status !== 'pending') throw new SimError(`order ${orderId} is ${order.status}`)
    // Validate the whole amended order before touching it (engine.py does the same): a
    // refused amendment leaves the order exactly as it was.
    let newPrice = order.price
    if (patch.price !== undefined) {
      const quote = this.quotes.get(order.symbol)
      if (!quote) throw new SimError(`no price yet for ${order.symbol}`)
      checkRestingPrice(order.side, order.type, patch.price, quote)
      newPrice = patch.price
    }
    const newSl = patch.stopLoss === undefined ? order.stopLoss : patch.stopLoss
    const newTp = patch.takeProfit === undefined ? order.takeProfit : patch.takeProfit
    if (newPrice === null) throw new SimError(`order ${orderId} has no price`)
    checkProtection(order.side, newSl, newTp, newPrice)
    checkManagement(patch.trailingStop ?? null, patch.breakeven ?? null, patch.milestones === undefined ? null : (patch.milestones ?? []))
    order.price = newPrice
    order.stopLoss = newSl
    order.takeProfit = newTp
    if (patch.trailingStop !== undefined) order.trailingStop = orderTrail(patch.trailingStop)
    else order.trailingStop = orderTrail(order.trailingStop ?? null)
    if (patch.breakeven !== undefined) order.breakeven = orderBreakeven(patch.breakeven)
    else order.breakeven = orderBreakeven(order.breakeven ?? null)
    order.milestones = orderMilestones(patch.milestones === undefined ? (order.milestones ?? []) : patch.milestones)
    return order
  }

  /** Amend an open trade (tri-state, as `modifyOrder`). A new trail or breakeven is applied at
   * once against the newest quote; new milestones start unreached. */
  modifyTrade(tradeId: string, patch: { stopLoss?: Amend; takeProfit?: Amend } & ManagementPatch): Trade {
    const trade = this.trades.get(tradeId)
    if (!trade) throw new SimError(`unknown trade ${tradeId}`)
    if (trade.closedAt !== null) throw new SimError(`trade ${tradeId} is closed`)
    const newSl = patch.stopLoss === undefined ? trade.stopLoss : patch.stopLoss
    const newTp = patch.takeProfit === undefined ? trade.takeProfit : patch.takeProfit
    const quote = this.quotes.get(trade.symbol)
    if (!quote) throw new SimError(`no price yet for ${trade.symbol}`)
    const mark = closing(trade.side, quote.bid, quote.ask)
    checkProtection(trade.side, newSl, newTp, mark)
    checkManagement(patch.trailingStop ?? null, patch.breakeven ?? null, patch.milestones === undefined ? null : (patch.milestones ?? []))
    if (newSl !== trade.stopLoss) trade.stopMovedBy = null
    trade.stopLoss = newSl
    trade.takeProfit = newTp
    // A trail set now starts from now: its best is the price it is set at.
    if (patch.trailingStop !== undefined) trade.trailingStop = orderTrail(patch.trailingStop)
    if (patch.breakeven !== undefined) trade.breakeven = orderBreakeven(patch.breakeven)
    if (patch.milestones !== undefined) trade.milestones = orderMilestones(patch.milestones)
    if (patch.trailingStop || patch.breakeven) this.ratchet(trade, mark)
    return trade
  }

  closeTrade(tradeId: string, units?: number | null): Event[] {
    let trade = this.trades.get(tradeId)
    if (!trade) throw new SimError(`unknown trade ${tradeId}`)
    if (trade.closedAt !== null) throw new SimError(`trade ${tradeId} is closed`)
    const quote = this.quotes.get(trade.symbol)
    if (!quote) throw new SimError(`no price yet for ${trade.symbol}`)
    const price = trade.side === 'buy' ? quote.bid : quote.ask
    const at = Math.max(this.clock, quote.time)
    if (units !== undefined && units !== null && units > 0 && units < trade.units) trade = this.split(trade, units)
    return [this.close(trade, price, at, 'manual')]
  }

  flatten(symbol?: string | null): Event[] {
    const sym = symbol ?? undefined
    const events = this.pendingOrders(sym).map((o) => this.cancel(o.id))
    for (const trade of this.openTrades(sym)) {
      const quote = this.quotes.get(trade.symbol)
      if (!quote) continue
      const price = trade.side === 'buy' ? quote.bid : quote.ask
      events.push(this.close(trade, price, Math.max(this.clock, quote.time), 'flatten'))
    }
    return events
  }

  // -- market data -----------------------------------------------------------------------

  onQuote(quote: Quote): Event[] {
    this.quotes.set(quote.symbol, quote)
    this.clock = Math.max(this.clock, quote.time)
    const events: Event[] = []
    for (const order of this.pendingOrders(quote.symbol)) {
      const price = restingFillPrice(order, quote.bid, quote.ask, quote.bid, quote.ask, quote.bid, quote.ask)
      if (price !== null) events.push(this.fill(order, price, quote.time))
    }
    for (const trade of this.openTrades(quote.symbol)) {
      const hit = protectionHit(trade, quote.bid, quote.ask, quote.bid, quote.ask, quote.bid, quote.ask)
      if (hit) {
        events.push(this.close(trade, hit.price, quote.time, hit.reason))
        continue
      }
      const mark = closing(trade.side, quote.bid, quote.ask)
      events.push(...this.manage(trade, mark, mark, mark, quote.time))
    }
    return events
  }

  /** Fold one bar: the open first (gaps), then the range, then the close. A trade an order
   * opens on this bar is judged on this bar's whole range for protection. */
  onBar(bar: BidAskBar): Event[] {
    const events: Event[] = []
    this.quotes.set(bar.symbol, { symbol: bar.symbol, time: bar.time, bid: bar.bidOpen, ask: bar.askOpen })
    this.clock = Math.max(this.clock, bar.time)
    for (const order of this.pendingOrders(bar.symbol)) {
      const price = restingFillPrice(order, bar.bidOpen, bar.askOpen, bar.bidLow, bar.askHigh, bar.bidHigh, bar.askLow)
      if (price !== null) {
        const at = gapped(order, bar) ? bar.time : midBar(bar)
        events.push(this.fill(order, price, at))
      }
    }
    for (const trade of this.openTrades(bar.symbol)) {
      const hit = protectionHit(trade, bar.bidOpen, bar.askOpen, bar.bidLow, bar.askHigh, bar.bidHigh, bar.askLow)
      if (hit) {
        const at = trade.openedAt < bar.time && protectionGapped(trade, bar) ? bar.time : midBar(bar)
        events.push(this.close(trade, hit.price, Math.max(at, trade.openedAt), hit.reason))
        continue
      }
      // Survived the bar: management on its close, milestones on its range when the trade was
      // open before the bar began.
      const mark = closing(trade.side, bar.bidClose, bar.askClose)
      const before = trade.openedAt < bar.time
      const best = before ? (trade.side === 'buy' ? bar.bidHigh : bar.askLow) : mark
      const worst = before ? (trade.side === 'buy' ? bar.bidLow : bar.askHigh) : mark
      events.push(...this.manage(trade, mark, best, worst, Math.max(midBar(bar), trade.openedAt)))
    }
    this.quotes.set(bar.symbol, { symbol: bar.symbol, time: bar.end, bid: bar.bidClose, ask: bar.askClose })
    this.clock = Math.max(this.clock, bar.end)
    return events
  }

  // -- internals -------------------------------------------------------------------------

  private fill(order: Order, price: number, at: number): Event {
    order.status = 'filled'
    order.filledAt = at
    order.fillPrice = price
    const trade: Trade = {
      id: this.id('t'),
      symbol: order.symbol,
      side: order.side,
      units: order.units,
      entryPrice: price,
      openedAt: at,
      orderId: order.id,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      closedAt: null,
      closePrice: null,
      closeReason: null,
      realizedPnl: null,
      label: order.label,
      trailingStop: orderTrail(order.trailingStop ?? null),
      breakeven: orderBreakeven(order.breakeven ?? null),
      milestones: orderMilestones(order.milestones ?? []),
      stopMovedBy: null
    }
    this.trades.set(trade.id, trade)
    order.tradeId = trade.id
    return event('fill', at, { orderId: order.id, tradeId: trade.id, price })
  }

  private close(trade: Trade, price: number, at: number, reason: CloseReason): Event {
    trade.closedAt = at
    trade.closePrice = price
    trade.closeReason = reason
    trade.realizedPnl = pnl(trade.side, trade.units, trade.entryPrice, price)
    this.balance += trade.realizedPnl
    return event('close', at, { tradeId: trade.id, price, reason })
  }

  private split(trade: Trade, units: number): Trade {
    trade.units -= units
    const part: Trade = { ...copyRecord(trade), id: this.id('t'), units }
    this.trades.set(part.id, part)
    return part
  }

  /** A price the trade survived: the milestones its range reached, then the breakeven and the
   * trail on `mark` (the closing side). `best`/`worst` are the closing side's extremes. */
  private manage(trade: Trade, mark: number, best: number, worst: number, at: number): Event[] {
    const events: Event[] = []
    const d = trade.side === 'buy' ? 1 : -1
    const tol = tolerance(trade.entryPrice)
    for (const m of trade.milestones ?? []) {
      if (m.reachedAt !== null) continue
      const level = trade.entryPrice + d * m.distance
      const gone = ((m.distance > 0 ? best : worst) - trade.entryPrice) * d
      if (m.distance > 0 ? gone >= m.distance - tol : gone <= m.distance + tol) {
        m.reachedAt = at
        m.price = level
        events.push(event('milestone', at, { tradeId: trade.id, price: level, reason: m.label }))
      }
    }
    this.ratchet(trade, mark)
    return events
  }

  /** Move the stop by the breakeven and the trail, if either is due at `mark`. */
  private ratchet(trade: Trade, mark: number): void {
    const d = trade.side === 'buy' ? 1 : -1
    const tol = tolerance(trade.entryPrice)
    const be = trade.breakeven
    if (be && !be.done && (mark - trade.entryPrice) * d >= be.trigger - tol) {
      be.done = true
      const level = trade.entryPrice + d * be.offset
      if (trade.stopLoss === null || (level - trade.stopLoss) * d > tol) this.moveStop(trade, level, 'breakeven')
    }
    const ts = trade.trailingStop
    if (!ts || (ts.best !== null && (mark - ts.best) * d <= 0)) return
    ts.best = mark
    if (ts.activation !== null && (ts.best - trade.entryPrice) * d < ts.activation - tol) return
    const candidate = ts.best - d * ts.distance
    if (trade.stopLoss !== null) {
      const gain = (candidate - trade.stopLoss) * d
      if (ts.step !== null ? gain < ts.step - tol : gain <= tol) return
    }
    this.moveStop(trade, candidate, 'trail')
  }

  private moveStop(trade: Trade, level: number, by: 'trail' | 'breakeven'): void {
    trade.stopLoss = level
    trade.stopMovedBy = by
    this.adjustments++
  }
}

/** A trail as an order carries it, or as a trade starts it: not yet priced. */
function orderTrail(t: TrailRequest | null): SimTrailingStop | null {
  return t ? { distance: t.distance, activation: t.activation ?? null, step: t.step ?? null, best: null } : null
}

function orderBreakeven(b: BreakevenRequest | null): SimBreakeven | null {
  return b ? { trigger: b.trigger, offset: b.offset ?? 0, done: false } : null
}

function orderMilestones(ms: MilestoneRequest[] | null): SimMilestone[] {
  return (ms ?? []).map((m) => ({ distance: m.distance, label: m.label ?? null, reachedAt: null, price: null }))
}

/** A record's copy with its own trail, breakeven and milestones: the wire shape is the state, so
 * a shallow copy would share them with the original. */
function copyRecord<T extends Order | Trade>(r: T): T {
  return {
    ...r,
    ...(r.trailingStop !== undefined ? { trailingStop: r.trailingStop ? { ...r.trailingStop } : null } : {}),
    ...(r.breakeven !== undefined ? { breakeven: r.breakeven ? { ...r.breakeven } : null } : {}),
    ...(r.milestones !== undefined ? { milestones: r.milestones.map((m) => ({ ...m })) } : {})
  }
}

function withManagement<T extends Order | Trade>(r: T): T {
  return { ...r, trailingStop: r.trailingStop ?? null, breakeven: r.breakeven ?? null, milestones: r.milestones ?? [] }
}

/** The price a trade closes at: a long on the bid, a short on the ask. */
function closing(side: SimSide, bid: number, ask: number): number {
  return side === 'buy' ? bid : ask
}

function finite(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

/** The exit management an order or trade may carry (engine.py `_check_management`). */
function checkManagement(trail: TrailRequest | null, breakeven: BreakevenRequest | null, milestones: MilestoneRequest[] | null): void {
  if (trail) {
    if (!finite(trail.distance) || trail.distance <= 0) throw new SimError("a trailing stop's distance must be positive")
    const a = trail.activation ?? null
    if (a !== null && (!finite(a) || a < 0)) throw new SimError("a trailing stop's activation must be zero or more")
    const st = trail.step ?? null
    if (st !== null && (!finite(st) || st <= 0)) throw new SimError("a trailing stop's step must be positive")
  }
  if (breakeven) {
    if (!finite(breakeven.trigger) || breakeven.trigger <= 0) throw new SimError("a breakeven's trigger must be positive")
    const offset = breakeven.offset ?? 0
    if (!finite(offset) || offset >= breakeven.trigger) throw new SimError("a breakeven's offset must be below its trigger")
  }
  if (milestones) {
    if (milestones.length > MAX_MILESTONES) throw new SimError(`at most ${MAX_MILESTONES} milestones`)
    for (const m of milestones) {
      if (!finite(m.distance) || m.distance === 0) throw new SimError("a milestone's distance must be a non-zero number")
      if (m.label !== undefined && m.label !== null && m.label.length > MAX_MILESTONE_LABEL) {
        throw new SimError(`a milestone's label is at most ${MAX_MILESTONE_LABEL} characters`)
      }
    }
  }
}

function checkRestingPrice(side: SimSide, type: SimOrderType, price: number, quote: Quote): void {
  if (type === 'limit') {
    if (side === 'buy' && price >= quote.ask) throw new SimError(`buy limit ${price} must be below the ask ${quote.ask}`)
    if (side === 'sell' && price <= quote.bid) throw new SimError(`sell limit ${price} must be above the bid ${quote.bid}`)
  } else {
    if (side === 'buy' && price <= quote.ask) throw new SimError(`buy stop ${price} must be above the ask ${quote.ask}`)
    if (side === 'sell' && price >= quote.bid) throw new SimError(`sell stop ${price} must be below the bid ${quote.bid}`)
  }
}

function checkProtection(side: SimSide, stopLoss: number | null, takeProfit: number | null, reference: number): void {
  if (stopLoss !== null && stopLoss <= 0) throw new SimError('stop loss must be positive')
  if (takeProfit !== null && takeProfit <= 0) throw new SimError('take profit must be positive')
  if (side === 'buy') {
    if (stopLoss !== null && stopLoss >= reference) throw new SimError(`a long's stop loss ${stopLoss} must be below ${reference}`)
    if (takeProfit !== null && takeProfit <= reference) throw new SimError(`a long's take profit ${takeProfit} must be above ${reference}`)
  } else {
    if (stopLoss !== null && stopLoss <= reference) throw new SimError(`a short's stop loss ${stopLoss} must be above ${reference}`)
    if (takeProfit !== null && takeProfit >= reference) throw new SimError(`a short's take profit ${takeProfit} must be below ${reference}`)
  }
}

/** The price a pending order fills at over a range, or null. A buy triggers on the ask, a
 * sell on the bid; a limit takes the better of its price and the open, a stop the worse. */
function restingFillPrice(
  order: Order,
  bidOpen: number,
  askOpen: number,
  bidLow: number,
  askHigh: number,
  bidHigh: number,
  askLow: number
): number | null {
  const p = order.price as number
  if (order.type === 'limit') {
    if (order.side === 'buy') return askLow > p ? null : Math.min(p, askOpen)
    return bidHigh < p ? null : Math.max(p, bidOpen)
  }
  if (order.side === 'buy') return askHigh < p ? null : Math.max(p, askOpen)
  return bidLow > p ? null : Math.min(p, bidOpen)
}

function gapped(order: Order, bar: BidAskBar): boolean {
  const p = order.price as number
  const open = order.side === 'buy' ? bar.askOpen : bar.bidOpen
  if (order.type === 'limit') return order.side === 'buy' ? open <= p : open >= p
  return order.side === 'buy' ? open >= p : open <= p
}

function protectionHit(
  trade: Trade,
  bidOpen: number,
  askOpen: number,
  bidLow: number,
  askHigh: number,
  bidHigh: number,
  askLow: number
): { reason: CloseReason; price: number } | null {
  const { stopLoss: sl, takeProfit: tp } = trade
  // Within a part in 1e9: a trailed stop can sit an ulp off the decimal it means.
  if (trade.side === 'buy') {
    if (sl !== null && bidLow <= sl + tolerance(sl)) return { reason: 'stop_loss', price: Math.min(sl, bidOpen) }
    if (tp !== null && bidHigh >= tp - tolerance(tp)) return { reason: 'take_profit', price: Math.max(tp, bidOpen) }
  } else {
    if (sl !== null && askHigh >= sl - tolerance(sl)) return { reason: 'stop_loss', price: Math.max(sl, askOpen) }
    if (tp !== null && askLow <= tp + tolerance(tp)) return { reason: 'take_profit', price: Math.min(tp, askOpen) }
  }
  return null
}

function protectionGapped(trade: Trade, bar: BidAskBar): boolean {
  const { stopLoss: sl, takeProfit: tp } = trade
  if (trade.side === 'buy') return (sl !== null && bar.bidOpen <= sl + tolerance(sl)) || (tp !== null && bar.bidOpen >= tp - tolerance(tp))
  return (sl !== null && bar.askOpen >= sl - tolerance(sl)) || (tp !== null && bar.askOpen <= tp + tolerance(tp))
}

/** The instant an intra-bar event is stamped with: the bar's open (the true instant is
 * unknown; the open is the bar the chart shows it on). */
function midBar(bar: BidAskBar): number {
  return bar.time
}
