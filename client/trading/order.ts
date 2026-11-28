import type { BreakevenRequest, MilestoneRequest, OrderRequest, SimOrderType, SimQuote, SimSide, TrailRequest } from './api'
import {
  type AtrReading,
  type ExitBasis,
  type ExitUnit,
  exitText,
  milestoneValues,
  parseBreakeven,
  parseDistance,
  parseMilestones,
  parseTrail,
  usableExitUnit
} from './exits'
import { formatPrice } from './format'
import type { InstrumentInfo } from './instrument'
import { type LevelBasis, type LevelRole, levelRefusal, parseLevel, type ReadoutPart, restingRefusal, usableMode } from './levels'
import type { DraftOrder } from './lines'
import {
  fillingPrice,
  levelForBalancePercent,
  outcome,
  type PricingContext,
  quoteToAccountRate,
  rewardToRisk,
  roundTo,
  sizeFigures,
  targetForReward,
  unitsForMarginPercent,
  unitsForNotional,
  unitsForRisk,
  unitsForRiskAmount
} from './metrics'
import { type ProtectMode, type SizeMode, sizedByStop, type TradePrefs } from './prefs'
import { sizeRows, type StatRow } from './stats'

// The order the trade box is writing, PLANNED: the ticket's fields as typed -- side, type, a
// price, a size given one of six ways, a stop and a target in pips, price or % of balance, a
// trail, a breakeven and the milestones -- turned into the order request the engine would get,
// its derived figures, and why it cannot be sent yet. PURE (order.test.ts): no DOM, no session.
// The ticket (ticket.ts) is the view over it; it reads what is typed, asks here, and draws the
// answer, so the numbers an order is sent with are tested without a trade box.
//
// The plan resolves in a fixed order, because each step needs the one before:
//
// - the ENTRY: a limit's or stop's own price, else the side the order fills on;
// - the SIZE: from the stop when sizing by risk (% or amount), which therefore resolves first and
//   without a size; otherwise from units, lots, value or margin, and then the stop;
// - the TARGET, at that size; the stop and target are then checked against the entry;
// - the EXITS last, measured from the entry with R as the stop's distance.
//
// A problem is kept by the field it belongs to (`Slot`), first one per field, so the ticket can
// say it under that field; `problem` is the first of them in the order the ticket is laid out.

export const LOT = 100_000

/** Where a problem is shown: under the field it belongs to, or at the bottom ('general'). */
export type Slot = 'general' | 'price' | 'size' | 'stop' | 'target' | 'trail' | 'breakeven' | 'notify'
export type ExitRole = 'trail' | 'breakeven' | 'notify'
export const EXIT_PREF: Record<ExitRole, 'trailUnit' | 'breakevenUnit' | 'notifyUnit'> = { trail: 'trailUnit', breakeven: 'breakevenUnit', notify: 'notifyUnit' }

/** The fields top to bottom: the first problem is the one the ticket names, and the field it
 * takes the focus to. */
const PROBLEM_ORDER: readonly Slot[] = ['general', 'price', 'size', 'stop', 'target', 'trail', 'breakeven', 'notify']

/** Each way of sizing: the unit after the number, the preference it reads, its cap, and a step
 * (the big step is ten of them). */
export interface SizeSpec {
  unit: (currency: string) => string
  pref: keyof TradePrefs
  max?: number
  step: (info: InstrumentInfo) => number
  digits: number
}

export const SIZE_SPECS: Record<SizeMode, SizeSpec> = {
  units: { unit: () => 'units', pref: 'units', step: (i) => (i.assetClass === 'forex' ? 1000 : 10 ** -i.unitsPrecision), digits: 5 },
  lots: { unit: () => 'lots', pref: 'lots', step: () => 0.01, digits: 2 },
  risk: { unit: () => '% risk', pref: 'riskPercent', max: 100, step: () => 0.25, digits: 2 },
  riskAmount: { unit: (c) => `${c} risk`, pref: 'riskAmount', step: () => 10, digits: 2 },
  notional: { unit: (c) => `${c} value`, pref: 'notional', step: () => 1000, digits: 2 },
  margin: { unit: () => '% margin', pref: 'marginPercent', max: 100, step: () => 0.5, digits: 2 }
}

/** What the ticket holds, as typed. Exit management is each field's text in its own unit
 * (prefs.ts): a trail's distance, start and step; a breakeven's trigger and lock; the
 * milestones' list. */
export interface OrderFields {
  side: SimSide
  type: SimOrderType
  price: string
  stopLoss: string
  takeProfit: string
  trail: { distance: string; start: string; step: string }
  breakeven: { trigger: string; lock: string }
  notify: string
  note: string
}

