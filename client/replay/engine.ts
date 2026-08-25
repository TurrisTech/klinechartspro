import type { SimEvent, SimOrder, SimOrderType, SimSide, SimTrade } from '../trading/api'

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

export type CloseReason = 'manual' | 'stop_loss' | 'take_profit' | 'flatten'

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

export interface SubmitRequest {
  symbol: string
  side: SimSide
  type: SimOrderType
  units: number
  price?: number | null
  stopLoss?: number | null
  takeProfit?: number | null
  label?: string | null
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
      orders: [...this.orders.values()].map((o) => ({ ...o })),
      trades: [...this.trades.values()].map((t) => ({ ...t }))
    }
  }

  static fromState(state: EngineState): Engine {
    const engine = new Engine(state.initialBalance, state.currency)
    engine.balance = state.balance
    engine.clock = state.clock
    engine.nextId = state.nextId
    for (const [k, q] of Object.entries(state.quotes)) engine.quotes.set(k, { ...q })
    for (const o of state.orders) engine.orders.set(o.id, { ...o })
    for (const t of state.trades) engine.trades.set(t.id, { ...t })
    return engine
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
      label: request.label ?? null
    }
    this.orders.set(order.id, order)
    const events: Event[] = []
    if (type === 'market') events.push(this.fill(order, side === 'buy' ? quote.ask : quote.bid, order.createdAt))
    return { order, events }
  }

  cancel(orderId: string): Event {
    const order = this.orders.get(orderId)
    if (!order) throw new SimError(`unknown order ${orderId}`)
    if (order.status !== 'pending') throw new SimError(`order ${orderId} is ${order.status}`)
    order.status = 'cancelled'
    return event('cancel', this.clock, { orderId })
  }

  modifyOrder(orderId: string, patch: { price?: number; stopLoss?: Amend; takeProfit?: Amend }): Order {
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
    order.price = newPrice
    order.stopLoss = newSl
    order.takeProfit = newTp
    return order
  }

  modifyTrade(tradeId: string, patch: { stopLoss?: Amend; takeProfit?: Amend }): Trade {
    const trade = this.trades.get(tradeId)
    if (!trade) throw new SimError(`unknown trade ${tradeId}`)
    if (trade.closedAt !== null) throw new SimError(`trade ${tradeId} is closed`)
    const newSl = patch.stopLoss === undefined ? trade.stopLoss : patch.stopLoss
    const newTp = patch.takeProfit === undefined ? trade.takeProfit : patch.takeProfit
    const quote = this.quotes.get(trade.symbol)
    if (!quote) throw new SimError(`no price yet for ${trade.symbol}`)
    checkProtection(trade.side, newSl, newTp, trade.side === 'buy' ? quote.bid : quote.ask)
    trade.stopLoss = newSl
    trade.takeProfit = newTp
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
      if (hit) events.push(this.close(trade, hit.price, quote.time, hit.reason))
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
      }
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
      label: order.label
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
    const part: Trade = { ...trade, id: this.id('t'), units }
    this.trades.set(part.id, part)
    return part
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
  if (trade.side === 'buy') {
    if (sl !== null && bidLow <= sl) return { reason: 'stop_loss', price: Math.min(sl, bidOpen) }
    if (tp !== null && bidHigh >= tp) return { reason: 'take_profit', price: Math.max(tp, bidOpen) }
  } else {
    if (sl !== null && askHigh >= sl) return { reason: 'stop_loss', price: Math.max(sl, askOpen) }
    if (tp !== null && askLow <= tp) return { reason: 'take_profit', price: Math.min(tp, askOpen) }
  }
  return null
}

function protectionGapped(trade: Trade, bar: BidAskBar): boolean {
  const { stopLoss: sl, takeProfit: tp } = trade
  if (trade.side === 'buy') return (sl !== null && bar.bidOpen <= sl) || (tp !== null && bar.bidOpen >= tp)
  return (sl !== null && bar.askOpen >= sl) || (tp !== null && bar.askOpen <= tp)
}

/** The instant an intra-bar event is stamped with: the bar's open (the true instant is
 * unknown; the open is the bar the chart shows it on). */
function midBar(bar: BidAskBar): number {
  return bar.time
}
