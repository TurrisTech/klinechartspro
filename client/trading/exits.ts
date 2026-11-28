import type {
  BreakevenRequest,
  MilestoneRequest,
  SimBreakeven,
  SimEvent,
  SimMilestone,
  SimOrder,
  SimSide,
  SimTrade,
  SimTrailingStop,
  TrailRequest
} from './api'
import { formatPrice, formatUnitsShort } from './format'
import type { InstrumentInfo } from './instrument'
import type { ReadoutPart } from './levels'
import type { ExitUnit } from './prefs'
import { tickerOf } from '../symbols'

export type { ExitUnit }

// EXIT MANAGEMENT as the trade box, the order card and the popup state it (user, 2026-11-15: "in
// the Trade box, alongside Take profit, allow several options for a trailing stop. also have
// options to notify when price goes a certain multiple (or multiples) from entry"). PURE
// (exits.test.ts).
//
// The engine (wdashboard-server sim/engine.py, and its port client/sim/engine.ts) knows three
// things, every figure a PRICE distance:
//
// - a TRAILING STOP: the stop follows the best closing-side price at a distance, from the fill or
//   once it is some way in profit (`activation`), moving only by at least a `step`;
// - an AUTO-BREAKEVEN: the stop goes to the entry, plus a `lock`, once the trade is `trigger` in
//   profit;
// - MILESTONES: distances from the entry worth a notification the first time a price reaches one.
//
// The "several options" are how a distance is STATED, and are the same five for all three: pips;
// a price difference; a percentage of the price; a multiple of the active chart's ATR(14); or a
// multiple of R, the stop loss's distance from the entry. Whatever the unit, it becomes a price
// distance when the order is sent, so a trail stated as 2 × ATR is 2 × the ATR when it was placed,
// not a figure that changes as the ATR does (the engine runs on the server, on ticks, with no bars).
// The readout beside each field says what it comes to.

export const EXIT_UNITS: Array<[ExitUnit, string]> = [
  ['pips', 'pips'],
  ['price', 'price'],
  ['percent', '% price'],
  ['atr', '× ATR'],
  ['r', 'R']
]

/** The ATR a distance in `atr` units is a multiple of: its value (a price distance), its period
 * and the timeframe it was read on (a pane's period text, `1H`). */
export interface AtrReading {
  value: number
  period: number
  interval: string
}

/** What a distance is measured against. */
export interface ExitBasis {
  side: SimSide
  /** A trade's entry, an order's price, the draft's entry; null while there is none. */
  entry: number | null
  /** One R: the stop loss's distance from the entry, as a price; null without a stop. */
  risk: number | null
  atr: AtrReading | null
  info: InstrumentInfo
}

/** Why `unit` cannot state a distance for this position, or null when it can. */
export function exitUnitRefusal(unit: ExitUnit, basis: ExitBasis): string | null {
  if (unit === 'pips' && basis.info.pipSize === null) return 'This instrument is not priced in pips'
  if (unit === 'percent' && basis.entry === null) return 'No price yet'
  if (unit === 'atr' && basis.atr === null) return 'No ATR: the active chart has too few bars'
  if (unit === 'r' && !(basis.risk !== null && basis.risk > 0)) return 'R is the stop loss distance: set a stop loss first'
  return null
}

/** `unit`, or the nearest one this position allows: pips, else a price difference. */
export function usableExitUnit(unit: ExitUnit, basis: ExitBasis): ExitUnit {
  if (exitUnitRefusal(unit, basis) === null) return unit
  return basis.info.pipSize !== null ? 'pips' : 'price'
}

/** The price distance one `unit` is, or null where it cannot be worked out. */
export function unitSize(unit: ExitUnit, basis: ExitBasis): number | null {
  if (unit === 'pips') return basis.info.pipSize
  if (unit === 'price') return 1
  if (unit === 'percent') return basis.entry !== null ? basis.entry / 100 : null
  if (unit === 'atr') return basis.atr?.value ?? null
  return basis.risk !== null && basis.risk > 0 ? basis.risk : null
}

/** Decimals a number in `unit` is written with. */
function unitDigits(unit: ExitUnit, info: InstrumentInfo): number {
  if (unit === 'pips') return 1
  if (unit === 'price') return info.precision
  if (unit === 'percent') return 3
  return 2
}

/** A number for a field: at most `digits` decimals, no trailing zeros. */
function tidy(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)))
}

