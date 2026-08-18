import type { KLineData } from 'klinecharts'
import type { IndicatorPoint, SeriesDoc } from './indicators/api'

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
  // False => this interval can emit no `closed: false` bar, so the candle for the period in
  // progress will not appear until it closes. Where the server has a tick source (the
  // `stream.forming` capability) every interval forms live, 1m to 1Y alike; without one, the
  // intervals it stores natively (1m, 1D) can only be relayed on close.
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

// Server-computed indicator frames (wdashboard-server services/indicators.py). `seriesKey`
// is the server's canonical series id, carried on every frame; `series` is the resolved
// node document (versions filled in, params typed).
export interface StreamIndicatorSubscribed {
  type: 'indicator_subscribed'
  vendor: string
  symbol: string
  interval: string
  seriesKey: string
  series: SeriesDoc
  phase: string
  serverTime: number
}
export interface StreamIndicatorBackfill {
  type: 'indicator_backfill'
  vendor: string
  symbol: string
  interval: string
  seriesKey: string
  points: IndicatorPoint[]
}
export interface StreamIndicatorPoint {
  type: 'indicator'
  vendor: string
  symbol: string
  interval: string
  seriesKey: string
  closed: boolean
  point: IndicatorPoint
}
export interface StreamIndicatorStatus {
  type: 'indicator_status'
  seriesKey: string
  phase: string
  error?: string | null
  mode?: string
}
export interface StreamIndicatorUnsubscribed {
  type: 'indicator_unsubscribed'
  seriesKey: string
}

export type StreamServerMessage =
  | StreamSubscribed
  | StreamUnsubscribed
  | StreamBackfill
  | StreamBar
  | StreamPong
  | StreamError
  | StreamIndicatorSubscribed
  | StreamIndicatorBackfill
  | StreamIndicatorPoint
  | StreamIndicatorStatus
  | StreamIndicatorUnsubscribed

export type StreamClientMessage =
  | {
      action: 'subscribe'
      vendor: string
      symbol: string
      interval: string
      updates?: UpdatesMode
      backfill?: number
    }
  | {
      action: 'subscribe'
      vendor: string
      symbol: string
      interval: string
      indicator: SeriesDoc
      backfill?: number
    }
  | { action: 'unsubscribe'; vendor: string; symbol: string; interval: string; indicator?: SeriesDoc }
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
