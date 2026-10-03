import type { SimOrderType, SimQuote, SimSide, SimTrade } from './api'
import { formatMoney, formatPercent, formatPrice, moveText } from './format'
import type { InstrumentInfo } from './instrument'
import {
  closingPrice,
  fillingPrice,
  floorUnits,
  levelForBalancePercent,
  outcome,
  type PricingContext,
  protectionValid,
  quoteToAccountRate,
  restingPriceValid,
  roundTo
} from './metrics'
import type { ProtectMode } from './prefs'

// How a stop, a target or a resting price is STATED and READ BACK, in one place for every
// surface that edits one -- the trade box, the order card on the pane, and the position popup.
// PURE (levels.test.ts). The surfaces used to state the same level three different ways (pips in
// the ticket, a bare price on the card, a sentence in the popup); they now all call this.
//
// A level is stated in one of three units, the shared `protectMode` preference:
//
// - PIPS: the distance from the position's entry (a trade's fill, an order's price, the draft's
//   entry), always positive -- which side it lies on follows from the side and the role;
// - PRICE: the level itself;
// - PERCENT: the share of the balance the position loses (a stop) or makes (a target) there, at
//   its size -- which needs a size and a conversion to the account currency.
//
// Whatever it is stated in, the READOUT beside it gives the others, so every surface shows the
// same four facts about a level: its price, its distance, what it realises, and its share of the
// balance.

export type LevelRole = 'stop' | 'target'

/** What a level is measured from and for whom. */
export interface LevelBasis {
  side: SimSide
  /** A trade's entry, an order's price, the draft's entry; null while there is none. */
  entry: number | null
  /** The position's size; null while unknown (a risk-sized draft without its stop). */
  units: number | null
  ctx: PricingContext
}

/** Whether `role` lies below the entry for `side`: a long's stop, a short's target. */
export function lies(side: SimSide, role: LevelRole): 'below' | 'above' {
  return (role === 'stop') === (side === 'buy') ? 'below' : 'above'
}

/** An amount in the quote currency, then -- only where it differs and converts exactly -- the
 * account-currency figure: '−20.00 USD', '−2,950 JPY ≈ −20.00 USD'. */
export function amountText(amount: number | null, accountAmount: number | null, ctx: PricingContext, signed = true): string {
  if (amount === null) return '—'
  const quote = ctx.currencies.quote
  const main = formatMoney(amount, quote, signed)
  if (quote === ctx.account.currency || accountAmount === null) return main
  return `${main} ≈ ${formatMoney(accountAmount, ctx.account.currency, signed)}`
}

/** Why `mode` cannot state a level for this instrument and position, or null when it can. */
export function levelModeRefusal(mode: ProtectMode, ctx: PricingContext, sizedByStop = false): string | null {
  if (mode === 'pips' && ctx.info.pipSize === null) return 'This instrument is not priced in pips'
  if (mode === 'percent') {
    if (sizedByStop) return 'Sizing by risk already fixes the loss: state the stop in pips or price'
    if (quoteToAccountRate(ctx) === null) return `No ${ctx.account.currency} rate for ${ctx.currencies.quote}`
  }
  return null
}

/** `mode`, or the nearest one this instrument and position allow. */
export function usableMode(mode: ProtectMode, ctx: PricingContext, sizedByStop = false): ProtectMode {
  if (levelModeRefusal(mode, ctx, sizedByStop) === null) return mode
  return ctx.info.pipSize !== null ? 'pips' : 'price'
}

/** A level as a field states it. Falls back to the price where the unit cannot be worked out
 * (no entry for a distance, no size for a share of the balance). */
export function levelText(price: number, mode: ProtectMode, basis: LevelBasis): string {
  const { ctx, entry, units } = basis
  const info = ctx.info
  if (mode === 'price' || entry === null) return formatPrice(price, info.precision)
  if (mode === 'pips' && info.pipSize !== null) return (Math.abs(price - entry) / info.pipSize).toFixed(1)
  if (mode === 'percent' && units) {
    const o = outcome(basis.side, units, entry, price, ctx)
    if (o.ofBalance !== null) return Math.abs(o.ofBalance).toFixed(2)
  }
  return formatPrice(price, info.precision)
}