/** A price distance as a field in `unit` states it; '' where the unit cannot. */
export function exitText(distance: number, unit: ExitUnit, basis: ExitBasis): string {
  const size = unitSize(unit, basis)
  if (size === null || !(size > 0)) return ''
  const value = distance / size
  return unit === 'pips' ? value.toFixed(1) : tidy(value, unitDigits(unit, basis.info))
}

/** A field's number in `unit` to a price distance; '' is null. Throws a sentence when the text is
 * not a number this field takes. */
export function parseDistance(raw: string, unit: ExitUnit, basis: ExitBasis, what: string, allow: { zero?: boolean; negative?: boolean } = {}): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed.replace('−', '-'))
  if (!Number.isFinite(value)) throw new Error(`${what}: not a number`)
  if (value < 0 && !allow.negative) throw new Error(`${what} must be positive`)
  if (value === 0 && !allow.zero) throw new Error(`${what} must be more than zero`)
  const refusal = exitUnitRefusal(unit, basis)
  if (refusal) throw new Error(refusal)
  return value * (unitSize(unit, basis) as number)
}

/** One step of a field in `unit`; `big` is ten. */
function exitStep(unit: ExitUnit, info: InstrumentInfo, big: boolean): number {
  const one = unit === 'pips' ? 1 : unit === 'price' ? (info.pipSize ?? 10 ** -info.precision) : unit === 'percent' ? 0.01 : unit === 'atr' ? 0.25 : 0.25
  return one * (big ? 10 : 1)
}

/** The field's text a step on. An empty field starts at `start` (in the unit). */
export function stepExitText(text: string, unit: ExitUnit, info: InstrumentInfo, direction: 1 | -1, big: boolean, start: number, min = 0): string {
  const n = Number(text.trim())
  const digits = unitDigits(unit, info)
  if (text.trim() === '' || !Number.isFinite(n)) return unit === 'pips' ? start.toFixed(1) : tidy(start, digits)
  const step = exitStep(unit, info, big)
  const next = Math.max(min, Math.round((n + direction * step) / step) * step)
  if (next <= 0 && min > 0) return text
  return unit === 'pips' ? next.toFixed(1) : tidy(next, digits)
}

/** Where a field in `unit` starts when stepped from empty: ten pips (or price steps), 0.1%, two ATR
 * or one R. */
export function defaultExit(unit: ExitUnit, info: InstrumentInfo): number {
  if (unit === 'pips') return 10
  if (unit === 'price') return 10 * (info.pipSize ?? 10 ** -info.precision)
  if (unit === 'percent') return 0.1
  if (unit === 'atr') return 2
  return 1
}

/** A price distance in words: pips where the instrument has them, else the price difference. */
export function distanceWords(distance: number, info: InstrumentInfo): string {
  if (info.pipSize !== null) return `${(distance / info.pipSize).toFixed(1)}p`
  return formatPrice(distance, info.precision)
}

// -- the three fields --------------------------------------------------------------------------

interface TrailFields {
  /** Behind the best price. */
  distance: string
  /** In profit before it trails; '' from the fill. */
  start: string
  /** The least the stop moves by; '' any gain. */
  step: string
}

/** The trail the fields state, or null for none. Throws a sentence. */
export function parseTrail(fields: TrailFields, unit: ExitUnit, basis: ExitBasis): TrailRequest | null {
  const distance = parseDistance(fields.distance, unit, basis, 'The trailing distance')
  if (distance === null) return null
  const activation = parseDistance(fields.start, unit, basis, 'Where the trail starts', { zero: true })
  const step = parseDistance(fields.step, unit, basis, 'The trail step')
  return { distance, activation, step }
}

interface BreakevenFields {
  /** In profit before the stop moves to the entry. */
  trigger: string
  /** Beyond the entry, in the trade's favour; '' is the entry itself. */
  lock: string
}

/** The breakeven the fields state, or null for none. Throws a sentence. */
export function parseBreakeven(fields: BreakevenFields, unit: ExitUnit, basis: ExitBasis): BreakevenRequest | null {
  const trigger = parseDistance(fields.trigger, unit, basis, 'The breakeven trigger')
  if (trigger === null) return null
  const offset = parseDistance(fields.lock, unit, basis, 'The amount locked in', { zero: true, negative: true }) ?? 0
  if (offset >= trigger) throw new Error('The amount locked in must be less than the trigger')
  return { trigger, offset }
}

/** The numbers in a milestone field: `1, 2, 3`, `-0.5 1` (commas, spaces or semicolons). */
export function milestoneValues(text: string): number[] {
  return text
    .split(/[,;\s]+/)
    .map((part) => part.trim().replace('−', '-'))
    .filter((part) => part !== '')
    .map(Number)
}

