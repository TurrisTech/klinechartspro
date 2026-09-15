import type { SimAccount, SimOrder, SimOrderType, SimQuote, SimSide, SimTrade } from './api'
import type { InstrumentInfo } from './instrument'

// The numbers the on-chart order widget shows, computed from a snapshot. PURE: no DOM, no
// session, no chart -- so the forex arithmetic is tested on its own (metrics.test.ts).
//
// Everything is stated the way the engine books it (wdashboard_server/sim/engine.py):
//
// - A long exits on the bid and a short on the ask, so a trade's mark is its CLOSING side,
//   and a pending order's distance is measured from the side it would FILL on.
// - P&L is in the instrument's QUOTE currency (a USDJPY trade makes yen). The engine sums those
//   into the balance without conversion, which the server documents as an approximation for
//   anything not quoted in the account currency. The widget does not paper over that: it
//   labels an amount with the quote currency, and adds the account-currency figure only where
//   a rate comes from a real quote -- the account IS the quote currency (1:1), IS the base
//   (divide by the mid), or a pair the account holds a quote for joins the two (GBPUSD for a
//   EURGBP trade on a USD account). With none of those there is no account figure, and no
//   invented one; and risk sizing, which needs it, says so.
// - Validity mirrors the engine's refusals, so a drag that would be rejected can say so before
//   it is sent: `_check_protection` for stops/targets and `_check_resting_price` for orders.

export interface Currencies {
  base: string
  quote: string
}

/** The currencies of a pair ticker -- `EURUSD`, `EUR_USD`, `SPX500_USD` (quote only is
 * meaningful there) -- or null for a ticker that names none (`SPY`). */
export function pairCurrencies(key: string): Currencies | null {
  const ticker = (key.includes(':') ? key.split(':', 2)[1] : key).toUpperCase()
  const six = /^([A-Z]{3})([A-Z]{3})$/.exec(ticker)
  if (six) return { base: six[1], quote: six[2] }
  const split = /^([A-Z0-9]+)[_/-]([A-Z]{3})$/.exec(ticker)
  if (split) return { base: split[1], quote: split[2] }
  return null
}

export interface PricingContext {
  info: InstrumentInfo
  account: SimAccount
  quote: SimQuote | undefined
  currencies: Currencies
  /** Every quote the session holds, for a cross's conversion to the account currency. */
  quotes?: Record<string, SimQuote>
}

/** A ticker that names no currency (an equity) is booked by the engine in the account's
 * currency, so that is what it is labelled with. */
export function pricingContext(
  key: string,
  info: InstrumentInfo,
  account: SimAccount,
  quote: SimQuote | undefined,
  quotes?: Record<string, SimQuote>
): PricingContext {
  return {
    info,
    account,
    quote,
    currencies: pairCurrencies(key) ?? { base: '', quote: account.currency },
    quotes
  }
}

export function midPrice(quote: SimQuote | undefined): number | null {
  return quote ? (quote.bid + quote.ask) / 2 : null
}

/** Where a position on `side` exits: a long on the bid, a short on the ask. */
export function closingPrice(side: SimSide, quote: SimQuote | undefined): number | null {
  if (!quote) return null
  return side === 'buy' ? quote.bid : quote.ask
}

/** Where an order on `side` fills: a buy at the ask, a sell at the bid. */
export function fillingPrice(side: SimSide, quote: SimQuote | undefined): number | null {
  if (!quote) return null
  return side === 'buy' ? quote.ask : quote.bid
}

/** The factor taking a quote-currency amount to the account currency, or null where no quote
 * supplies one (see the header). */
export function quoteToAccountRate(ctx: PricingContext): number | null {
  const { base, quote } = ctx.currencies
  const account = ctx.account.currency
  if (quote === account) return 1
  if (base === account) {
    const mid = midPrice(ctx.quote)
    return mid && mid > 0 ? 1 / mid : null
  }
  for (const [key, other] of Object.entries(ctx.quotes ?? {})) {
    const pair = pairCurrencies(key)
    const mid = midPrice(other)
    if (!pair || !mid || mid <= 0) continue
    if (pair.base === quote && pair.quote === account) return mid // GBPUSD for GBP -> USD
    if (pair.base === account && pair.quote === quote) return 1 / mid // USDJPY for JPY -> USD
  }
  return null
}