/** What an order is planned against: its instrument, quote and pricing, the stored choices,
 * whether the session has loaded, and the active pane's ATR (null without enough bars). */
export interface OrderMarket {
  info: InstrumentInfo
  quote: SimQuote | undefined
  ctx: PricingContext
  prefs: TradePrefs
  ready: boolean
  atr: AtrReading | null
}

export interface OrderPlan {
  units: number | null
  entry: number | null
  price: number | undefined
  stop: number | undefined
  target: number | undefined
  trail: TrailRequest | undefined
  breakeven: BreakevenRequest | undefined
  milestones: MilestoneRequest[]
  /** Why it cannot be sent, by the field that is wrong. */
  problems: Partial<Record<Slot, string>>
  /** The first of them; null when it can be sent. */
  problem: string | null
  ctx: PricingContext
  /** What its exits were measured against: the entry, R (the stop's distance) and the ATR. */
  exits: ExitBasis
}

// -- ways of sizing and of stating a level ----------------------------------------------------

/** Why a way of sizing is not open to this instrument, or null when it is. */
export function sizeRefusal(mode: SizeMode, info: InstrumentInfo): string | null {
  if (mode === 'lots' && info.assetClass !== 'forex') return 'Lots are a forex convention'
  if (mode === 'margin' && info.marginRate === null) return 'No margin rate for this instrument'
  return null
}

/** The stored way of sizing, or units where this instrument does not allow it. */
export function usableSizeMode(prefs: TradePrefs, info: InstrumentInfo): SizeMode {
  return sizeRefusal(prefs.sizeMode, info) === null ? prefs.sizeMode : 'units'
}

/** The stored unit for stops and targets, or the nearest one this instrument and size allow. */
export function protectModeFor(prefs: TradePrefs, ctx: PricingContext): ProtectMode {
  return usableMode(prefs.protectMode, ctx, sizedByStop(usableSizeMode(prefs, ctx.info)))
}

/** The stored unit for an exit, or the nearest one this position allows. */
export function exitUnitFor(role: ExitRole, prefs: TradePrefs, basis: ExitBasis): ExitUnit {
  return usableExitUnit(prefs[EXIT_PREF[role]], basis)
}

/** What a stop or target is stated against: the side, the entry, the size. */
export function levelBasis(side: SimSide, plan: Pick<OrderPlan, 'entry' | 'units' | 'ctx'>): LevelBasis {
  return { side, entry: plan.entry, units: plan.units, ctx: plan.ctx }
}

/** What an exit's distances are measured against: the entry, R (the stop's distance) and the ATR. */
export function exitBasis(side: SimSide, entry: number | null, stop: number | undefined, atr: AtrReading | null, info: InstrumentInfo): ExitBasis {
  const risk = entry !== null && stop !== undefined ? Math.abs(entry - stop) : null
  return { side, entry, risk: risk && risk > 0 ? risk : null, atr, info }
}

// -- the plan -----------------------------------------------------------------------------------