/** A milestone's label: the number as stated, signed, with its unit -- what the notification says
 * ("reached +2R"). */
export function milestoneLabel(value: number, unit: ExitUnit, info: InstrumentInfo): string {
  const sign = value > 0 ? '+' : '−'
  const abs = Math.abs(value)
  const number = unit === 'pips' ? abs.toFixed(1) : tidy(abs, unitDigits(unit, info))
  if (unit === 'pips') return `${sign}${number}p`
  if (unit === 'percent') return `${sign}${number}%`
  if (unit === 'atr') return `${sign}${number} ATR`
  if (unit === 'r') return `${sign}${number}R`
  return `${sign}${number}`
}

/** The number a milestone's label states when it was written in `unit` (`+2R` in R, `−10.0p` in
 * pips), else null -- so a working trade's list reads as the user wrote it, not as its distance
 * over an R measured from a fill a little away from where the ticket priced it. */
export function labelValue(label: string | null, unit: ExitUnit): number | null {
  if (!label) return null
  const suffix = { r: 'R', pips: 'p', percent: '%', atr: ' ATR', price: '' }[unit]
  const m = /^([+−-])(\d+(?:\.\d+)?)(.*)$/.exec(label)
  if (!m || m[3] !== suffix) return null
  const value = Number(m[2])
  return m[1] === '+' ? value : -value
}

/** The milestones the field states, each labelled. Throws a sentence. */
export function parseMilestones(text: string, unit: ExitUnit, basis: ExitBasis): MilestoneRequest[] {
  const values = milestoneValues(text)
  if (values.length === 0) return []
  if (values.some((v) => !Number.isFinite(v))) throw new Error('Notify at: numbers, separated by commas')
  if (values.some((v) => v === 0)) throw new Error('Notify at: zero is the entry itself')
  const refusal = exitUnitRefusal(unit, basis)
  if (refusal) throw new Error(refusal)
  const size = unitSize(unit, basis) as number
  const unique = [...new Set(values)].sort((a, b) => a - b)
  return unique.map((value) => ({ distance: value * size, label: milestoneLabel(value, unit, basis.info) }))
}

/** The field's text with `value` added, or taken out when it is there: what a preset chip does. */
export function toggleMilestone(text: string, value: number): string {
  const values = milestoneValues(text).filter((v) => Number.isFinite(v))
  const next = values.includes(value) ? values.filter((v) => v !== value) : [...values, value]
  return [...new Set(next)].sort((a, b) => a - b).join(', ')
}

// -- readouts -------------------------------------------------------------------------------------

/** What a trail comes to: its distance in pips (when stated otherwise), where the stop goes --
 * now, or the price at which the trail takes over (where it starts, or where it passes a tighter
 * stop loss already set) -- and its step. `mark` is the closing side for an order that fills now
 * (a market order, an open trade); null for one that rests. `stop` is the stop loss it works
 * beside, if any. */
export function trailReadout(trail: TrailRequest, unit: ExitUnit, basis: ExitBasis, mark: number | null, stop: number | null = null): ReadoutPart[] {
  const { info } = basis
  const parts: ReadoutPart[] = []
  if (unit !== 'pips' || info.pipSize === null) parts.push({ text: distanceWords(trail.distance, info), tone: '' })
  const d = basis.side === 'buy' ? 1 : -1
  // The best price from which the trail sets the stop: past its start, and past where it beats the
  // stop already there.
  const starts = trail.activation !== null && trail.activation !== undefined && basis.entry !== null ? basis.entry + d * trail.activation : null
  const overtakes = stop !== null ? stop + d * trail.distance : null
  const candidates = [starts, overtakes].filter((x): x is number => x !== null)
  const from = candidates.length ? candidates.reduce((a, b) => ((b - a) * d > 0 ? b : a)) : null
  if (from !== null && (mark === null || (mark - from) * d < 0)) {
    parts.push({ text: `${from === overtakes && from !== starts ? 'takes over' : 'from'} ${formatPrice(from, info.precision)}`, tone: '' })
  } else if (mark !== null) {
    parts.push({ text: `stop ${formatPrice(mark - d * trail.distance, info.precision)} now`, tone: '' })
  } else {
    parts.push({ text: 'from the fill', tone: '' })
  }
  if (trail.step) parts.push({ text: `steps ${distanceWords(trail.step, info)}`, tone: '' })
  return parts
}

