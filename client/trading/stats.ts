import type { SimOrder, SimSnapshot, SimTrade } from './api'
import {
  formatDuration,
  formatInstant,
  formatLots,
  formatMoney,
  formatPercent,
  formatPrice,
  formatUnits,
  formatUnitsShort,
  moveText
} from './format'
import type { InstrumentInfo } from './instrument'
import { amountText, type LevelBasis, levelReadout } from './levels'
import { orderFigures, outcome, type PricingContext, pricingContext, sizeFigures, tradeFigures } from './metrics'

// What the position popup (inspector.ts) says about one trade or order. PURE: the rows are
// worked out from a snapshot here and only drawn there, so the figures are tested on their own
// (stats.test.ts) and the popup is plain layout.
//
// Three shapes: an OPEN trade (marked to the closing side now, with its R multiple), a PENDING
// order (how far the market is from it, and what its stop and target would realise from its own
// price), and a CLOSED trade (how it ended, and how long it was held). Figures in the quote
// currency, with the account-currency figure beside them only where it converts exactly -- the
// same rule as the order card.

export type StatTone = 'up' | 'down' | 'warn' | ''

export interface StatRow {
  label: string
  value: string
  tone?: StatTone
}

export interface PositionStats {
  kind: 'trade' | 'order' | 'closed'
  /** 'Long 10K EURUSD', 'Buy limit 10K EURUSD'. */
  title: string
  side: 'buy' | 'sell'
  /** The open or realised P&L, large, under the title; null for a pending order. */
  headline: { text: string; tone: StatTone } | null
  rows: StatRow[]
}

export type Inspected = { kind: 'trade'; trade: SimTrade } | { kind: 'order'; order: SimOrder }

/** The trade or order `id` names in the snapshot, open, pending or closed. */
export function findInspected(snapshot: SimSnapshot, id: string): Inspected | null {
  const trade = snapshot.trades.find((t) => t.id === id)
  if (trade) return { kind: 'trade', trade }
  const order = snapshot.orders.find((o) => o.id === id && o.status === 'pending')
  return order ? { kind: 'order', order } : null
}

function tone(value: number | null | undefined): StatTone {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return ''
  return value > 0 ? 'up' : 'down'
}

function ticker(key: string): string {
  return key.includes(':') ? key.split(':', 2)[1] : key
}

/** A stop or target as every surface states it: the price, then what the readout beside a level
 * field says about it (levels.ts). */
function level(price: number | null, basis: LevelBasis): string {
  if (price === null) return 'none'
  return [formatPrice(price, basis.ctx.info.precision), ...levelReadout(price, 'price', basis).map((p) => p.text)].join(' · ')
}

/** What a size amounts to -- units and lots, value, margin, pip value -- as the same rows on every
 * surface: the trade box's summary, the order card's details and this popup. Margin above the
 * equity is flagged: the paper engine does not enforce margin, a live account would refuse it. */
export function sizeRows(units: number, ctx: PricingContext): StatRow[] {
  const figures = sizeFigures(units, ctx)
  const rows: StatRow[] = [{ label: 'Size', value: `${formatUnits(units)} units${figures.lots !== null ? ` · ${formatLots(figures.lots)}` : ''}` }]
  if (figures.notionalAccount !== null) rows.push({ label: 'Value', value: formatMoney(figures.notionalAccount, ctx.account.currency, false) })
  if (figures.margin !== null) {
    const over = figures.margin > ctx.account.equity
    rows.push({ label: 'Margin', value: `${formatMoney(figures.margin, ctx.account.currency, false)}${over ? ' · above equity' : ''}`, tone: over ? 'warn' : '' })
  }
  if (figures.pipValue !== null) rows.push({ label: 'Pip value', value: amountText(figures.pipValue, figures.pipValueAccount, ctx, false) })
  return rows
}

/** The note the order was placed with, when it has one. */
function noteRows(label: string | null): StatRow[] {
  return label ? [{ label: 'Note', value: label }] : []
}

