import type { ManagementPatch, SimOrder, SimSnapshot, SimTrade } from './api'
import { breakevenWords, distanceWords, trailWords } from './exits'
import { formatMoney, formatPercent, formatPrice, formatUnitsShort, moveText } from './format'
import type { InstrumentInfo } from './instrument'
import type { Amendment } from './lines'
import { levelRefusal, restingRefusal } from './levels'
import { closingPrice, fillingPrice, outcome, pricingContext, protectionValid } from './metrics'
import { tickerOf } from '../instrumentkey'

// A change to a working stop, target or pending price, put to the user before it is sent -- in
// words, and checked against what the engine would refuse. PURE, and shared: the chart's labels and
// card (onchart.ts) and the account window's tables (panel.ts) ask the same question the same way,
// whichever of them the change came from. The change itself is held by `TradingOverlays`.

export type ProposedChange = Omit<Amendment, 'from'>

/** Why the engine would refuse the change, in words -- or null when it would accept it. Mirrors
 * `_check_protection` (a long's stop below its closing side, an order's levels around its price)
 * and `_check_resting_price` (a limit on the far side of the market, a stop beyond it), worded as
 * the trade box words them (levels.ts `levelRefusal`, `restingRefusal`). */
export function amendmentRefusal(change: ProposedChange, snapshot: SimSnapshot, info: InstrumentInfo): string | null {
  const { owner, id, role, price } = change
  const precision = info.precision
  if (role === 'manage') {
    if (owner === 'trade') {
      const trade = snapshot.trades.find((t) => t.id === id)
      return trade?.closedAt === null ? null : 'This trade has closed'
    }
    const order = snapshot.orders.find((o) => o.id === id)
    return order?.status === 'pending' ? null : 'This order is no longer working'
  }
  if (owner === 'trade') {
    const trade = snapshot.trades.find((t) => t.id === id)
    if (!trade || trade.closedAt !== null) return 'This trade has closed'
    if (price === null || role === 'order') return null
    return levelRefusal('trade', trade.side, role, price, closingPrice(trade.side, snapshot.quotes[trade.symbol]), precision)
  }
  const order = snapshot.orders.find((o) => o.id === id)
  if (!order || order.status !== 'pending' || order.price === null) return 'This order is no longer working'
  if (price === null) return role === 'order' ? 'An order must keep a price' : null
  if (role === 'order') {
    const quote = snapshot.quotes[order.symbol]
    // Without a quote there is nothing to judge the price against, and so nothing is refused.
    if (!quote) return null
    const resting = restingRefusal(order.side, order.type, price, quote, precision)
    if (resting) return resting
    if (order.stopLoss !== null && !protectionValid(order.side, 'stop', order.stopLoss, price)) {
      return 'The order would pass its own stop loss'
    }
    if (order.takeProfit !== null && !protectionValid(order.side, 'target', order.takeProfit, price)) {
      return 'The order would pass its own take profit'
    }
    return null
  }
  return levelRefusal('order', order.side, role, price, order.price, precision)
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
  const ticker = tickerOf(position.symbol)
  if (a.role === 'manage') return describeManagement(a.manage ?? {}, position, trade !== undefined, ticker, snapshot, info)
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

/** A change to a working position's exit management, asked in words: "Trail the EURUSD long 10K's
 * stop 20.0p behind the bid?", and what it does now. */
function describeManagement(
  patch: ManagementPatch,
  position: SimTrade | SimOrder,
  isTrade: boolean,
  ticker: string,
  snapshot: SimSnapshot,
  info: InstrumentInfo
): { title: string; detail: string } {
  const whose = isTrade
    ? `${ticker} ${position.side === 'buy' ? 'long' : 'short'} ${formatUnitsShort(position.units)}`
    : `${ticker} ${position.side} ${(position as SimOrder).type} ${formatUnitsShort(position.units)}`
  const closing = position.side === 'buy' ? 'bid' : 'ask'
  if (patch.trailingStop !== undefined) {
    const t = patch.trailingStop
    if (t === null) return { title: `Remove the trailing stop from the ${whose}?`, detail: 'The stop stays where it is now.' }
    let detail = isTrade ? 'The stop moves with the next new best price.' : 'It starts when the order fills.'
    const quote = snapshot.quotes[position.symbol]
    if (isTrade && quote && (t.activation === null || t.activation === undefined)) {
      const d = position.side === 'buy' ? 1 : -1
      const mark = position.side === 'buy' ? quote.bid : quote.ask
      const level = mark - d * t.distance
      const stop = (position as SimTrade).stopLoss
      detail =
        stop === null || (level - stop) * d > 0
          ? `The stop goes to ${formatPrice(level, info.precision)} now and follows the ${closing} from there.`
          : `The stop (${formatPrice(stop, info.precision)}) is already tighter; it moves once the ${closing} makes new ground.`
    }
    return { title: `Trail the ${whose}'s stop ${trailWords(t, info)} behind the ${closing}?`, detail }
  }
  if (patch.breakeven !== undefined) {
    const b = patch.breakeven
    if (b === null) return { title: `Remove the breakeven from the ${whose}?`, detail: 'The stop will not move to the entry by itself.' }
    return { title: `Move the ${whose}'s stop to breakeven ${breakevenWords(b, info)}?`, detail: `Once, the first time it is ${distanceWords(b.trigger, info)} in profit.` }
  }
  const milestones = patch.milestones ?? []
  if (milestones.length === 0) return { title: `Stop the notifications on the ${whose}?`, detail: 'No milestone will be told.' }
  const names = milestones.map((m) => m.label ?? `${m.distance > 0 ? '+' : '−'}${distanceWords(Math.abs(m.distance), info)}`).join(' · ')
  return { title: `Notify at ${names} on the ${whose}?`, detail: 'Each the first time the price reaches it, from now; one already passed is told by the next price.' }
}