/** The order the fields state, priced against `market`, and everything that stops it being sent. */
export function planOrder(fields: OrderFields, market: OrderMarket): OrderPlan {
  const { info, quote, ctx, prefs } = market
  const { side, type } = fields
  const problems: OrderPlan['problems'] = {}
  const fail = (slot: Slot, problem: string): void => {
    problems[slot] ??= problem
  }

  if (!quote) fail('general', market.ready ? 'No quote yet' : 'Connecting…')
  let price: number | undefined
  if (type !== 'market') {
    const typed = Number(fields.price)
    if (fields.price.trim() === '' || !Number.isFinite(typed) || typed <= 0) {
      fail('price', `A ${type} order needs a price`)
    } else {
      price = typed
      const refusal = restingRefusal(side, type, typed, quote, info.precision)
      if (refusal) fail('price', refusal)
    }
  }
  const entry = price ?? fillingPrice(side, quote)

  const mode = usableSizeMode(prefs, info)
  const protect = protectModeFor(prefs, ctx)
  const level = (role: LevelRole, units: number | null): number | undefined => {
    try {
      return parseLevel(role === 'stop' ? fields.stopLoss : fields.takeProfit, protect, role, { side, entry, units, ctx }) ?? undefined
    } catch (err) {
      fail(role, err instanceof Error ? err.message : `Invalid ${role}`)
      return undefined
    }
  }
  const noRate = `No ${ctx.account.currency} rate for ${ctx.currencies.quote}: size another way`
  let units: number | null = null
  let stop: number | undefined
  if (sizedByStop(mode)) {
    // The stop decides the size, so it resolves first, without one.
    stop = level('stop', null)
    if (stop === undefined) {
      if (!problems.stop) fail('size', 'Sizing by risk needs a stop loss')
    } else if (entry !== null) {
      if (quoteToAccountRate(ctx) === null) fail('size', noRate)
      else {
        const sized = mode === 'risk' ? unitsForRisk(prefs.riskPercent, entry, stop, ctx) : unitsForRiskAmount(prefs.riskAmount, entry, stop, ctx)
        if (sized === null || sized <= 0) fail('size', 'The risk is too small for a single unit at that stop')
        else units = sized
      }
    }
  } else {
    let sized: number | null
    if (mode === 'units') sized = prefs.units
    else if (mode === 'lots') sized = Math.round(prefs.lots * LOT * 10 ** info.unitsPrecision) / 10 ** info.unitsPrecision
    else if (mode === 'notional') sized = unitsForNotional(prefs.notional, ctx)
    else sized = unitsForMarginPercent(prefs.marginPercent, ctx)
    if (sized === null) {
      if (quote) fail('size', noRate)
    } else if (sized <= 0) fail('size', 'Too small for a single unit')
    else units = sized
    stop = level('stop', units)
  }
  const target = level('target', units)

  if (entry !== null) {
    const where = type === 'market' ? `the ${side === 'buy' ? 'ask' : 'bid'}` : 'the order price'
    if (stop !== undefined) {
      const refusal = levelRefusal(side, 'stop', stop, entry, where)
      if (refusal) fail('stop', refusal)
    }
    if (target !== undefined) {
      const refusal = levelRefusal(side, 'target', target, entry, where)
      if (refusal) fail('target', refusal)
    }
  }
  // Exit management, measured from the entry with R as the stop's distance.
  const exits = exitBasis(side, entry, stop, market.atr, info)
  const exit = <T>(slot: ExitRole, parse: () => T): T | undefined => {
    try {
      return parse()
    } catch (err) {
      fail(slot, err instanceof Error ? err.message : 'Invalid')
      return undefined
    }
  }
  const trail = exit('trail', () => parseTrail(fields.trail, exitUnitFor('trail', prefs, exits), exits)) ?? undefined
  const breakeven = exit('breakeven', () => parseBreakeven(fields.breakeven, exitUnitFor('breakeven', prefs, exits), exits)) ?? undefined
  const milestones = exit('notify', () => parseMilestones(fields.notify, exitUnitFor('notify', prefs, exits), exits)) ?? []

  const problem = PROBLEM_ORDER.map((slot) => problems[slot]).find((p) => p !== undefined) ?? null
  return { units, entry, price, stop, target, trail, breakeven, milestones, problems, problem, ctx, exits }
}

/** The field the first problem belongs to -- where Enter on a plan that cannot be sent takes the
 * focus -- or null when there is none. */
export function problemSlot(problems: OrderPlan['problems']): Slot | null {
  return PROBLEM_ORDER.find((slot) => problems[slot]) ?? null
}

/** A plan that can be sent: nothing wrong with it, and a size. */
export type SendablePlan = OrderPlan & { units: number }

/** Why the plan cannot be sent, or null when it can. */
export function sendRefusal(plan: OrderPlan): string | null {
  if (plan.problem || plan.units === null || plan.units <= 0) return plan.problem ?? 'Nothing to send'
  return null
}

export function isSendable(plan: OrderPlan): plan is SendablePlan {
  return sendRefusal(plan) === null
}

/** The request that places the plan: its own figures, and the side, type and note as typed. */
export function orderRequest(symbol: string, fields: OrderFields, plan: SendablePlan): OrderRequest {
  return {
    symbol,
    side: fields.side,
    type: fields.type,
    units: plan.units,
    price: plan.price,
    stopLoss: plan.stop,
    takeProfit: plan.target,
    label: fields.note.trim() || undefined,
    trailingStop: plan.trail,
    breakeven: plan.breakeven,
    milestones: plan.milestones.length > 0 ? plan.milestones : undefined
  }
}

/** The plan as the chart draws it, or null while it has no entry. */
export function draftOf(symbol: string, fields: OrderFields, plan: OrderPlan, prefs: TradePrefs): DraftOrder | null {
  if (plan.entry === null) return null
  return {
    symbol,
    side: fields.side,
    type: fields.type,
    units: plan.units,
    entry: plan.entry,
    stop: plan.stop ?? null,
    target: plan.target ?? null,
    problem: plan.problem,
    riskPercent: riskPercentOf(prefs, plan)
  }
}

/** The figures of the order as it would be sent: the same rows the card and the popup show for a
 * working order, and its R:R once it has both a stop and a target. */