export function positionStats(item: Inspected, snapshot: SimSnapshot, info: InstrumentInfo): PositionStats {
  const key = item.kind === 'trade' ? item.trade.symbol : item.order.symbol
  const quote = snapshot.quotes[key]
  const ctx = pricingContext(key, info, snapshot.account, quote, snapshot.quotes)
  const now = quote?.time ?? null
  if (item.kind === 'order') {
    const { order } = item
    const f = orderFigures(order, ctx)
    const orderBasis: LevelBasis = { side: order.side, entry: order.price, units: order.units, ctx }
    const rows: StatRow[] = [
      { label: 'Price', value: formatPrice(order.price, info.precision) },
      { label: 'Market', value: `${formatPrice(f.fill, info.precision)}${f.distance ? ` · ${moveText(f.distance, false)} away` : ''}` },
      { label: 'Stop loss', value: level(order.stopLoss, orderBasis), tone: tone(f.stop?.amount) },
      { label: 'Take profit', value: level(order.takeProfit, orderBasis), tone: tone(f.target?.amount) }
    ]
    if (f.rewardToRisk !== null) rows.push({ label: 'R:R', value: f.rewardToRisk.toFixed(2) })
    rows.push(...sizeRows(order.units, ctx))
    rows.push({ label: 'Placed', value: `${formatInstant(order.createdAt)}${now !== null ? ` · ${formatDuration(now - order.createdAt)} ago` : ''}` })
    rows.push(...noteRows(order.label))
    return {
      kind: 'order',
      title: `${order.side === 'buy' ? 'Buy' : 'Sell'} ${order.type} ${formatUnitsShort(order.units)} ${ticker(key)}`,
      side: order.side,
      headline: null,
      rows
    }
  }

  const { trade } = item
  const title = `${trade.side === 'buy' ? 'Long' : 'Short'} ${formatUnitsShort(trade.units)} ${ticker(key)}`
  if (trade.closedAt !== null) {
    const exit = trade.closePrice !== null ? outcome(trade.side, trade.units, trade.entryPrice, trade.closePrice, ctx) : null
    const pnl = trade.realizedPnl ?? exit?.amount ?? null
    const reason = { stop_loss: 'Stop loss', take_profit: 'Take profit', manual: 'Closed by hand', flatten: 'Flattened' }[trade.closeReason ?? 'manual']
    const rows: StatRow[] = [
      { label: 'Entry', value: formatPrice(trade.entryPrice, info.precision) },
      { label: 'Exit', value: `${formatPrice(trade.closePrice, info.precision)} · ${reason}` },
      { label: 'Move', value: moveText(exit), tone: tone(exit?.move) },
      { label: 'Size', value: `${formatUnits(trade.units)} units` },
      { label: 'Opened', value: formatInstant(trade.openedAt) },
      { label: 'Closed', value: formatInstant(trade.closedAt) },
      { label: 'Held', value: formatDuration(trade.closedAt - trade.openedAt) },
      ...noteRows(trade.label)
    ]
    return {
      kind: 'closed',
      title,
      side: trade.side,
      headline: { text: `${pnl !== null ? formatMoney(pnl, ctx.currencies.quote) : '—'} realised`, tone: tone(pnl) },
      rows
    }
  }

  const f = tradeFigures(trade, ctx)
  const tradeBasis: LevelBasis = { side: trade.side, entry: trade.entryPrice, units: trade.units, ctx }
  const rows: StatRow[] = [
    { label: 'Entry', value: formatPrice(trade.entryPrice, info.precision) },
    { label: 'Mark', value: `${formatPrice(f.mark, info.precision)} (${trade.side === 'buy' ? 'bid' : 'ask'})` },
    { label: 'Move', value: moveText(f.pnl), tone: tone(f.pnl?.move) }
  ]
  if (f.pnl?.ofBalance !== null && f.pnl?.ofBalance !== undefined) {
    rows.push({ label: 'Of balance', value: formatPercent(f.pnl.ofBalance), tone: tone(f.pnl.ofBalance) })
  }
  // Where the trade stands in units of what it risks: +1.0R is a full stop's distance in profit.
  if (f.pnl && f.stop && f.stop.amount < 0) {
    rows.push({ label: 'Now', value: `${(f.pnl.amount / -f.stop.amount).toFixed(2)}R`, tone: tone(f.pnl.amount) })
  }
  rows.push(
    { label: 'Stop loss', value: level(trade.stopLoss, tradeBasis), tone: tone(f.stop?.amount) },
    { label: 'Take profit', value: level(trade.takeProfit, tradeBasis), tone: tone(f.target?.amount) }
  )
  if (f.rewardToRisk !== null) rows.push({ label: 'R:R', value: f.rewardToRisk.toFixed(2) })
  rows.push(...sizeRows(trade.units, ctx))
  rows.push({ label: 'Opened', value: `${formatInstant(trade.openedAt)}${now !== null ? ` · ${formatDuration(now - trade.openedAt)}` : ''}` })
  rows.push(...noteRows(trade.label))
  return {
    kind: 'trade',
    title,
    side: trade.side,
    headline: f.pnl ? { text: amountText(f.pnl.amount, f.pnl.amountAccount, ctx), tone: tone(f.pnl.amount) } : { text: 'no quote yet', tone: '' },
    rows
  }
}
