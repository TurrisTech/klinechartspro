import { capabilities, hasFeature } from './capabilities'
import { STREAM_URL } from './config'
import type { IndicatorPoint, SeriesDoc } from './indicators/api'
import type {
  NotificationWire,
  OHLCVBar,
  StreamClientMessage,
  StreamServerMessage
} from './ohlcv'

// Reconnect backoff. A dropped stream is usually a proxy idle-timeout or a server rollout,
// so the first retry is fast; the ceiling stops a server that is genuinely down from being
// hammered by every open tab.
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

// Application-level keepalive. Traefik closes an idle WebSocket well before an FX market
// goes quiet enough to produce no bars for minutes at a stretch, and a browser gets no
// event when that happens mid-silence — the socket simply stops delivering. `ping` is the
// sanctioned probe (feature "stream.ping"); a missing `pong` is the only reliable signal
// that a socket which still reads as OPEN is actually dead.
const PING_INTERVAL_MS = 25_000
const PONG_TIMEOUT_MS = 10_000

// Bars requested on subscribe to bridge the gap between the history load and the first
// live push. Server default is 200 and its ceiling is advertised in limits.
const BACKFILL_BAR_COUNT = 200

// A pane retarget (symbol/period switch) or a wall layout shrink-then-grow can unsubscribe a
// key and resubscribe it again moments later. wdashboard-server's TODO.md A3 (P1) documents
// that a fast subscribe-then-unsubscribe pair permanently leaks a NATS stream key against its
// process-wide MAX_STREAM_KEYS -- unfixable from here, but a linger before actually sending
// the `unsubscribe` frame means a retarget that lands back on the same key within the window
// sends NEITHER frame, so it can never form that pair. Comfortably longer than the ~200ms
// backfill await the server's own handler does around a subscribe.
const UNSUBSCRIBE_LINGER_MS = 1_500

export interface StreamListener {
  // Closed bars the server sent to cover the history/live gap, ascending by date.
  onBackfill?(bars: OHLCVBar[]): void
  // `closed: false` arrives only for intervals whose `subscribed` ack said
  // formingSupported, and only under updates: 'all'.
  onBar(bar: OHLCVBar, closed: boolean): void
}

// A server-computed indicator series' live values -- same socket, its own frame family
// (indicator_subscribed / indicator_backfill / indicator / indicator_status). One shape
// whether the server computes it in process or relays the indicator feed.
export interface IndicatorListener {
  onBackfill?(points: IndicatorPoint[]): void
  onPoint(point: IndicatorPoint): void
  onStatus?(phase: string, error: string | null): void
}

// Values requested on an indicator subscribe to bridge history and live (server default 200).
const INDICATOR_BACKFILL_COUNT = 200

// The server pushes a notification the moment a watch fires (wdashboard_server/notify). It
// is a fast path and never the record: the row is stored before it is sent, so a tab that was
// closed catches up from `GET /notifications` on its next boot and nothing here has to queue,
// retry, or survive a reconnect gap.
export type NotificationListener = (notification: NotificationWire) => void

export type StreamStatus = 'connected' | 'connecting' | 'offline'
export type StatusListener = (status: StreamStatus) => void

export function subscriptionKey(vendor: string, symbol: string, interval: string): string {
  return `${vendor} ${symbol} ${interval}`
}

interface Subscription {
  vendor: string
  symbol: string
  interval: string
  listeners: Set<StreamListener>
  formingSupported: boolean
}

interface IndicatorSubscription {
  vendor: string
  symbol: string
  interval: string
  series: SeriesDoc
  listeners: Set<IndicatorListener>
}

// One shared `WS /stream` connection for the page, multiplexing every active subscription.
// Requests "all" mode so a forming bar updates live and finalizes on close, rather than the
// chart's right edge jumping only once per interval.
class StreamClient {
  private ws: WebSocket | null = null
  private readonly subscriptions = new Map<string, Subscription>()
  // Keyed by the server's seriesKey (SeriesIdentity.key()), which every indicator frame
  // carries; the controller learns it from its first history read before subscribing.
  private readonly indicatorSubscriptions = new Map<string, IndicatorSubscription>()
  private readonly indicatorLingering = new Map<string, ReturnType<typeof setTimeout>>()
  // Keys whose last listener just left: still present in `subscriptions` (so a stray
  // in-flight message for them is a harmless no-op iteration over an empty listener set),
  // but scheduled to actually leave -- and to send the real `unsubscribe` frame -- only if
  // nothing revives them first. See UNSUBSCRIBE_LINGER_MS above.
  private readonly lingering = new Map<string, ReturnType<typeof setTimeout>>()
  //: Who this connection has asked for notifications as, and who wants them. One
  //: subscription per socket, not per listener: the server keys delivery by connection.
  private notificationsIdentity: { owner: string; token?: string | null } | null = null
  private readonly notificationListeners = new Set<NotificationListener>()
  private status: StreamStatus = 'offline'
  private readonly statusListeners = new Set<StatusListener>()
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null