/** A field's text to a price; '' is no level (null). Throws a sentence when the text cannot
 * become one. */
export function parseLevel(raw: string, mode: ProtectMode, role: LevelRole, basis: LevelBasis): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  const name = role === 'stop' ? 'stop loss' : 'take profit'
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`)
  const { ctx, entry, units } = basis
  const info = ctx.info
  if (mode === 'price') return value
  if (entry === null) throw new Error(`No price to measure the ${name} from yet`)
  if (mode === 'pips' && info.pipSize !== null) {
    const off = value * info.pipSize
    return roundTo(lies(basis.side, role) === 'below' ? entry - off : entry + off, info.precision)
  }
  if (units === null || units <= 0) throw new Error(`A ${name} in % of balance needs a size`)
  const level = levelForBalancePercent(basis.side, role, units, entry, value, ctx)
  if (level === null) throw new Error(`No ${ctx.account.currency} rate for ${ctx.currencies.quote}, so % of balance cannot be priced`)
  return level
}

/** One step of a price for this instrument: a pip, or its last decimal. */
export function priceStep(info: InstrumentInfo): number {
  return info.pipSize ?? 10 ** -info.precision
}

/** The field's text a step on. Up makes the NUMBER in the field bigger -- a stop in pips further
 * away, a price higher -- and `big` is ten steps. An empty field starts at ten pips (or ten price
 * steps) from the entry, which is a level to adjust rather than to keep. */
export function stepLevelText(text: string, mode: ProtectMode, role: LevelRole, direction: 1 | -1, big: boolean, basis: LevelBasis): string {
  const info = basis.ctx.info
  const n = Number(text.trim())
  if (text.trim() === '' || !Number.isFinite(n)) {
    if (basis.entry === null) return text
    const off = 10 * priceStep(info)
    const start = lies(basis.side, role) === 'below' ? basis.entry - off : basis.entry + off
    if (!(start > 0)) return text
    return levelText(roundTo(start, info.precision), mode, basis)
  }
  if (mode === 'pips') return Math.max(0.1, n + direction * (big ? 10 : 1)).toFixed(1)
  if (mode === 'percent') return Math.max(0.01, n + direction * (big ? 1 : 0.1)).toFixed(2)
  const step = priceStep(info) * (big ? 10 : 1)
  const next = roundTo(n + direction * step, info.precision)
  return next > 0 ? formatPrice(next, info.precision) : text
}

export type ReadoutTone = 'up' | 'down' | 'warn' | ''

export interface ReadoutPart {
  text: string
  tone: ReadoutTone
}

/** What a level realises, for the readout beside its field: every one of price, distance,
 * amount and share of the balance that the field does not already state. */
export function levelReadout(price: number, mode: ProtectMode, basis: LevelBasis): ReadoutPart[] {
  const { ctx, entry, units } = basis
  const parts: ReadoutPart[] = []
  if (mode !== 'price') parts.push({ text: formatPrice(price, ctx.info.precision), tone: '' })
  if (entry === null) return parts
  const o = outcome(basis.side, units ?? 0, entry, price, ctx)
  const tone: ReadoutTone = o.move > 0 ? 'up' : o.move < 0 ? 'down' : ''
  if (mode !== 'pips' || ctx.info.pipSize === null) parts.push({ text: moveText(o), tone })
  if (units) {
    parts.push({ text: amountText(o.amount, o.amountAccount, ctx), tone })
    if (mode !== 'percent' && o.ofBalance !== null) parts.push({ text: formatPercent(o.ofBalance), tone })
  }
  return parts
}

/** Why a stop or target at `price` would be refused against `reference` (an open trade's closing
 * side, an order's own price, the draft's entry), or null. */
export function levelRefusal(side: SimSide, role: LevelRole, price: number, reference: number | null, where: string): string | null {
  if (reference === null || protectionValid(side, role, price, reference)) return null
  return `The ${role === 'stop' ? 'stop loss' : 'take profit'} must be ${lies(side, role)} ${where}`
}

// -- resting orders ------------------------------------------------------------------------------

/** Why a resting price would be refused -- a limit on the far side of the market, a stop beyond
 * it -- or null. */
export function restingRefusal(side: SimSide, type: SimOrderType, price: number, quote: SimQuote | undefined, precision: number): string | null {
  if (type === 'market' || !quote || restingPriceValid(side, type, price, quote)) return null
  const fill = fillingPrice(side, quote)
  const below = (type === 'limit') === (side === 'buy')
  return `A ${side} ${type} must be ${below ? 'below' : 'above'} the ${side === 'buy' ? 'ask' : 'bid'} (${formatPrice(fill, precision)})`
}

/** A starting price for a limit or stop being written: on the side it rests on, ten pips (or a
 * quarter of a percent) clear of the market and never inside three spreads, so it is valid the
 * moment it appears and is drawn where it can be dragged from. */
export function defaultRestingPrice(side: SimSide, type: SimOrderType, quote: SimQuote | undefined, info: InstrumentInfo): number | null {
  const fill = fillingPrice(side, quote)
  if (fill === null || !quote || type === 'market') return null
  const spread = quote.ask - quote.bid
  const offset = Math.max(info.pipSize !== null ? 10 * info.pipSize : fill * 0.0025, 3 * spread)
  const below = (type === 'limit') === (side === 'buy')
  const price = roundTo(below ? fill - offset : fill + offset, info.precision)
  return price > 0 ? price : null
}

/** How far a resting price is from where it would fill, in words: '13.3p below the ask'. */
export function restingDistance(side: SimSide, price: number, quote: SimQuote | undefined, info: InstrumentInfo): string | null {
  const fill = fillingPrice(side, quote)
  if (fill === null) return null
  const off = price - fill
  const size = Math.abs(off)
  const text = moveText({ pips: info.pipSize ? size / info.pipSize : null, percent: fill > 0 ? (size / fill) * 100 : 0 }, false)
  const where = side === 'buy' ? 'ask' : 'bid'
  return off === 0 ? `at the ${where}` : `${text} ${off < 0 ? 'below' : 'above'} the ${where}`
}

// -- ending a trade ------------------------------------------------------------------------------

export const CLOSE_FRACTIONS = [0.25, 0.5, 0.75, 1] as const

/** The units a fraction of a trade closes, floored to the instrument's unit precision; null
 * when that is nothing. A fraction that rounds to the whole trade is the whole trade. */
export function fractionUnits(units: number, fraction: number, ctx: PricingContext): number | null {
  if (fraction >= 1) return units
  const part = floorUnits(units * fraction, ctx)
  if (!(part > 0)) return null
  return part >= units ? units : part
}

/** The order that reverses a trade: the other side at market, the same size, and the trade's stop
 * and target carried over at the same distances from the new fill -- each dropped when the engine
 * would refuse it there. Null without a quote. */
export function reverseOrder(
  trade: SimTrade,
  quote: SimQuote | undefined,
  precision: number
): { side: SimSide; units: number; fill: number; stopLoss?: number; takeProfit?: number } | null {
  const side: SimSide = trade.side === 'buy' ? 'sell' : 'buy'
  const fill = fillingPrice(side, quote)
  if (fill === null || closingPrice(trade.side, quote) === null) return null
  const mirror = (level: number | null, role: LevelRole): number | undefined => {
    if (level === null) return undefined
    const distance = Math.abs(trade.entryPrice - level)
    if (!(distance > 0)) return undefined
    const price = roundTo(lies(side, role) === 'below' ? fill - distance : fill + distance, precision)
    return price > 0 && protectionValid(side, role, price, fill) ? price : undefined
  }
  return { side, units: trade.units, fill, stopLoss: mirror(trade.stopLoss, 'stop'), takeProfit: mirror(trade.takeProfit, 'target') }
}