/** Where the breakeven fires and where it puts the stop. */
export function breakevenReadout(be: BreakevenRequest, basis: ExitBasis): ReadoutPart[] {
  const { info, entry } = basis
  if (entry === null) return []
  const d = basis.side === 'buy' ? 1 : -1
  const offset = be.offset ?? 0
  const lock = offset === 0 ? 'the entry' : `${offset > 0 ? '+' : '−'}${distanceWords(Math.abs(offset), info)}`
  return [
    { text: `at ${formatPrice(entry + d * be.trigger, info.precision)}`, tone: '' },
    { text: `stop to ${lock}`, tone: offset > 0 ? 'up' : '' }
  ]
}

/** The price of each milestone, in order. */
export function milestonesReadout(milestones: readonly MilestoneRequest[], basis: ExitBasis): ReadoutPart[] {
  const { entry, info } = basis
  if (entry === null) return []
  const d = basis.side === 'buy' ? 1 : -1
  return milestones.map((m) => ({ text: formatPrice(entry + d * m.distance, info.precision), tone: m.distance > 0 ? 'up' : 'down' }))
}

// -- a working order's or trade's management, in words ----------------------------------------------

interface ManagementLine {
  label: string
  value: string
  title?: string
}

/** One row each for a trail, a breakeven and the milestones a working order or trade carries: the
 * order card's and the popup's rows. */
export function managementRows(record: SimTrade | SimOrder, info: InstrumentInfo): ManagementLine[] {
  const rows: ManagementLine[] = []
  const trail = record.trailingStop
  if (trail) rows.push({ label: 'Trailing', value: trailWords(trail, info), title: trailTitle(trail, info) })
  const be = record.breakeven
  if (be) rows.push({ label: 'Breakeven', value: breakevenWords(be, info), title: be.done ? 'Done: the stop has been moved (or was already past it)' : undefined })
  const milestones = record.milestones ?? []
  if (milestones.length > 0) rows.push({ label: 'Notify at', value: milestones.map((m) => milestoneWords(m, info)).join(' · '), title: 'A notification the first time the price reaches each; ✓ once it has' })
  return rows
}

export function trailWords(trail: SimTrailingStop | TrailRequest, info: InstrumentInfo): string {
  const parts = [distanceWords(trail.distance, info)]
  if (trail.activation !== null && trail.activation !== undefined) parts.push(`from +${distanceWords(trail.activation, info)}`)
  if (trail.step) parts.push(`steps ${distanceWords(trail.step, info)}`)
  return parts.join(' · ')
}

function trailTitle(trail: SimTrailingStop, info: InstrumentInfo): string {
  const best = 'best' in trail && trail.best !== null ? ` The best price so far is ${formatPrice(trail.best, info.precision)}.` : ''
  return `The stop follows the best price ${distanceWords(trail.distance, info)} behind it, and only ever tightens.${best}`
}

export function breakevenWords(be: SimBreakeven | BreakevenRequest, info: InstrumentInfo): string {
  const offset = be.offset ?? 0
  const lock = offset === 0 ? '' : ` ${offset > 0 ? '+' : '−'}${distanceWords(Math.abs(offset), info)}`
  const done = 'done' in be && be.done ? ' ✓' : ''
  return `at +${distanceWords(be.trigger, info)}${lock}${done}`
}

function milestoneWords(m: SimMilestone, info: InstrumentInfo): string {
  const name = m.label ?? `${m.distance > 0 ? '+' : '−'}${distanceWords(Math.abs(m.distance), info)}`
  return m.reachedAt !== null ? `${name} ✓` : name
}

/** A trade's or order's management as the requests that restate it, for a change that keeps the
 * rest (the card's fields edit one of the three). */
export function managementOf(record: SimTrade | SimOrder): { trailingStop: TrailRequest | null; breakeven: BreakevenRequest | null; milestones: MilestoneRequest[] } {
  const t = record.trailingStop
  const b = record.breakeven
  return {
    trailingStop: t ? { distance: t.distance, activation: t.activation, step: t.step } : null,
    breakeven: b ? { trigger: b.trigger, offset: b.offset } : null,
    milestones: (record.milestones ?? []).map((m) => ({ distance: m.distance, label: m.label }))
  }
}

/** Why a trade closed, in words -- the one naming of a close every surface uses (History, the
 * popup, the card's announcement): a stop the trail or the breakeven placed says so. `asEvent`
 * words a level as what happened, "Stop loss hit", for an announcement of the close. */