  // Immediately reports the current status, then every change.
  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    listener(this.status)
    return () => this.statusListeners.delete(listener)
  }

  private setStatus(status: StreamStatus): void {
    if (this.status === status) return
    this.status = status
    for (const listener of this.statusListeners) listener(status)
  }

  subscribe(vendor: string, symbol: string, interval: string, listener: StreamListener): void {
    const key = subscriptionKey(vendor, symbol, interval)
    const existing = this.subscriptions.get(key)
    if (existing) {
      existing.listeners.add(listener)
      // Revives a lingering key with zero frames sent: the server never learns anything
      // changed, so it can't reproduce the leaking subscribe-then-unsubscribe pair.
      this.reviveLingering(key)
      return
    }

    // Spent capacity first: a key still only lingering because its removal timer hasn't
    // fired yet shouldn't count against the cap for a genuinely new subscription.
    this.evictLingering()

    const max = capabilities().limits.maxSubscriptionsPerConnection
    if (this.subscriptions.size >= max) {
      console.error(
        `[stream] refusing ${vendor}:${symbol}:${interval} — at the server's limit of ${max} subscriptions per connection`
      )
      return
    }

    this.subscriptions.set(key, {
      vendor,
      symbol,
      interval,
      listeners: new Set([listener]),
      formingSupported: false
    })
    this.send(this.subscribeFrame(vendor, symbol, interval))
    this.connect()
  }

  unsubscribe(vendor: string, symbol: string, interval: string, listener: StreamListener): void {
    const key = subscriptionKey(vendor, symbol, interval)
    const subscription = this.subscriptions.get(key)
    if (!subscription) return
    subscription.listeners.delete(listener)
    if (subscription.listeners.size > 0) return
    // Not removed yet -- see UNSUBSCRIBE_LINGER_MS. `subscribe()` reviving this same key
    // within the window cancels this timer before it ever sends a frame.
    this.reviveLingering(key)
    const timer = setTimeout(() => {
      this.lingering.delete(key)
      this.subscriptions.delete(key)
      this.send({ action: 'unsubscribe', vendor, symbol, interval })
    }, UNSUBSCRIBE_LINGER_MS)
    this.lingering.set(key, timer)
  }

  /** Ask for this owner's notifications on this socket. Returns an unsubscribe.
   *
   * `token` is the session bearer, when there is one. It rides in the FRAME because the
   * WebSocket API gives a browser no way to set a request header: without it, on a
   * deployment with auth on, this client's REST calls resolve to the signed-in user while
   * its socket resolves to the anonymous owner token, the two never match, and every live
   * push is delivered to nobody -- notifications then appear only on the next page load. */
  subscribeNotifications(
    identity: { owner: string; token?: string | null },
    listener: NotificationListener
  ): () => void {
    this.notificationListeners.add(listener)
    if (this.notificationsIdentity?.owner !== identity.owner) {
      this.notificationsIdentity = identity
      this.send(this.notificationsFrame(identity))
    }
    this.connect()
    return () => {
      this.notificationListeners.delete(listener)
      if (this.notificationListeners.size > 0) return
      this.notificationsIdentity = null
      this.send({ action: 'unsubscribe', notifications: true })
    }
  }

  private notificationsFrame(identity: {
    owner: string
    token?: string | null
  }): StreamClientMessage {
    return {
      action: 'subscribe',
      notifications: true,
      owner: identity.owner,
      ...(identity.token ? { token: identity.token } : {})
    }
  }

  subscribeIndicator(
    vendor: string,
    symbol: string,
    interval: string,
    series: SeriesDoc,
    seriesKey: string,
    listener: IndicatorListener
  ): void {
    const existing = this.indicatorSubscriptions.get(seriesKey)
    if (existing) {
      existing.listeners.add(listener)
      const timer = this.indicatorLingering.get(seriesKey)
      if (timer) {
        clearTimeout(timer)
        this.indicatorLingering.delete(seriesKey)
      }
      return
    }
    const max = capabilities().limits.maxSubscriptionsPerConnection
    if (this.subscriptions.size + this.indicatorSubscriptions.size >= max) {
      console.error(`[stream] refusing indicator ${seriesKey} — at the server's limit of ${max} subscriptions per connection`)
      return
    }
    this.indicatorSubscriptions.set(seriesKey, { vendor, symbol, interval, series, listeners: new Set([listener]) })
    this.send(this.indicatorSubscribeFrame(vendor, symbol, interval, series))
    this.connect()
  }

  unsubscribeIndicator(seriesKey: string, listener: IndicatorListener): void {
    const sub = this.indicatorSubscriptions.get(seriesKey)
    if (!sub) return
    sub.listeners.delete(listener)
    if (sub.listeners.size > 0) return
    const existing = this.indicatorLingering.get(seriesKey)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.indicatorLingering.delete(seriesKey)
      this.indicatorSubscriptions.delete(seriesKey)
      this.send({ action: 'unsubscribe', vendor: sub.vendor, symbol: sub.symbol, interval: sub.interval, indicator: sub.series })
    }, UNSUBSCRIBE_LINGER_MS)
    this.indicatorLingering.set(seriesKey, timer)
  }

  private indicatorSubscribeFrame(vendor: string, symbol: string, interval: string, series: SeriesDoc): StreamClientMessage {
    return {
      action: 'subscribe',
      vendor,
      symbol,
      interval,
      indicator: series,
      backfill: INDICATOR_BACKFILL_COUNT
    }
  }

  private reviveLingering(key: string): void {
    const timer = this.lingering.get(key)
    if (!timer) return
    clearTimeout(timer)
    this.lingering.delete(key)
  }

  // Sends the deferred `unsubscribe` for every currently-lingering key right away, instead of
  // waiting out each one's own timer. Only actually matters near the subscription cap, but is
  // cheap and correct to run unconditionally.
  private evictLingering(): void {
    for (const [key, timer] of this.lingering) {
      clearTimeout(timer)
      const subscription = this.subscriptions.get(key)
      this.subscriptions.delete(key)
      if (subscription) {
        this.send({
          action: 'unsubscribe',
          vendor: subscription.vendor,
          symbol: subscription.symbol,
          interval: subscription.interval
        })
      }
    }
    this.lingering.clear()
  }

  private subscribeFrame(vendor: string, symbol: string, interval: string): StreamClientMessage {
    return {
      action: 'subscribe',
      vendor,
      symbol,
      interval,
      updates: 'all',
      backfill: hasFeature('stream.backfill')
        ? Math.min(BACKFILL_BAR_COUNT, capabilities().limits.maxBackfillBarCount)
        : undefined
    }
  }

  // A frame sent while the socket is down is dropped on purpose rather than queued. Both
  // kinds are reconstructible without a queue: every live `subscribe` is replayed from
  // `subscriptions` when the socket opens (the map is updated before this is called), and
  // an `unsubscribe` is moot because a server that never saw the subscribe — or a
  // reconnected one, which remembers nothing — has nothing to cancel.
  private send(message: StreamClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
      return
    }
    this.connect()
  }

  private connect(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return
    if (this.reconnectTimer) return

    this.setStatus('connecting')
    const ws = new WebSocket(STREAM_URL)
    this.ws = ws

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return
      this.reconnectAttempts = 0
      this.setStatus('connected')
      this.resubscribeAll()
      this.startKeepalive()
    })
    ws.addEventListener('message', (event: MessageEvent<string>) => {
      if (this.ws === ws) this.handleMessage(event.data)
    })
    ws.addEventListener('error', () => {
      // 'error' is always followed by 'close', which owns the reconnect. Logging only.
      console.warn('[stream] socket error')
    })
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return
      this.ws = null
      this.stopKeepalive()
      this.setStatus('offline')
      this.scheduleReconnect()
    })
  }

  // Every open — first connect and reconnect alike — subscribes the whole live set. A
  // reconnected server has no memory of prior subscriptions, and on a first connect this is
  // exactly the set of frames `subscribe()` could not send yet.
  //
  // Lingering keys are skipped, not replayed: a reconnected server never saw the original
  // subscribe for one, so resubscribing it here would manufacture a fresh subscribe-then-
  // (eventual)-unsubscribe pair — exactly the shape that leaks a server-side key — on every
  // single reconnect. Its own removal timer still fires normally and sends a
  // by-then-pointless but harmless `unsubscribe` for a key the server never learned about.
  private resubscribeAll(): void {
    for (const [key, subscription] of this.subscriptions) {
      if (this.lingering.has(key)) continue
      this.ws?.send(
        JSON.stringify(
          this.subscribeFrame(subscription.vendor, subscription.symbol, subscription.interval)
        )
      )
    }
    for (const [key, sub] of this.indicatorSubscriptions) {
      if (this.indicatorLingering.has(key)) continue
      this.ws?.send(JSON.stringify(this.indicatorSubscribeFrame(sub.vendor, sub.symbol, sub.interval, sub.series)))
    }
    // A reconnected server remembers no subscription, this one included. Anything raised
    // during the outage is not replayed here and does not need to be -- it is in the store,
    // and the notification centre re-reads that whenever the socket comes back.
    if (this.notificationsIdentity !== null) {
      this.ws?.send(JSON.stringify(this.notificationsFrame(this.notificationsIdentity)))
    }
  }

  private scheduleReconnect(): void {
    if (
      this.reconnectTimer ||
      (this.subscriptions.size === 0 &&
        this.indicatorSubscriptions.size === 0 &&
        this.notificationsIdentity === null)
    ) {
      return
    }
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempts, 5)
    )
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    if (!hasFeature('stream.ping')) return
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      this.ws.send(JSON.stringify({ action: 'ping', id: 'keepalive' }))
      if (this.pongTimer) return
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null
        // No pong: the socket is dead even though readyState still says OPEN. Closing it
        // is what surfaces the failure as a 'close' event and starts the reconnect.
        console.warn('[stream] keepalive timed out, reconnecting')
        this.ws?.close()
      }, PONG_TIMEOUT_MS)
    }, PING_INTERVAL_MS)
  }

  private stopKeepalive(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.pingTimer = null
    this.pongTimer = null
  }

  private handleMessage(raw: string): void {
    let message: StreamServerMessage
    try {
      message = JSON.parse(raw)
    } catch {
      console.warn('[stream] unparseable frame')
      return
    }

    switch (message.type) {
      case 'pong':
        if (this.pongTimer) clearTimeout(this.pongTimer)
        this.pongTimer = null
        return
      case 'error':
        console.error(`[stream] ${message.code}: ${message.errmsg}`)
        return
      case 'subscribed': {
        const subscription = this.subscriptions.get(
          subscriptionKey(message.vendor, message.symbol, message.interval)
        )
        if (subscription) subscription.formingSupported = message.formingSupported
        return
      }
      case 'backfill': {
        const subscription = this.subscriptions.get(
          subscriptionKey(message.vendor, message.symbol, message.interval)
        )
        if (!subscription) return
        for (const listener of subscription.listeners) listener.onBackfill?.(message.bars)
        return
      }
      case 'bar': {
        const subscription = this.subscriptions.get(
          subscriptionKey(message.vendor, message.symbol, message.interval)
        )
        if (!subscription) return
        for (const listener of subscription.listeners) listener.onBar(message.bar, message.closed)
        return
      }
      case 'indicator_subscribed': {
        const sub = this.indicatorSubscriptions.get(message.seriesKey)
        if (!sub) return
        for (const listener of sub.listeners) listener.onStatus?.(message.phase, null)
        return
      }
      case 'indicator_backfill': {
        const sub = this.indicatorSubscriptions.get(message.seriesKey)
        if (!sub) return
        for (const listener of sub.listeners) listener.onBackfill?.(message.points)
        return
      }
      case 'indicator': {
        const sub = this.indicatorSubscriptions.get(message.seriesKey)
        if (!sub) return
        for (const listener of sub.listeners) listener.onPoint(message.point)
        return
      }
      case 'notifications_subscribed':
        return
      case 'notification': {
        for (const listener of this.notificationListeners) listener(message.notification)
        return
      }
      case 'indicator_status': {
        const sub = this.indicatorSubscriptions.get(message.seriesKey)
        if (!sub) return
        for (const listener of sub.listeners) listener.onStatus?.(message.phase, message.error ?? null)
        return
      }
      default:
        return
    }
  }
}

export const stream = new StreamClient()
