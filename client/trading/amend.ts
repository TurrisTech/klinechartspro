import type { SimSnapshot } from './api'
import { formatMoney, formatPercent, formatPrice, formatUnitsShort, moveText } from './format'
import type { InstrumentInfo } from './instrument'
import type { Amendment } from './lines'
import { closingPrice, fillingPrice, outcome, pricingContext, protectionValid, restingPriceValid } from './metrics'

// A change to a working stop, target or pending price, put to the user before it is sent -- in
// words, and checked against what the engine would refuse. PURE, and shared: the chart's labels and
// card (onchart.ts) and the account window's tables (panel.ts) ask the same question the same way,
// whichever of them the change came from. The change itself is held by `TradingOverlays`.

export type ProposedChange = Omit<Amendment, 'from'>

/** Why the engine would refuse the change, in words -- or null when it would accept it. Mirrors
 * `_check_protection` (a long's stop below its closing side, an order's levels around its price)
 * and `_check_resting_price` (a limit on the far side of the market, a stop beyond it). */
export function amendmentRefusal(change: ProposedChange, snapshot: SimSnapshot, info: InstrumentInfo): string | null {
  const { owner, id, role, price } = change
  const precision = info.precision
  if (owner === 'trade') {
    const trade = snapshot.trades.find((t) => t.id === id)
    if (!trade || trade.closedAt !== null) return 'This trade has closed'
    if (price === null || role === 'order') return null
    const mark = closingPrice(trade.side, snapshot.quotes[trade.symbol])
    if (mark === null || protectionValid(trade.side, role, price, mark)) return null
    const below = role === 'stop' ? trade.side === 'buy' : trade.side === 'sell'
    return `A ${trade.side === 'buy' ? 'long' : 'short'}'s ${role} must be ${below ? 'below' : 'above'} the ${
      trade.side === 'buy' ? 'bid' : 'ask'
    } (${formatPrice(mark, precision)})`
  }
  const order = snapshot.orders.find((o) => o.id === id)
  if (!order || order.status !== 'pending' || order.price === null) return 'This order is no longer working'
  if (price === null) return role === 'order' ? 'An order must keep a price' : null
  if (role === 'order') {
    const quote = snapshot.quotes[order.symbol]
    if (!restingPriceValid(order.side, order.type, price, quote)) {
      const fill = fillingPrice(order.side, quote)
      if (fill === null) return null
      const below = (order.type === 'limit') === (order.side === 'buy')
      return `A ${order.side} ${order.type} must be ${below ? 'below' : 'above'} the ${order.side === 'buy' ? 'ask' : 'bid'} (${formatPrice(fill, precision)})`
    }
    if (order.stopLoss !== null && !protectionValid(order.side, 'stop', order.stopLoss, price)) {
      return 'The order would pass its own stop loss'
    }
    if (order.takeProfit !== null && !protectionValid(order.side, 'target', order.takeProfit, price)) {
      return 'The order would pass its own take profit'
    }
    return null
  }
  if (protectionValid(order.side, role, price, order.price)) return null
  const below = role === 'stop' ? order.side === 'buy' : order.side === 'sell'
  return `A ${order.side} order's ${role} must be ${below ? 'below' : 'above'} its price (${formatPrice(order.price, precision)})`
}

/** The question: what changes, on which position, and what the new level would realise. Null when
 * the position is gone. Worded from the REAL snapshot, so "from" is what is working now. */
export function describeAmendment(
  a: Amendment,
  snapshot: SimSnapshot,
  info: InstrumentInfo
): { title: string; detail: string } | null {
  const trade = a.owner === 'trade' ? snapshot.trades.find((t) => t.id === a.id) : undefined
  const order = a.owner === 'order' ? snapshot.orders.find((o) => o.id === a.id) : undefined
  const position = trade ?? order
  if (!position) return null
  const precision = info.precision
  const ticker = position.symbol.includes(':') ? position.symbol.split(':', 2)[1] : position.symbol
  const what = a.role === 'stop' ? 'stop loss' : a.role === 'target' ? 'take profit' : `${order?.type ?? 'order'} price`
  const whose = trade
    ? `${ticker} ${trade.side === 'buy' ? 'long' : 'short'} ${formatUnitsShort(trade.units)}`
    : `${ticker} ${position.side} ${order?.type ?? ''} ${formatUnitsShort(position.units)}`
  let title: string
  if (a.price === null) title = `Remove the ${what} (${formatPrice(a.from, precision)}) from the ${whose}?`
  else if (a.from === null) title = `Add a ${what} at ${formatPrice(a.price, precision)} to the ${whose}?`
  else title = `Move the ${whose}'s ${what} ${formatPrice(a.from, precision)} → ${formatPrice(a.price, precision)}?`

  const ctx = pricingContext(position.symbol, info, snapshot.account, snapshot.quotes[position.symbol], snapshot.quotes)
  let detail = ''
  if (a.price === null) {
    detail = a.role === 'stop' ? 'The position will have no stop loss.' : 'The position will have no take profit.'
  } else if (a.role !== 'order') {
    const from = trade ? trade.entryPrice : order?.price
    if (from !== null && from !== undefined) {
      const o = outcome(position.side, position.units, from, a.price, ctx)
      detail = `If hit: ${moveText(o)} · ${formatMoney(o.amount, ctx.currencies.quote)}${o.ofBalance !== null ? ` (${formatPercent(o.ofBalance)} of balance)` : ''}`
    }
  } else if (order) {
    const fill = fillingPrice(order.side, ctx.quote)
    if (fill !== null) {
      const off = Math.abs(a.price - fill)
      detail = `${moveText({ pips: info.pipSize ? off / info.pipSize : null, percent: (off / fill) * 100 }, false)} from the market`
    }
  }
  return { title, detail }
}
