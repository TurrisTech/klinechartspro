import type { KLineData } from 'klinecharts'

// The wire contract of wdashboard-server's OHLCV app, mirroring the Pydantic models in
// `wdashboard_server/services/schemas.py` field for field. Timestamps are always integer
// Unix epoch milliseconds.

export type ErrorCode =
  | 'invalid_request'
  | 'unsupported'
  | 'not_found'
  | 'too_large'
  | 'rate_limited'
  | 'internal'

export type UpdatesMode = 'closed' | 'all'

export interface ErrorBody {
  code: ErrorCode
  detail: string
  field?: string | null
  limit?: number | null
  actual?: number | null
}

export interface OHLCVBar {
  date: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

// `/getbars` answers a range that matched nothing with this sentinel rather than `[]` —
// `[]` never appears on the wire, so an empty array in this client always means "we chose
// to return nothing", never "the server said so".
export interface NoDataResponse {
  s: 'no_data'
}

export type GetBarsResponse = OHLCVBar[] | NoDataResponse

export function isNoData(body: unknown): body is NoDataResponse {
  return typeof body === 'object' && body !== null && (body as NoDataResponse).s === 'no_data'
}

export function isErrorBody(body: unknown): body is ErrorBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as ErrorBody).code === 'string' &&
    typeof (body as ErrorBody).detail === 'string'
  )
}

// --- WS /stream frames --------------------------------------------------------

export interface StreamSubscribed {
  type: 'subscribed'
  vendor: string
  symbol: string
  interval: string
  updates: UpdatesMode
  // False => this interval can never emit a `closed: false` bar. Native intervals (1m) are
  // stored only on close; only derived intervals aggregate a forming bar.
  formingSupported: boolean
  serverTime: number
}

export interface StreamUnsubscribed {
  type: 'unsubscribed'
  vendor: string
  symbol: string
  interval: string
}

// Sent exactly once per accepted subscribe — always, even when `backfill: 0` was asked for.
export interface StreamBackfill {
  type: 'backfill'
  vendor: string
  symbol: string
  interval: string
  bars: OHLCVBar[]
}

export interface StreamBar {
  type: 'bar'
  vendor: string
  symbol: string
  interval: string
  closed: boolean
  bar: OHLCVBar
}

export interface StreamPong {
  type: 'pong'
  id?: string | null
  serverTime: number
}

// Non-fatal: the offending action is not performed, the connection stays open.
export interface StreamError {
  type: 'error'
  code: ErrorCode
  errmsg: string
  vendor?: string | null
  symbol?: string | null
  interval?: string | null
}

export type StreamServerMessage =
  | StreamSubscribed
  | StreamUnsubscribed
  | StreamBackfill
  | StreamBar
  | StreamPong
  | StreamError

export type StreamClientMessage =
  | {
      action: 'subscribe'
      vendor: string
      symbol: string
      interval: string
      updates?: UpdatesMode
      backfill?: number
    }
  | { action: 'unsubscribe'; vendor: string; symbol: string; interval: string }
  | { action: 'ping'; id?: string }

export function barToKLineData(bar: OHLCVBar): KLineData {
  return {
    timestamp: bar.date,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume
  }
}
