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

//: Currencies conventionally quoted without minor units, so an amount in them reads as a whole
//: number rather than as `1,250.00`.
const WHOLE_CURRENCIES = new Set(['JPY', 'HUF', 'KRW', 'CLP', 'ISK'])

const moneyFormats = new Map<number, Intl.NumberFormat>()
function moneyFormat(digits: number): Intl.NumberFormat {
  let format = moneyFormats.get(digits)
  if (!format) {
    format = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    moneyFormats.set(digits, format)
  }
  return format
}

/** A signed amount with thousands separators and, when given, its currency:
 * '+1,234.56 USD' / '−1,250 JPY'. */
export function formatMoney(value: number | null | undefined, currency = '', signed = true): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const digits = WHOLE_CURRENCIES.has(currency) ? 0 : 2
  const text = moneyFormat(digits).format(Math.abs(value))
  const zero = Number(text.replace(/,/g, '')) === 0
  const sign = !signed || zero ? '' : value > 0 ? '+' : '−'
  return `${sign}${text}${currency ? ` ${currency}` : ''}`
}

/** Units in the short form a chart label has room for: 250, 10K, 1.5M. */
export function formatUnitsShort(units: number): string {
  const abs = Math.abs(units)
  const trim = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(n < 10 ? 2 : 1).replace(/\.?0+$/, ''))
  if (abs >= 1_000_000) return `${trim(abs / 1_000_000)}M`
  if (abs >= 1_000) return `${trim(abs / 1_000)}K`
  return trim(abs)
}

/** Standard lots, two decimals: '0.10 lot' / '1.50 lots'. */
export function formatLots(lots: number | null): string {
  if (lots === null || !Number.isFinite(lots)) return '—'
  return `${lots.toFixed(2)} ${lots === 1 ? 'lot' : 'lots'}`
}

/** A signed percentage: '+0.42%' / '−1.10%'. */
export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const text = Math.abs(value).toFixed(digits)
  const sign = Number(text) === 0 ? '' : value > 0 ? '+' : '−'
  return `${sign}${text}%`
}

/** A move in pips, or in percent for an instrument not priced in pips. */
export function moveText(outcome: { pips: number | null; percent: number } | null, signed = true): string {
  if (!outcome) return '—'
  if (outcome.pips !== null) {
    return signed ? `${formatPips(outcome.pips)}p` : `${Math.abs(outcome.pips).toFixed(1)}p`
  }
  return signed ? formatPercent(outcome.percent) : `${Math.abs(outcome.percent).toFixed(2)}%`
}

/** How long something has been open, to the two largest units: '3d 4h', '2h 05m', '12m', '45s'. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}
