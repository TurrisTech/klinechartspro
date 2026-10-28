import type { SimOrder, SimTrade } from '../trading/api'
import { type CandleGrid, fromWall, toWall } from './timeframes'

// PURE. Advance planning: given the cursor, what the user asked for, the next alert found
// ahead of it and what is working in the account, decide where the walk stops and why, and
// whether a candle may be consumed whole or must be refined. No fetching, no chart, no DOM --
// the session (session.ts) does the walking.

/** `alert`: Next alert reached the instant a client alert triggers at. `watch`: an observer (a
 * price watch) fired during the advance -- discovered while walking, like `fill`. `cancel`:
 * the user stopped it, between two base bars. `none`: Next alert found nothing to go to, and
 * the cursor did not move. See `session.ts`. */
export type StopReason = 'target' | 'alert' | 'fill' | 'watch' | 'cancel' | 'end' | 'none'

/** What the user asked for: N whole candles of an interval, to an instant (Go to), or "to the
 * end of the data". */
export type AdvanceRequest = { interval: string; multiple: number } | { to: number } | { toEnd: true; end: number }

/** Where a client alert next triggers, as the replay's alert book found it
 * (client/alerts/search.ts). */
export interface AlertOccurrence {
  alertId: string
  name: string
  /** The instrument the alert watches -- any on the Alerts list, not only the one replayed. */
  symbol: string
  /** The bar close it triggers at: the instant the rule's values became knowable. */
  effective: number
  /** What the rule read there, for the stop's notification. */
  readings: string
}

export interface AdvancePlan {
  /** Where the user asked to land. */
  target: number
  /** Where the walk stops: the target, or the alert's effective instant before it. */
  stopAt: number
  reason: 'target' | 'alert'
  alert: AlertOccurrence | null
}

/** The target instant for a request from `cursor`, on the candle boundary rules of the
 * instrument's own schedule (`grid`). */
export function targetOf(cursor: number, request: AdvanceRequest, grid: CandleGrid): number {
  if ('toEnd' in request) return request.end
  if ('to' in request) return Math.max(cursor, request.to)
  return grid.advanceTarget(request.interval, cursor, Math.max(1, Math.floor(request.multiple)))
}

/** Where an advance stops, whichever comes first: the target, or the alert when it is
 * effective strictly after the cursor and at or before the target. (A fill or a watch stop is
 * discovered while walking; see `session.ts`.) */
export function planAdvance(cursor: number, request: AdvanceRequest, grid: CandleGrid, alert: AlertOccurrence | null = null): AdvancePlan {
  const target = targetOf(cursor, request, grid)
  if (alert && alert.effective > cursor && alert.effective <= target) {
    return { target, stopAt: alert.effective, reason: 'alert', alert }
  }
  return { target, stopAt: target, reason: 'target', alert: null }
}

/** A candle's price band on both sides. */
export interface Band {
  bidLow: number
  bidHigh: number
  askLow: number
  askHigh: number
}

/** Whether a candle can interact with anything working: does its band reach a pending
 * limit/stop's trigger, or an open trade's stop loss / take profit -- on the side that
 * matters (a buy triggers on the ask, a long's protection on the bid; sells/shorts the
 * reverse). Pure; the caller decides to descend to a finer timeframe on `true`. */
export function intersectsWorking(band: Band, orders: readonly SimOrder[], trades: readonly SimTrade[], symbol: string): boolean {
  for (const o of orders) {
    if (o.symbol !== symbol || o.status !== 'pending' || o.price === null) continue
    const [lo, hi] = o.side === 'buy' ? [band.askLow, band.askHigh] : [band.bidLow, band.bidHigh]
    if (o.price >= lo && o.price <= hi) return true
  }
  for (const t of trades) {
    if (t.symbol !== symbol || t.closedAt !== null) continue
    const [lo, hi] = t.side === 'buy' ? [band.bidLow, band.bidHigh] : [band.askLow, band.askHigh]
    if (t.stopLoss !== null && t.stopLoss >= lo && t.stopLoss <= hi) return true
    if (t.takeProfit !== null && t.takeProfit >= lo && t.takeProfit <= hi) return true
  }
  return false
}

