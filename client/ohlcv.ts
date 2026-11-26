import type { KLineData } from 'klinecharts'
import type { IndicatorPoint, SeriesDoc } from './indicators/api'

// The wire contract of wdashboard-server's OHLCV app, mirroring the Pydantic models in
// `wdashboard_server/services/schemas.py` field for field. Timestamps are always integer
// Unix epoch milliseconds.

export type ErrorCode =
  | 'invalid_request'
  | 'unsupported'
  // 401: a missing, invalid or expired session (config.ts serverFetch, stream.ts), or a wrong
  // password at sign-in.
  | 'unauthorized'
  | 'not_found'
  // 412: PUT /preferences' If-Match lost to another write (preferences.ts).
  | 'conflict'
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

/** One row of the server's notification store, as `GET /notifications` and the `notification`
 * stream frame both state it (wdashboard-server `wdashboard_server/notify`). */
export interface NotificationWire {
  id: string
  at: number
  title: string
  level: 'info' | 'success' | 'warning' | 'alert'
  body: string
  /** Which producer raised it — `watch` today. */
  source: string
  /** Opaque payload the producer attached; for a watch, the watch id, its target and the
   * readings that fired it. */
  data: Record<string, unknown>
  seen: boolean
}


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
  serverTime: number
}

export interface StreamBar {
  type: 'bar'
  vendor: string
  symbol: string
  interval: string
  closed: boolean
  bar: OHLCVBar
  // `bar.date` is WHICH BUCKET this is, on the vendor's event clock; `serverTime` is when
  // the server sent the frame, on its own. The gap between them is how stale the bar is —
  // the only way to tell a fresh forming bar from one that sat in a slow connection's queue.
  serverTime: number
}

export interface StreamPong {
  type: 'pong'
  id?: string | null
  serverTime: number
}

// Non-fatal: the offending action is not performed, the connection stays open -- except an
// `unauthorized` one, which the server follows with close code 4401 (stream.ts).
export interface StreamError {
  type: 'error'
  code: ErrorCode
  /** What the server sends. `detail` is ErrorBody's spelling, read too in case a server
   * moves to it. */
  errmsg?: string
  detail?: string
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

// Live plugin points (wdashboard-server services/framerelay.py). `point` is exactly what
// GET /plugins/{id}/values returns for that bar, on the same wire clock. There is no backfill
// frame: the window store fetches what it lacks, and this carries only what happens next.
export interface StreamPluginSubscribed {
  type: 'plugin_subscribed'
  plugin: string
  variant: string | null
  vendor: string
  symbol: string
  interval: string
  serverTime: number
}
export interface StreamPluginUnsubscribed {
  type: 'plugin_unsubscribed'
  plugin: string
  variant: string | null
  vendor: string
  symbol: string
  interval: string
  serverTime: number
}
export interface StreamPluginPoint {
  type: 'plugin_point'
  plugin: string
  variant: string | null
  vendor: string
  symbol: string
  interval: string
  point: { date: number }
  serverTime: number
}

export interface StreamNotificationsSubscribed {
  type: 'notifications_subscribed'
  unseen: number
  serverTime: number
}

export interface StreamNotification {
  type: 'notification'
  notification: NotificationWire
  serverTime: number
}

// The answer to the socket's first frame, `{"action": "auth"}` (stream.ts): the session is
// good, or the server has the login off.
export interface StreamAuthOk {
  type: 'auth_ok'
  serverTime: number
}

export type StreamServerMessage =
  | StreamAuthOk
  | StreamSubscribed
  | StreamNotificationsSubscribed
  | StreamNotification
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
  | StreamPluginSubscribed
  | StreamPluginUnsubscribed
  | StreamPluginPoint

export type StreamClientMessage =
  // The socket's first frame wherever a session is held (stream.ts).
  | { action: 'auth'; token: string }
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
  | { action: 'subscribe' | 'unsubscribe'; plugin: string; variant: string | null; vendor: string; symbol: string; interval: string }
  // The notifications subscribe carries both identities: `token` (the session bearer, when
  // signed in) for a server from before the stream login, which takes the session from no
  // other frame, and `owner`, the identity where the login is off. A server with the stream
  // login takes the session from the auth frame instead.
  | { action: 'subscribe'; notifications: true; owner: string; token?: string }
  | { action: 'unsubscribe'; notifications: true }
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