export function closeReasonWords(trade: Pick<SimTrade, 'closeReason' | 'stopMovedBy'>, asEvent = false): string {
  if (trade.closeReason === 'stop_loss' || trade.closeReason === 'take_profit') {
    const level =
      trade.closeReason === 'take_profit'
        ? 'Take profit'
        : trade.stopMovedBy === 'trail'
          ? 'Trailing stop'
          : trade.stopMovedBy === 'breakeven'
            ? 'Breakeven stop'
            : 'Stop loss'
    return asEvent ? `${level} hit` : level
  }
  if (trade.closeReason === 'flatten') return 'Flattened'
  return 'Closed by hand'
}

/** The short name a stop's label on the chart carries: TSL while a trail moves it, BE once the
 * breakeven has put it at the entry, else SL. */
export function stopName(record: Pick<SimTrade, 'trailingStop'> & Partial<Pick<SimTrade, 'stopMovedBy'>>): string {
  if (record.trailingStop) return 'TSL'
  return record.stopMovedBy === 'breakeven' ? 'BE' : 'SL'
}

/** A milestone reached, in words: the card's flash and a replay's notification. */
export function milestoneNotice(trade: SimTrade, event: SimEvent, info: InstrumentInfo): { title: string; body: string } {
  const ticker = tickerOf(trade.symbol)
  const side = trade.side === 'buy' ? 'long' : 'short'
  const level = event.price ?? trade.entryPrice
  const move = trade.side === 'buy' ? level - trade.entryPrice : trade.entryPrice - level
  const name = event.reason ?? `${move >= 0 ? '+' : '−'}${distanceWords(Math.abs(move), info)}`
  const pnl = move * trade.units
  const money = `${pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(2)}`
  return {
    title: `${ticker} ${side} ${formatUnitsShort(trade.units)} reached ${name}`,
    body: `At ${formatPrice(level, info.precision)} (entry ${formatPrice(trade.entryPrice, info.precision)}) · ${move >= 0 ? '+' : '−'}${distanceWords(Math.abs(move), info)} · ${money}`
  }
}

/** One R for a working position: the stop loss's distance from the entry WHEN IT WAS PLACED -- the
 * order's own stop -- so a trailed stop does not shrink it. Without one, the trail's distance (a
 * trail from the fill is the first stop), then the stop it has now. */
export function initialRisk(record: SimTrade | SimOrder, orders: readonly SimOrder[]): number | null {
  const positive = (x: number | null): number | null => (x !== null && x > 0 ? x : null)
  if ('entryPrice' in record) {
    const order = orders.find((o) => o.id === record.orderId)
    if (order?.stopLoss !== null && order?.stopLoss !== undefined) return positive(Math.abs(record.entryPrice - order.stopLoss))
    const trail = order?.trailingStop ?? record.trailingStop
    if (trail && (trail.activation === null || trail.activation === undefined)) return trail.distance
    return record.stopLoss !== null ? positive(Math.abs(record.entryPrice - record.stopLoss)) : null
  }
  if (record.price !== null && record.stopLoss !== null) return positive(Math.abs(record.price - record.stopLoss))
  const trail = record.trailingStop
  return trail && (trail.activation === null || trail.activation === undefined) ? trail.distance : null
}

// -- ATR -------------------------------------------------------------------------------------------

const ATR_PERIOD = 14
/** The closed bars an ATR is read over. */
const ATR_BARS = 200

/** A chart's ATR(14) over its closed bars (the last one is still forming, live or in a replay), as
 * the "× ATR" unit reads it; null with too few. */
export function atrReading(bars: ReadonlyArray<{ high: number; low: number; close: number }>, interval: string): AtrReading | null {
  const value = wilderAtr(bars.slice(-(ATR_BARS + 1), -1), ATR_PERIOD)
  return value === null ? null : { value, period: ATR_PERIOD, interval }
}

/** Wilder's ATR over `bars`, oldest first: the last value, or null with fewer than `period` + 1
 * bars. The first true range has no previous close and is skipped, as TA-Lib skips it. */
export function wilderAtr(bars: ReadonlyArray<{ high: number; low: number; close: number }>, period = 14): number | null {
  if (bars.length < period + 1) return null
  let atr = 0
  for (let i = 1; i <= period; i++) atr += trueRange(bars[i], bars[i - 1].close)
  atr /= period
  for (let i = period + 1; i < bars.length; i++) atr = (atr * (period - 1) + trueRange(bars[i], bars[i - 1].close)) / period
  return Number.isFinite(atr) && atr > 0 ? atr : null
}

function trueRange(bar: { high: number; low: number }, previousClose: number): number {
  return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose))
}
