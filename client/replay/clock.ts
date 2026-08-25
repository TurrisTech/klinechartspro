import type { SimOrder, SimTrade } from '../trading/api'
import { advanceTarget } from './timeframes'

// PURE. Advance planning: given the cursor, what the user asked for, the armed signals'
// next occurrences and what is working in the account, decide where the walk stops and
// why, and whether a candle may be consumed whole or must be refined. No fetching, no
// chart, no DOM -- the session (session.ts) does the walking.

export type StopReason = 'target' | 'signal' | 'fill' | 'end'

/** What the user asked for: N whole candles of an interval, or "to the end of the data". */
export type AdvanceRequest = { interval: string; multiple: number } | { toEnd: true; end: number }

/** One armed signal's next occurrence, as the signal book reports it. */
export interface SignalOccurrence {
  ref: string
  resolution: string
  /** The absolute instant the signal became knowable (its bar's close). */
  effective: number
  /** The bar it sits on (wire date), for the panel to scroll to. */
  date: number
}

export interface AdvancePlan {
  /** Where the user asked to land. */
  target: number
  /** Where the walk stops: the target, or an armed signal's effective instant before it. */
  stopAt: number
  reason: 'target' | 'signal'
  signal: SignalOccurrence | null
}

/** The target instant for a request from `cursor`, on the candle boundary rules. */
export function targetOf(cursor: number, request: AdvanceRequest): number {
  if ('toEnd' in request) return request.end
  return advanceTarget(request.interval, cursor, Math.max(1, Math.floor(request.multiple)))
}

/** Where an advance stops, whichever comes first: the target, or the earliest armed signal
 * effective strictly after the cursor and at or before the target -- an intervening signal
 * wins over the requested target. (A fill stop is discovered while walking; see
 * `session.ts`.) */
export function planAdvance(cursor: number, request: AdvanceRequest, armed: readonly SignalOccurrence[]): AdvancePlan {
  const target = targetOf(cursor, request)
  let best: SignalOccurrence | null = null
  for (const s of armed) {
    if (s.effective <= cursor || s.effective > target) continue
    if (best === null || s.effective < best.effective) best = s
  }
  if (best) return { target, stopAt: best.effective, reason: 'signal', signal: best }
  return { target, stopAt: target, reason: 'target', signal: null }
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

/** Whether anything is working on `symbol` at all -- when nothing is, no candle needs
 * refining and the walk consumes base bars whole. */
export function hasWorking(orders: readonly SimOrder[], trades: readonly SimTrade[], symbol: string): boolean {
  return orders.some((o) => o.symbol === symbol && o.status === 'pending') || trades.some((t) => t.symbol === symbol && t.closedAt === null)
}