/** Whether any sequence of bars could produce an event: a pending order (one that rests is
 * always a limit or a stop -- a market order fills on submission), or an open trade carrying
 * a stop loss or a take profit.
 *
 * False means the account cannot change however the price moves, which is what lets an
 * advance SEEK instead of walking (session.ts). The walk exists so that orders resting in
 * the middle of a jump fill; when nothing rests and nothing is protected there is nothing to
 * fill, and feeding tens of thousands of bars to the engine only costs time. It is also the
 * right test for the refinement rule: `intersectsWorking` looks at exactly these. */
export function canFill(orders: readonly SimOrder[], trades: readonly SimTrade[], symbol: string): boolean {
  for (const o of orders) {
    if (o.symbol === symbol && o.status === 'pending' && o.price !== null) return true
  }
  for (const t of trades) {
    if (t.symbol === symbol && t.closedAt === null && (t.stopLoss !== null || t.takeProfit !== null)) return true
  }
  return false
}

// -- Go to --------------------------------------------------------------------------------------

/** Where Go to goes: a time of day on the instrument's own clock, on the next day it trades
 * (`day`), at its next occurrence (`next`), or on a chosen date (`date`). */
export type GoToMode = 'day' | 'next' | 'date'

export interface GoToSpec {
  mode: GoToMode
  /** The time of day, in minutes past midnight on the instrument's clock. */
  minute: number
  /** For `date`: the day, as its midnight on the instrument's wall clock (`toWall`'s scale). */
  day?: number
}

const DAY_MS = 86_400_000

/** Whether the calendar day whose wall-clock midnight is `midnight` is a trading day of the
 * schedule: whether it is open at the middle of the session it dates. For the FX week that is
 * 05:00 New York (the session runs 17:00 the evening before to 17:00), so Monday to Friday trade
 * and Sunday -- open only from 17:00, for Monday's session -- does not; for US equities 12:30; for
 * a continuous schedule every day. Holidays are not modelled, as everywhere here. */
export function isTradingDay(midnight: number, grid: CandleGrid): boolean {
  const { timezone, day } = grid.schedule
  const middle = midnight + ((day.openOffset + day.closeOffset) / 2) * 3_600_000
  return grid.isOpen(fromWall(middle, timezone))
}

/** The instant Go to names from `cursor`, or null when it names none after it (a date at or
 * before the replay's clock). Days are calendar days on the instrument's clock; `next` and
 * `day` skip the days it does not trade.
 *
 *   day    the time on the first trading day after the cursor's own day -- "6am of the next
 *          trading day": from Wednesday 05:05 or Wednesday 20:00, Thursday 06:00; from Friday,
 *          Monday.
 *   next   the first time after the cursor the clock reads it on a trading day -- from
 *          Wednesday 05:05, Wednesday 06:00.
 *   date   the time on the day chosen. */
export function goToInstant(cursor: number, spec: GoToSpec, grid: CandleGrid): number | null {
  const tz = grid.schedule.timezone
  const minute = Math.min(24 * 60 - 1, Math.max(0, Math.floor(spec.minute)))
  const at = (midnight: number): number => fromWall(midnight + minute * 60_000, tz)
  if (spec.mode === 'date') {
    if (spec.day === undefined) return null
    const target = at(floorDay(spec.day))
    return target > cursor ? target : null
  }
  const today = floorDay(toWall(cursor, tz))
  // A fortnight: the longest run of non-trading days any schedule here has is a weekend.
  for (let d = spec.mode === 'day' ? 1 : 0; d <= 14; d++) {
    const midnight = today + d * DAY_MS
    if (!isTradingDay(midnight, grid)) continue
    const target = at(midnight)
    if (target > cursor) return target
  }
  return null
}

/** `at` moved onto the base's grid: itself when a base candle opens there or nothing trades
 * then, otherwise the close of the base candle it falls inside. Later, never earlier -- the
 * walk moves in whole base bars, and a cursor left inside one would let the next advance fill
 * against price action from before it. */
export function onBaseBoundary(at: number, base: string, grid: CandleGrid): number {
  const open = grid.start(base, at)
  if (open === at) return at
  const close = grid.end(base, open)
  return close > at ? close : at
}

function floorDay(wall: number): number {
  return Math.floor(wall / DAY_MS) * DAY_MS
}
