// The Notification Center's whole vocabulary. Deliberately says nothing about watches, or
// about any other producer: a producer depends on `NotificationSink` (one method) and
// nothing else, which is what lets the centre be mounted, tested and replaced on its own.

export type NotificationLevel = 'info' | 'success' | 'warning' | 'alert'

/** What a producer hands in. `at` is optional so the centre can stamp it. */
export interface NotificationSpec {
  title: string
  body?: string
  level?: NotificationLevel
  /** Who raised it ('watch', …) — shown as the row's tag and, more importantly, the key
   * `clear(source)` works on. */
  source?: string
  /** Epoch ms of the EVENT, when that is not the moment it was raised. */
  at?: number
  /** Opaque payload a consumer of `subscribe` may use to act on the row (jump to the
   * instrument, open a panel). The centre itself never reads it. */
  data?: unknown
  /** The server's id for this row, when it came from the server's store. Rows carrying one
   * are acknowledged and cleared THERE as well as here (see `NotificationBackend`), so
   * reading a notification on one device is not undone by opening another. */
  remoteId?: string
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

/** The one method a producer needs. */
export interface NotificationSink {
  notify(spec: NotificationSpec): Notification
}

/** The durable half, when there is one. `client/watch/notifications.ts` supplies one over
 * the server's `/notifications` store; without it the centre holds this tab's rows and
 * nothing more.
 *
 * The centre stays generic: it knows a row may have a `remoteId` and that acknowledging or
 * clearing such a row has to reach the backend too. It does not know what a watch is. */
/** A row the backend holds: everything a notification has, plus the server id that is what
 * makes it a backend row rather than a local one. */
export type RemoteNotification = NotificationSpec & { remoteId: string; seen: boolean }

export interface NotificationBackend {
  /** Everything the server holds for this owner, newest first. */
  hydrate(): Promise<RemoteNotification[]>
  markSeen(remoteIds: string[]): void
  clear(remoteIds: string[]): void
}