export function planFigures(side: SimSide, plan: OrderPlan): StatRow[] {
  const { units, entry, stop, target, ctx } = plan
  const rows: StatRow[] = units !== null ? sizeRows(units, ctx) : []
  if (units !== null && entry !== null && stop !== undefined && target !== undefined) {
    const rr = rewardToRisk(outcome(side, units, entry, stop, ctx), outcome(side, units, entry, target, ctx))
    if (rr !== null) rows.push({ label: 'R:R', value: rr.toFixed(2) })
  }
  return rows
}

// -- the price ----------------------------------------------------------------------------------

/** Why the typed resting price would not do -- none, or one the engine would refuse -- or null. */
export function restingProblem(fields: OrderFields, quote: SimQuote | undefined, precision: number): string | null {
  const price = Number(fields.price)
  if (fields.price.trim() === '' || !(price > 0)) return 'no price'
  return restingRefusal(fields.side, fields.type, price, quote, precision)
}

/** The entry dragged to `price`: a buy below the ask waits for the price to come down (limit),
 * above it for the price to break up (stop), a sell the mirror, and at the market it is a market
 * order again. Null without a quote. */
export function entryAt(side: SimSide, price: number, quote: SimQuote | undefined, info: InstrumentInfo): { type: SimOrderType; price: string } | null {
  const fill = fillingPrice(side, quote)
  if (fill === null) return null
  const rounded = roundTo(price, info.precision)
  const below = rounded < fill
  const type: SimOrderType = rounded === fill ? 'market' : side === 'buy' ? (below ? 'limit' : 'stop') : below ? 'stop' : 'limit'
  return { type, price: type === 'market' ? '' : formatPrice(rounded, info.precision) }
}

// -- the size -----------------------------------------------------------------------------------

/** A typed size, or null when it is not one this way of sizing takes. */
export function enteredSize(text: string, mode: SizeMode): number | null {
  const spec = SIZE_SPECS[mode]
  const n = Number(text)
  return n > 0 && n <= (spec.max ?? Number.POSITIVE_INFINITY) ? n : null
}

/** The stored size one step on, snapped to the step's grid so 10,250 steps to 11,000 and back to
 * 10,000 rather than drifting; null where that leaves nothing or passes the cap. */
export function steppedSize(mode: SizeMode, prefs: TradePrefs, info: InstrumentInfo, direction: 1 | -1, big: boolean): number | null {
  const spec = SIZE_SPECS[mode]
  const step = spec.step(info) * (big ? 10 : 1)
  const current = Number(prefs[spec.pref])
  const snapped = direction > 0 ? Math.floor(current / step + 1e-9) * step + step : Math.ceil(current / step - 1e-9) * step - step
  const next = Number(snapped.toFixed(spec.digits))
  if (!(next > 0) || next > (spec.max ?? Number.POSITIVE_INFINITY)) return null
  return next
}

/** The share of the balance the order risks, when its size comes from the stop; the draft
 * carries it so the chart re-sizes rather than re-prices when the stop moves. */
export function riskPercentOf(prefs: TradePrefs, plan: OrderPlan): number | null {
  const mode = usableSizeMode(prefs, plan.ctx.info)
  if (mode === 'risk') return prefs.riskPercent
  if (mode === 'riskAmount' && plan.ctx.account.balance > 0) return (prefs.riskAmount / plan.ctx.account.balance) * 100
  return null
}

/** `plan`'s size stated as `mode` would state it, or null where that cannot be worked out (a
 * risk with no stop, a value with no conversion). */
export function sizeAs(mode: SizeMode, side: SimSide, plan: OrderPlan): number | null {
  const units = plan.units
  if (units === null || plan.entry === null) return null
  const size = sizeFigures(units, plan.ctx)
  const balance = plan.ctx.account.balance
  const risk = plan.stop !== undefined ? outcome(side, units, plan.entry, plan.stop, plan.ctx) : null
  const loss = risk?.amountAccount !== null && risk?.amountAccount !== undefined && risk.amountAccount < 0 ? -risk.amountAccount : null
  let value: number | null = null
  if (mode === 'units') value = units
  else if (mode === 'lots') value = units / LOT
  else if (mode === 'risk') value = loss !== null && balance > 0 ? (loss / balance) * 100 : null
  else if (mode === 'riskAmount') value = loss
  else if (mode === 'notional') value = size.notionalAccount
  else value = size.margin !== null && balance > 0 ? (size.margin / balance) * 100 : null
  if (value === null || !(value > 0)) return null
  return Number(value.toFixed(mode === 'lots' || mode === 'units' ? 5 : 2))
}

