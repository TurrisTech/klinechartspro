import type { SimOrder, SimTrade } from '../trading/api'
import { advanceTarget } from './timeframes'

// PURE. Advance planning: given the cursor, what the user asked for, the next alert found
// ahead of it and what is working in the account, decide where the walk stops and why, and
// whether a candle may be consumed whole or must be refined. No fetching, no chart, no DOM --
// the session (session.ts) does the walking.

/** `alert`: Next alert reached the instant a client alert triggers at. `watch`: an observer (a
 * price watch) fired during the advance -- discovered while walking, like `fill`. `cancel`:
 * the user stopped it, between two base bars. `none`: Next alert found nothing to go to, and
 * the cursor did not move. See `session.ts`. */
export type StopReason = 'target' | 'alert' | 'fill' | 'watch' | 'cancel' | 'end' | 'none'

/** What the user asked for: N whole candles of an interval, or "to the end of the data". */
export type AdvanceRequest = { interval: string; multiple: number } | { toEnd: true; end: number }

/** Where a client alert next triggers, as the replay's alert book found it
 * (client/alerts/search.ts). */
export interface AlertOccurrence {
  alertId: string
  name: string
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

/** The target instant for a request from `cursor`, on the candle boundary rules. */
export function targetOf(cursor: number, request: AdvanceRequest): number {
  if ('toEnd' in request) return request.end
  return advanceTarget(request.interval, cursor, Math.max(1, Math.floor(request.multiple)))
}

/** Where an advance stops, whichever comes first: the target, or the alert when it is
 * effective strictly after the cursor and at or before the target. (A fill or a watch stop is
 * discovered while walking; see `session.ts`.) */
export function planAdvance(cursor: number, request: AdvanceRequest, alert: AlertOccurrence | null = null): AdvancePlan {
  const target = targetOf(cursor, request)
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
