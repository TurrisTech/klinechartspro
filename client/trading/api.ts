import { apiSend } from '../config'
import { ownerHeaders } from '../owner'

// The `/sim` wire (wdashboard-server wdashboard_server/sim/api.py), the paper-trading route
// set. Every mutating call answers with the whole session snapshot plus the engine events it
// produced, so the client replaces its copy rather than reconciling deltas.

export type SimSide = 'buy' | 'sell'
export type SimOrderType = 'market' | 'limit' | 'stop'

export interface SimQuote {
  time: number
  bid: number
  ask: number
}

/** A trailing stop (wdashboard-server sim/engine.py `TrailingStop`): the stop loss follows the
 * best closing-side price at `distance`, from the fill or once `activation` in profit, moving only
 * by at least `step`. Every figure is a PRICE distance. `best` is a trade's, null until priced. */
export interface SimTrailingStop {
  distance: number
  activation: number | null
  step: number | null
  best: number | null
}

/** Move the stop to the entry, `offset` beyond it in the trade's favour, the first time the
 * closing side is `trigger` in profit (`done` once it has). Price distances. */
export interface SimBreakeven {
  trigger: number
  offset: number
  done: boolean
}

/** A signed price distance from the entry on the closing side (> 0 in profit) worth a
 * notification the first time a price reaches it. `reachedAt`/`price` are a trade's. */
export interface SimMilestone {
  distance: number
  label: string | null
  reachedAt: number | null
  price: number | null
}

/** Exit management an order carries to its trade. Optional on the wire: a server before
 * 0.58.0, and a replay saved before it, have none. */
export interface SimManagement {
  trailingStop?: SimTrailingStop | null
  breakeven?: SimBreakeven | null
  milestones?: SimMilestone[]
}

export interface SimOrder extends SimManagement {
  id: string
  symbol: string
  side: SimSide
  type: SimOrderType
  units: number
  price: number | null
  stopLoss: number | null
  takeProfit: number | null
  status: 'pending' | 'filled' | 'cancelled' | 'rejected'
  createdAt: number
  filledAt: number | null
  fillPrice: number | null
  tradeId: string | null
  label: string | null
}

export interface SimTrade extends SimManagement {
  id: string
  symbol: string
  side: SimSide
  units: number
  entryPrice: number
  openedAt: number
  orderId: string
  stopLoss: number | null
  takeProfit: number | null
  closedAt: number | null
  closePrice: number | null
  closeReason: 'manual' | 'stop_loss' | 'take_profit' | 'flatten' | null
  realizedPnl: number | null
  label: string | null
  /** What placed the current stop loss when it was not the user: the trail or the breakeven. */
  stopMovedBy?: 'trail' | 'breakeven' | null
}

export interface SimAccount {
  currency: string
  initialBalance: number
  balance: number
  unrealizedPnl: number
  equity: number
}

export interface SimSnapshot {
  id: string
  mode: 'paper' | 'replay'
  name: string
  createdAt: number
  rev: number
  account: SimAccount
  quotes: Record<string, SimQuote>
  orders: SimOrder[]
  trades: SimTrade[]
  symbols: string[]
  /** A replay session's client-owned state document (`PUT /sim/sessions/{id}/state`). */
  state?: unknown
}

export interface SimEvent {
  /** `milestone`: a trade reached one -- `price` is its level, `reason` its label. */
  kind: 'fill' | 'close' | 'cancel' | 'reject' | 'milestone'
  time: number
  orderId: string | null
  tradeId: string | null
  price: number | null
  reason: string | null
}

export interface SimAnswer {
  session: SimSnapshot
  events: SimEvent[]
  order?: SimOrder
  trade?: SimTrade
}

/** Exit management as a request states it: price distances, the engine's state left out. */
export interface TrailRequest {
  distance: number
  activation?: number | null
  step?: number | null
}

export interface BreakevenRequest {
  trigger: number
  offset?: number
}

export interface MilestoneRequest {
  distance: number
  label?: string | null
}

export interface OrderRequest {
  symbol: string
  side: SimSide
  type: SimOrderType
  units: number
  price?: number
  stopLoss?: number
  takeProfit?: number
  label?: string
  trailingStop?: TrailRequest
  breakeven?: BreakevenRequest
  milestones?: MilestoneRequest[]
}

/** Absent leaves a field alone; null removes it (null or [] the milestones). */
export interface ManagementPatch {
  trailingStop?: TrailRequest | null
  breakeven?: BreakevenRequest | null
  milestones?: MilestoneRequest[] | null
}

export interface OrderPatch extends ManagementPatch {
  price?: number
  stopLoss?: number | null
  takeProfit?: number | null
}

export interface TradePatch extends ManagementPatch {
  stopLoss?: number | null
  takeProfit?: number | null
}


async function call<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  path: string,
  body?: unknown
): Promise<T> {
  const { data } = await apiSend<T>(method, path, { body, headers: ownerHeaders() })
  return data
}

export const simApi = {
  list: () => call<{ sessions: SimSnapshot[] }>('GET', '/sim/sessions').then((r) => r.sessions),
  create: (body: { mode: 'paper' | 'replay'; name?: string; balance?: number; currency?: string; symbol?: string }) =>
    call<SimAnswer>('POST', '/sim/sessions', body),
  putState: (id: string, rev: number, state: unknown) =>
    call<SimAnswer>('PUT', `/sim/sessions/${id}/state`, { rev, state }),
  get: (id: string, symbol?: string) =>
    call<SimAnswer>(
      'GET',
      `/sim/sessions/${id}${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`
    ),
  remove: (id: string) => call<void>('DELETE', `/sim/sessions/${id}`),
  watch: (id: string, symbol: string) =>
    call<SimAnswer>('POST', `/sim/sessions/${id}/watch`, { symbol }),
  placeOrder: (id: string, body: OrderRequest) =>
    call<SimAnswer>('POST', `/sim/sessions/${id}/orders`, body),
  patchOrder: (id: string, orderId: string, body: OrderPatch) =>
    call<SimAnswer>('PATCH', `/sim/sessions/${id}/orders/${orderId}`, body),
  cancelOrder: (id: string, orderId: string) =>
    call<SimAnswer>('DELETE', `/sim/sessions/${id}/orders/${orderId}`),
  patchTrade: (id: string, tradeId: string, body: TradePatch) =>
    call<SimAnswer>('PATCH', `/sim/sessions/${id}/trades/${tradeId}`, body),
  closeTrade: (id: string, tradeId: string, units?: number) =>
    call<SimAnswer>('POST', `/sim/sessions/${id}/trades/${tradeId}/close`, units ? { units } : {}),
  flatten: (id: string, symbol?: string) =>
    call<SimAnswer>('POST', `/sim/sessions/${id}/flatten`, symbol ? { symbol } : {})
}