/** The result of the position reaching one price, seen from where it started. */
export interface Outcome {
  price: number
  /** The price move in the position's favour: positive is profit. */
  move: number
  /** `move` in pips; null for an instrument not priced in pips. */
  pips: number | null
  /** `move` in percent of the starting price -- the non-pip instruments' unit. */
  percent: number
  /** Signed P&L in the quote currency. */
  amount: number
  /** Signed P&L in the account currency, where it converts exactly. */
  amountAccount: number | null
  /** `amountAccount` as a percentage of the balance. */
  ofBalance: number | null
}

export function outcome(
  side: SimSide,
  units: number,
  from: number,
  to: number,
  ctx: PricingContext
): Outcome {
  const move = side === 'buy' ? to - from : from - to
  const amount = move * units
  const rate = quoteToAccountRate(ctx)
  const amountAccount = rate === null ? null : amount * rate
  const balance = ctx.account.balance
  return {
    price: to,
    move,
    pips: ctx.info.pipSize ? move / ctx.info.pipSize : null,
    percent: from > 0 ? (move / from) * 100 : 0,
    amount,
    amountAccount,
    ofBalance: amountAccount !== null && balance > 0 ? (amountAccount / balance) * 100 : null
  }
}

export interface SizeFigures {
  units: number
  /** Standard lots (100,000 units) -- a forex convention, so null for anything else. */
  lots: number | null
  /** Quote currency per pip. */
  pipValue: number | null
  pipValueAccount: number | null
  /** The position's size in the account currency, at the mid. */
  notionalAccount: number | null
  /** `notionalAccount` times the vendor's margin rate. */
  margin: number | null
}

export function sizeFigures(units: number, ctx: PricingContext): SizeFigures {
  const { pipSize, assetClass, marginRate } = ctx.info
  const rate = quoteToAccountRate(ctx)
  const pipValue = pipSize ? units * pipSize : null
  const mid = midPrice(ctx.quote)
  const account = ctx.account.currency
  let notionalAccount: number | null = null
  if (ctx.currencies.base === account) notionalAccount = units
  else if (mid !== null && rate !== null) notionalAccount = units * mid * rate
  return {
    units,
    lots: assetClass === 'forex' ? units / 100_000 : null,
    pipValue,
    pipValueAccount: pipValue !== null && rate !== null ? pipValue * rate : null,
    notionalAccount,
    margin: notionalAccount !== null && marginRate !== null ? notionalAccount * marginRate : null
  }
}

/** Reward over risk: what the target makes for every unit the stop loses. Null unless the
 * stop is a loss and the target a gain -- a stop already past the entry risks nothing. */
export function rewardToRisk(stop: Outcome | null, target: Outcome | null): number | null {
  if (!stop || !target || stop.amount >= 0 || target.amount <= 0) return null
  return target.amount / -stop.amount
}

export interface TradeFigures extends SizeFigures {
  /** The closing-side price now. */
  mark: number | null
  /** Open P&L: entry to mark. */
  pnl: Outcome | null
  /** What the stop / target would realise, from the entry. */
  stop: Outcome | null
  target: Outcome | null
  rewardToRisk: number | null
}

export function tradeFigures(trade: SimTrade, ctx: PricingContext): TradeFigures {
  const mark = closingPrice(trade.side, ctx.quote)
  const at = (price: number | null): Outcome | null =>
    price === null ? null : outcome(trade.side, trade.units, trade.entryPrice, price, ctx)
  const stop = at(trade.stopLoss)
  const target = at(trade.takeProfit)
  return {
    ...sizeFigures(trade.units, ctx),
    mark,
    pnl: at(mark),
    stop,
    target,
    rewardToRisk: rewardToRisk(stop, target)
  }
}

export interface OrderFigures extends SizeFigures {
  /** The price the order would fill at if it were a market order now. */
  fill: number | null
  /** How far the market has to travel to reach the order, always non-negative. */
  distance: { move: number; pips: number | null; percent: number } | null
  /** What the stop / target would realise, measured from the order's own price. */
  stop: Outcome | null
  target: Outcome | null
  rewardToRisk: number | null
}

export function orderFigures(order: SimOrder, ctx: PricingContext): OrderFigures {
  const fill = fillingPrice(order.side, ctx.quote)
  const from = order.price ?? fill
  const at = (price: number | null): Outcome | null =>
    price === null || from === null ? null : outcome(order.side, order.units, from, price, ctx)
  const stop = at(order.stopLoss)
  const target = at(order.takeProfit)
  let distance: OrderFigures['distance'] = null
  if (order.price !== null && fill !== null) {
    const move = Math.abs(order.price - fill)
    distance = {
      move,
      pips: ctx.info.pipSize ? move / ctx.info.pipSize : null,
      percent: fill > 0 ? (move / fill) * 100 : 0
    }
  }
  return {
    ...sizeFigures(order.units, ctx),
    fill,
    distance,
    stop,
    target,
    rewardToRisk: rewardToRisk(stop, target)
  }
}

