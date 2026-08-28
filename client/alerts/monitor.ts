import type { OHLCVBar } from '../ohlcv'
import { stream, type StreamListener } from '../stream'
import { observationFor, triggers } from './cross'
import type { AlertStore } from './store'
import { instrumentKey, type PriceAlert } from './types'

// Watches the market for the armed alerts in a store and reports each crossing exactly once.
//
// The feed is `client/stream.ts` DIRECTLY, not a pane: an alert is about an instrument, not
// about what some wall happens to be showing, so it keeps firing when the pane is retargeted,
// hidden by a layout, or was never on screen. One subscription per instrument with an armed
// alert, reconciled from the store on every change -- so deleting the last alert on a symbol
// really does stop its subscription, and adding one starts it.
//
// The interval is the FINEST the server serves, because the interval decides how much of a
// fast move is visible: with `stream.forming` a 1m bar updates on every tick, and its
// high/low carry the ticks between two frames. It is deliberately not the pane's interval --
// a wall on 1D would otherwise learn about a crossing a day late.
const MONITOR_INTERVAL = '1m'

/** Reported once per crossing. `price` is the reading that did it, not the level. */
export interface AlertTrigger {
  alert: PriceAlert
  price: number
  at: number
}

export class AlertMonitor {
  private readonly subscriptions = new Map<string, { vendor: string; symbol: string; listener: StreamListener }>()
  // The newest price seen per instrument, on the SAME feed the cross test runs on. It is
  // what an alert is armed against (client/alerts/index.ts), so that the side it waits on and
  // the reading that will fire it can never come from two different clocks -- a chart whose
  // newest bar is older than the stream's would otherwise arm an alert on the wrong side and
  // fire it on the next frame. Kept after an unsubscribe: a last known price is worth more
  // than none, and it is replaced the moment watching resumes.
  private readonly prices = new Map<string, number>()
  private unsubscribeStore: (() => void) | null = null
  private running = false

  constructor(
    private readonly store: AlertStore,
    private readonly onTrigger: (trigger: AlertTrigger) => void,
    private readonly interval: string = MONITOR_INTERVAL
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    // subscribe() reports the current list immediately, so this both seeds the subscriptions
    // and keeps them in step -- there is no separate initial reconcile to get wrong.
    this.unsubscribeStore = this.store.subscribe(() => this.reconcile())
  }

  stop(): void {
    this.running = false
    this.unsubscribeStore?.()
    this.unsubscribeStore = null
    for (const [key, entry] of this.subscriptions) {
      stream.unsubscribe(entry.vendor, entry.symbol, this.interval, entry.listener)
      this.subscriptions.delete(key)
    }
  }

  /** The instruments currently watched. Exposed for tests and the debug hook. */
  watching(): string[] {
    return [...this.subscriptions.keys()]
  }

  /** The newest price this monitor has seen for an instrument, or null if it has never
   * watched one. See `prices` above for why callers should prefer it to the chart's. */
  lastPrice(vendor: string, symbol: string): number | null {
    return this.prices.get(instrumentKey(vendor, symbol)) ?? null
  }

  private reconcile(): void {
    if (!this.running) return
    const wanted = new Map(
      this.store.armedInstruments().map((i) => [instrumentKey(i.vendor, i.symbol), i])
    )
    for (const [key, entry] of this.subscriptions) {
      if (wanted.has(key)) continue
      stream.unsubscribe(entry.vendor, entry.symbol, this.interval, entry.listener)
      this.subscriptions.delete(key)
    }
    for (const [key, instrument] of wanted) {
      if (this.subscriptions.has(key)) continue
      const listener: StreamListener = {
        // Backfill is the gap between the socket opening and the first live frame: bars that
        // closed while this tab was reconnecting. They are evaluated like any other closed
        // bar -- `observationFor` drops the extremes of anything that opened before the
        // alert was armed, so a backfilled bar can only ever report a real crossing.
        onBackfill: (bars) => {
          for (const bar of bars) this.evaluate(key, bar)
        },
        onBar: (bar) => this.evaluate(key, bar)
      }
      this.subscriptions.set(key, { ...instrument, listener })
      stream.subscribe(instrument.vendor, instrument.symbol, this.interval, listener)
    }
  }

  private evaluate(key: string, bar: OHLCVBar): void {
    this.prices.set(key, bar.close)
    // Re-read the store per frame rather than closing over a list: an alert may have been
    // edited, deleted or already triggered since the subscription was made.
    for (const alert of this.store.list()) {
      if (alert.status !== 'armed') continue
      if (instrumentKey(alert.vendor, alert.symbol) !== key) continue
      const observation = observationFor(alert, bar)
      if (!triggers(alert, observation)) continue
      // markTriggered is the idempotence: it returns null for an alert already triggered, so
      // a repeated frame -- or two overlapping listeners -- cannot notify twice.
      const triggered = this.store.markTriggered(alert.id, observation.price, Date.now())
      if (triggered) this.onTrigger({ alert: triggered, price: observation.price, at: triggered.triggeredAt ?? Date.now() })
    }
  }
}
