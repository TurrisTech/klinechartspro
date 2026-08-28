// The Notification Center's whole vocabulary. Deliberately says nothing about price alerts,
// or about any other producer: a producer depends on `NotificationSink` (one method) and
// nothing else, which is what lets the centre be mounted, tested and replaced on its own.

export type NotificationLevel = 'info' | 'success' | 'warning' | 'alert'

/** What a producer hands in. `at` is optional so the centre can stamp it. */
export interface NotificationSpec {
  title: string
  body?: string
  level?: NotificationLevel
  /** Who raised it ('alerts', 'replay', …) — shown as the row's tag and, more importantly,
   * the key `clear(source)` works on. */
  source?: string
  /** Epoch ms of the EVENT, when that is not the moment it was raised. */
  at?: number
  /** Opaque payload a consumer of `subscribe` may use to act on the row (jump to the
   * instrument, open a panel). The centre itself never reads it. */
  data?: unknown
}

export interface Notification extends NotificationSpec {
  id: string
  at: number
  level: NotificationLevel
  /** False until the user has acknowledged the arrival — which is what the bell's blink
   * tracks. Per notification rather than one global flag so a burst that arrives while the
   * panel is open is not silently marked seen. */
  seen: boolean
}

/** The one method a producer needs. `mountPriceAlerts` takes this, not the centre. */
export interface NotificationSink {
  notify(spec: NotificationSpec): Notification
}