export interface PositionSummary {
  openTrades: number
  pendingOrders: number
  /** Long units minus short units. */
  netUnits: number
  /** The units-weighted entry of the open trades, when they are all on one side. */
  averageEntry: number | null
  pnl: number
  pnlAccount: number | null
  /** Sum of every open trade's stop outcome; null when any open trade has no stop, since the
   * position's worst case is then unbounded. */
  riskAtStops: number | null
  riskAtStopsAccount: number | null
}

export function positionSummary(trades: SimTrade[], orders: SimOrder[], ctx: PricingContext): PositionSummary {
  let netUnits = 0
  let pnl = 0
  let pnlAccount: number | null = 0
  let risk: number | null = 0
  let riskAccount: number | null = 0
  let weighted = 0
  let units = 0
  const sides = new Set<SimSide>()
  for (const trade of trades) {
    const figures = tradeFigures(trade, ctx)
    netUnits += trade.side === 'buy' ? trade.units : -trade.units
    weighted += trade.entryPrice * trade.units
    units += trade.units
    sides.add(trade.side)
    pnl += figures.pnl?.amount ?? 0
    pnlAccount =
      pnlAccount === null || !figures.pnl || figures.pnl.amountAccount === null
        ? null
        : pnlAccount + figures.pnl.amountAccount
    if (figures.stop === null) {
      risk = null
      riskAccount = null
    } else {
      risk = risk === null ? null : risk + figures.stop.amount
      riskAccount =
        riskAccount === null || figures.stop.amountAccount === null
          ? null
          : riskAccount + figures.stop.amountAccount
    }
  }
  return {
    openTrades: trades.length,
    pendingOrders: orders.length,
    netUnits,
    averageEntry: sides.size === 1 && units > 0 ? weighted / units : null,
    pnl,
    pnlAccount: trades.length === 0 ? null : pnlAccount,
    riskAtStops: trades.length === 0 ? null : risk,
    riskAtStopsAccount: trades.length === 0 ? null : riskAccount
  }
}

// -- what the engine would refuse ------------------------------------------------------------

/** `_check_protection`: a long's stop below the reference and its target above, a short's the
 * reverse. The reference is an open trade's closing-side mark, or a pending order's price. */
export function protectionValid(
  side: SimSide,
  role: 'stop' | 'target',
  price: number,
  reference: number
): boolean {
  if (!(price > 0)) return false
  const below = role === 'stop' ? side === 'buy' : side === 'sell'
  return below ? price < reference : price > reference
}

/** `_check_resting_price`: a limit rests on the far side of the market and a stop beyond it;
 * one the market is already through would fill at once, and is refused. */
export function restingPriceValid(
  side: SimSide,
  type: SimOrderType,
  price: number,
  quote: SimQuote | undefined
): boolean {
  if (!(price > 0) || !quote || type === 'market') return false
  if (type === 'limit') return side === 'buy' ? price < quote.ask : price > quote.bid
  return side === 'buy' ? price > quote.ask : price < quote.bid
}

/** Whether moving a pending order to `price` would be accepted: the resting rule, AND its own
 * stop and target still on the right sides of the new price (`modify_order` checks both). */
export function orderPriceValid(order: SimOrder, price: number, quote: SimQuote | undefined): boolean {
  if (!restingPriceValid(order.side, order.type, price, quote)) return false
  if (order.stopLoss !== null && !protectionValid(order.side, 'stop', order.stopLoss, price)) return false
  if (order.takeProfit !== null && !protectionValid(order.side, 'target', order.takeProfit, price)) return false
  return true
}

/** A starting stop or target for the "+SL"/"+TP" buttons: `distance` beyond whichever of the
 * reference and the entry is further on that side, so it is valid the moment it is placed even
 * when the trade is already under water. Rounded to the instrument's precision.
 *
 * Given the pane's `visible` price range, a level that would land off screen is pulled back
 * inside it -- it is placed to be dragged -- unless that would leave it closer than a third of
 * `distance`, where an off-screen level is the better of the two. */
