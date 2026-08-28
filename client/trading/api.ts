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

export interface SimOrder {
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

export interface SimTrade {
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
  kind: 'fill' | 'close' | 'cancel' | 'reject'
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

export interface OrderRequest {
  symbol: string
  side: SimSide
  type: SimOrderType
  units: number
  price?: number
  stopLoss?: number
  takeProfit?: number
  label?: string
}

export interface OrderPatch {
  price?: number
  stopLoss?: number | null
  takeProfit?: number | null
}

export interface TradePatch {
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
