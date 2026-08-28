// A price alert and the two things the feature needs from the rest of the app. Nothing here
// imports the chart, the stream or the Notification Center: `client/alerts` is wired to a
// `NotificationSink`-shaped `notify` by client/index.ts and depends on no module of its own.

/** Which side of the level the market was on when the alert was armed. The whole cross test
 * is directional off this, which is what makes it stateless — see cross.ts. */
export type AlertSide = 'above' | 'below'

export type AlertStatus = 'armed' | 'triggered'

export interface PriceAlert {
  id: string
  /** `oanda`, from SymbolInfo.exchange (client/symbols.ts symbolVendor). */
  vendor: string
  /** The bare ticker, `EURUSD`. Paired with `vendor` it is the stream's subscription key. */
  symbol: string
  /** The level. */
  price: number
  /** Where the market was, relative to `price`, at the moment this alert was (re-)armed. */
  from: AlertSide
  /** The market price it was armed against. Kept for the row's own explanation ("armed at
   * 1.16240, waiting for 1.16500"), not for the cross test. */
  reference: number
  note?: string
  /** When it was last ARMED, not when it was first created — re-arming resets it, because
   * a bar that opened before then may already have passed the level. cross.ts's `low`/`high`
   * widening is gated on it. */
  armedAt: number
  createdAt: number
  status: AlertStatus
  triggeredAt?: number
  triggeredPrice?: number
}

/** What the UI hands the store to create one. `from` and `armedAt` are the store's job. */
export interface AlertDraft {
  vendor: string
  symbol: string
  price: number
  /** The market price now — what `from` is computed against. */
  reference: number
  note?: string
}

/** The subset of client/notifications this module depends on, restated so it depends on
 * nothing. The Notification Center satisfies it; so does a spy in a test. */
export interface AlertNotifier {
  notify(spec: { title: string; body?: string; level?: 'info' | 'success' | 'warning' | 'alert'; source?: string; at?: number; data?: unknown }): unknown
}

/** `vendor:TICKER` — the instrument key an alert is grouped and subscribed by. */
export function instrumentKey(vendor: string, symbol: string): string {
  return `${vendor}:${symbol}`
}