export function defaultProtection(
  side: SimSide,
  role: 'stop' | 'target',
  entry: number,
  reference: number,
  distance: number,
  precision: number,
  visible?: { low: number; high: number }
): number {
  const below = role === 'stop' ? side === 'buy' : side === 'sell'
  const edge = below ? Math.min(entry, reference) : Math.max(entry, reference)
  let raw = below ? edge - distance : edge + distance
  if (visible && visible.high > visible.low) {
    const pad = (visible.high - visible.low) * 0.04
    const floor = visible.low + pad
    const ceiling = visible.high - pad
    if (below && raw < floor && edge - floor >= distance / 3) raw = floor
    if (!below && raw > ceiling && ceiling - edge >= distance / 3) raw = ceiling
  }
  return roundTo(raw, precision)
}

export function roundTo(value: number, precision: number): number {
  return Number(value.toFixed(Math.max(0, Math.min(precision, 12))))
}

/** Rounded to `precision` in the direction of `anchor`: a level computed from a budget never
 * lands a pip beyond it. The epsilon keeps an exact grid value where it is. */
export function roundToward(value: number, anchor: number, precision: number): number {
  const factor = 10 ** Math.max(0, Math.min(precision, 12))
  const scaled = value * factor
  const snapped = value < anchor ? Math.ceil(scaled - 1e-6) : Math.floor(scaled + 1e-6)
  return roundTo(snapped / factor, precision)
}

// -- sizing by risk ---------------------------------------------------------------------------

/** The units that lose `riskPercent` of the balance if a stop at `stop` is hit after entering at
 * `entry` -- floored to the instrument's unit precision, so the loss never exceeds the budget.
 * Null with no conversion to the account currency, no distance, or no budget. */
export function unitsForRisk(riskPercent: number, entry: number, stop: number, ctx: PricingContext): number | null {
  const rate = quoteToAccountRate(ctx)
  const budget = (ctx.account.balance * riskPercent) / 100
  if (rate === null || !(budget > 0)) return null
  const lossPerUnit = Math.abs(entry - stop) * rate
  if (!(lossPerUnit > 0)) return null
  const factor = 10 ** ctx.info.unitsPrecision
  return Math.floor((budget / lossPerUnit) * factor + 1e-9) / factor
}

/** The stop (or target) at which `units` entered at `from` lose (or make) `percent` of the
 * balance, rounded toward `from` so a stop never costs more than asked. Null with no conversion
 * to the account currency, or when the distance would take the price to zero. */
export function levelForBalancePercent(
  side: SimSide,
  role: 'stop' | 'target',
  units: number,
  from: number,
  percent: number,
  ctx: PricingContext
): number | null {
  const rate = quoteToAccountRate(ctx)
  if (rate === null || !(units > 0) || !(percent > 0) || !(ctx.account.balance > 0)) return null
  const move = (ctx.account.balance * percent) / 100 / (units * rate)
  const below = role === 'stop' ? side === 'buy' : side === 'sell'
  const price = below ? from - move : from + move
  return price > 0 ? roundToward(price, from, ctx.info.precision) : null
}

/** A target `ratio` times the stop's distance beyond the entry (2 -> "2R"). Null unless the stop
 * is a loss: a stop already past the entry risks nothing to multiply. */
export function targetForReward(side: SimSide, entry: number, stop: number, ratio: number, precision: number): number | null {
  const risk = side === 'buy' ? entry - stop : stop - entry
  if (!(risk > 0) || !(ratio > 0)) return null
  return roundTo(side === 'buy' ? entry + ratio * risk : entry - ratio * risk, precision)
}

// -- label placement ----------------------------------------------------------------------------

/** Vertical positions for labels that each want to sit centred on a line (`desired`, pane
 * pixels), so that no two overlap and none leaves `[0, height]`. Returned in input order.
 *
 * A downward sweep pushes each label below the one above it, then an upward sweep pulls the
 * run back inside the bottom edge. Labels whose lines are off the pane are pinned to the edge
 * they left by, which is where they then stack. `size` is one label's height plus its gap. */
export function layoutLabels(desired: number[], height: number, size: number): number[] {
  const half = size / 2
  const order = desired.map((y, i) => ({ i, y: Math.min(Math.max(y, half), Math.max(height - half, half)) }))
  order.sort((a, b) => a.y - b.y || a.i - b.i)
  for (let k = 1; k < order.length; k++) {
    order[k].y = Math.max(order[k].y, order[k - 1].y + size)
  }
  const floor = Math.max(height - half, half)
  if (order.length > 0 && order[order.length - 1].y > floor) {
    order[order.length - 1].y = floor
    for (let k = order.length - 2; k >= 0; k--) {
      order[k].y = Math.min(order[k].y, order[k + 1].y - size)
    }
  }
  const out = new Array<number>(desired.length)
  for (const { i, y } of order) out[i] = y
  return out
}