// -- presets --------------------------------------------------------------------------------------

/** Why "Risk N%" cannot place the stop now, or null. */
export function riskStopRefusal(prefs: TradePrefs, plan: OrderPlan): string | null {
  if (sizedByStop(usableSizeMode(prefs, plan.ctx.info))) return 'the size already comes from the risk'
  if (plan.entry === null || plan.units === null) return 'no size yet'
  if (quoteToAccountRate(plan.ctx) === null) return `no ${plan.ctx.account.currency} rate for ${plan.ctx.currencies.quote}`
  return null
}

/** Where "Risk N%" puts the stop: where the planned size loses `prefs.riskPercent` of the
 * balance. Null where it cannot (`riskStopRefusal`), or there is no such price. */
export function riskStopLevel(side: SimSide, prefs: TradePrefs, plan: OrderPlan): number | null {
  if (riskStopRefusal(prefs, plan) !== null || plan.entry === null || plan.units === null) return null
  return levelForBalancePercent(side, 'stop', plan.units, plan.entry, prefs.riskPercent, plan.ctx)
}

/** Why the 1R/2R/3R targets cannot be set now, or null. */
export function ratioRefusal(side: SimSide, plan: OrderPlan): string | null {
  if (plan.entry === null || plan.stop === undefined) return 'set a stop loss first'
  return targetForReward(side, plan.entry, plan.stop, 1, plan.ctx.info.precision) === null ? 'the stop is past the entry' : null
}

/** The target `ratio` times the stop's distance from the entry, or null without one. */
export function targetAt(side: SimSide, plan: OrderPlan, ratio: number): number | null {
  if (plan.entry === null || plan.stop === undefined) return null
  return targetForReward(side, plan.entry, plan.stop, ratio, plan.ctx.info.precision)
}

/** Whether the target is at `ratio` times the stop's distance: the preset is lit. */
export function atRatio(side: SimSide, plan: OrderPlan, ratio: number): boolean {
  return ratioRefusal(side, plan) === null && plan.target !== undefined && targetAt(side, plan, ratio) === plan.target
}

/** The trail presets: at 1R (the stop's distance), and at twice the ATR. */
export function trailPresetDistance(i: number, basis: ExitBasis): number | null {
  return i === 0 ? basis.risk : basis.atr !== null ? 2 * basis.atr.value : null
}

/** Whether the trail is at preset `i`: the preset is lit. */
export function atTrailPreset(i: number, plan: OrderPlan): boolean {
  const distance = trailPresetDistance(i, plan.exits)
  return distance !== null && plan.trail !== undefined && Math.abs(plan.trail.distance - distance) <= Math.max(distance * 1e-6, (plan.exits.info.pipSize ?? 0) * 0.05)
}

/** A multiple of R stated in the notify unit, as the number the milestone list holds; null
 * without a stop. */
export function notifyValue(multiple: number, unit: ExitUnit, basis: ExitBasis): number | null {
  if (basis.risk === null) return null
  const text = exitText(multiple * basis.risk, unit, basis)
  return text === '' ? null : Number(text)
}

/** A breakeven whose lock is no tighter than the stop already set would never move it: said,
 * not refused (the engine accepts it and does nothing). */
export function breakevenWarning(side: SimSide, plan: OrderPlan): ReadoutPart[] {
  if (!plan.breakeven || plan.entry === null || plan.stop === undefined) return []
  const d = side === 'buy' ? 1 : -1
  const level = plan.entry + d * (plan.breakeven.offset ?? 0)
  return (level - plan.stop) * d <= 0 ? [{ text: 'the stop is already past it', tone: 'warn' }] : []
}

// -- restating exits ------------------------------------------------------------------------------

/** An exit field's text restated from one unit to another -- the same distance, the new way. Text
 * that is not a distance in `from` is kept as it is. */
export function restateDistance(text: string, from: ExitUnit, to: ExitUnit, basis: ExitBasis, allow: { zero?: boolean; negative?: boolean } = {}): string {
  try {
    const distance = parseDistance(text, from, basis, 'it', allow)
    if (distance === null) return text
    return distance < 0 ? `-${exitText(-distance, to, basis)}` : exitText(distance, to, basis)
  } catch {
    return text
  }
}

/** A milestone list restated from one unit to another, or as it is while any of it is not a
 * non-zero number. */
export function restateMilestones(text: string, from: ExitUnit, to: ExitUnit, basis: ExitBasis): string {
  const values = milestoneValues(text)
  if (!values.every((v) => Number.isFinite(v) && v !== 0)) return text
  return values.map((v) => restateDistance(String(v), from, to, basis, { negative: true })).join(', ')
}
