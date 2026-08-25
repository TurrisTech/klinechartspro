import type { SymbolInfo } from '../../src'
import { symbolVendor } from '../symbols'
import type { SimSide, SimTrade } from './api'

// Small pure helpers shared by the panel, the ticket and the overlays.

/** The engine's instrument key for a pane's symbol: `vendor:TICKER`. */
export function symbolKey(symbol: SymbolInfo): string {
  return `${symbolVendor(symbol)}:${symbol.ticker}`
}

export function formatPrice(price: number | null | undefined, precision: number): string {
  if (price === null || price === undefined || !Number.isFinite(price)) return '—'
  return price.toFixed(precision)
}

/** P&L with a sign, two decimals: '+12.30' / '−4.00'. */
export function formatPnl(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  return `${sign}${Math.abs(value).toFixed(2)}`
}

export function formatUnits(units: number): string {
  return Number.isInteger(units) ? String(units) : units.toFixed(2)
}

const timeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

/** An instant on the market's clock, the timezone every chart on the wall uses. */
export function formatInstant(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  return timeFormat.format(new Date(ms))
}

/** A trade's mark-to-market against a quote: a long exits on the bid, a short on the ask. */
export function tradePnl(trade: SimTrade, quote: { bid: number; ask: number } | undefined): number | null {
  if (!quote) return null
  const exit = trade.side === 'buy' ? quote.bid : quote.ask
  const delta = trade.side === 'buy' ? exit - trade.entryPrice : trade.entryPrice - exit
  return delta * trade.units
}

/** A price move expressed in pips: `delta / pipSize`. Null when the instrument is not priced
 * in pips (non-forex). */
export function toPips(priceDelta: number, pipSize: number | null): number | null {
  if (pipSize === null || pipSize === 0) return null
  return priceDelta / pipSize
}

/** A pip distance to a price, from an anchor and the direction it applies. `awayBelow` true
 * puts the result below the anchor (a long's stop / a short's target). */
export function pipsToPrice(anchor: number, pips: number, pipSize: number, awayBelow: boolean): number {
  const off = pips * pipSize
  return awayBelow ? anchor - off : anchor + off
}

export function formatPips(pips: number | null | undefined): string {
  if (pips === null || pips === undefined || !Number.isFinite(pips)) return '—'
  const sign = pips > 0 ? '+' : pips < 0 ? '−' : ''
  return `${sign}${Math.abs(pips).toFixed(1)}`
}

/** A trade's open P&L in pips (side-aware), or null for a non-pip instrument. */
export function tradePips(
  trade: SimTrade,
  quote: { bid: number; ask: number } | undefined,
  pipSize: number | null
): number | null {
  if (!quote || pipSize === null) return null
  const exit = trade.side === 'buy' ? quote.bid : quote.ask
  const delta = trade.side === 'buy' ? exit - trade.entryPrice : trade.entryPrice - exit
  return delta / pipSize
}

export function sideLabel(side: SimSide): string {
  return side === 'buy' ? 'Buy' : 'Sell'
}
