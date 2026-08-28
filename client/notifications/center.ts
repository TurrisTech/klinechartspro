import type { Notification, NotificationSink, NotificationSpec } from './types'

// The Notification Center's model: an ordered, capped, newest-first list of notifications,
// plus who has seen what. No DOM, no chart, no producer — `bell.ts` renders it and
// `client/alerts` writes into it through `NotificationSink`, and neither is imported here.
//
// It is a PAGE-LEVEL singleton (`notifications` below), like `client/stream.ts`'s client and
// unlike anything in `client/index.ts`'s `mountWall`: a workspace switch tears the whole wall
// down and builds another, and a notification raised on the wall you just left is exactly the
// one you still need to see. The bell is mounted per wall and reattaches to this.

/** Ceiling on the list. Old rows are dropped from the tail as new ones arrive. */
export const MAX_NOTIFICATIONS = 100

/** Where the list is mirrored, so a reload does not lose this session's alerts. Per browser,
 * never on the server: a notification is an event this device observed, not preference. */
const STORAGE_KEY = 'wd.notifications'

/** Rows older than this are dropped on load. A week-old "EURUSD crossed 1.1600" is noise, and
 * without an age bound the mirror would only ever be trimmed by MAX_NOTIFICATIONS. */
const MAX_AGE_MS = 3 * 86_400_000

export type NotificationListener = (list: Notification[]) => void

function isNotification(value: unknown): value is Notification {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    typeof row.title === 'string' &&
    typeof row.at === 'number' &&
    typeof row.seen === 'boolean'
  )
}

export class NotificationCenter implements NotificationSink {
  private rows: Notification[] = []
  private readonly listeners = new Set<NotificationListener>()
  private sequence = 0
  private hydrated = false

  constructor(private readonly storage: Storage | null = safeStorage()) {}

  /** Newest first. A copy: nothing outside may mutate the list in place. */
  list(): Notification[] {
    this.hydrate()
    return [...this.rows]
  }

  unseen(): number {
    this.hydrate()
    return this.rows.reduce((count, row) => count + (row.seen ? 0 : 1), 0)
  }

  notify(spec: NotificationSpec): Notification {
    this.hydrate()
    this.sequence += 1
    const row: Notification = {
      ...spec,
      id: `n${Date.now().toString(36)}-${this.sequence.toString(36)}`,
      at: spec.at ?? Date.now(),
      level: spec.level ?? 'info',
      seen: false
    }
    // Unshift + slice rather than push: the list is newest-first everywhere it is read, so
    // the panel never has to reverse it and the cap always drops the oldest row.
    this.rows = [row, ...this.rows].slice(0, MAX_NOTIFICATIONS)
    this.persist()
    this.emit()
    return row
  }

  /** Acknowledge every row — what clicking the bell does, and the only thing that stops the
   * blink. Deliberately all-or-nothing: a per-row "seen" would leave the blink running for a
   * row the user has already scrolled past. */
  markAllSeen(): void {
    this.hydrate()
    if (this.rows.every((row) => row.seen)) return
    this.rows = this.rows.map((row) => (row.seen ? row : { ...row, seen: true }))
    this.persist()
    this.emit()
  }

  /** Everything, or just one producer's rows. */
  clear(source?: string): void {
    this.hydrate()
    const next = source === undefined ? [] : this.rows.filter((row) => row.source !== source)
    if (next.length === this.rows.length) return
    this.rows = next
    this.persist()
    this.emit()
  }

  remove(id: string): void {
    this.hydrate()
    const next = this.rows.filter((row) => row.id !== id)
    if (next.length === this.rows.length) return
    this.rows = next
    this.persist()
    this.emit()
  }

  /** Immediately reports the current list, then every change — the same contract as
   * `stream.onStatus`, so a view never has to render once before subscribing. */
  subscribe(listener: NotificationListener): () => void {
    this.hydrate()
    this.listeners.add(listener)
    listener([...this.rows])
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const snapshot = [...this.rows]
    for (const listener of this.listeners) listener(snapshot)
  }

  // Lazy rather than in the constructor, because the singleton below is constructed at
  // module-evaluation time — before anything has decided whether this page even has a DOM.
  private hydrate(): void {
    if (this.hydrated) return
    this.hydrated = true
    if (!this.storage) return
    try {
      const raw = this.storage.getItem(STORAGE_KEY)
      if (raw === null) return
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return
      const cutoff = Date.now() - MAX_AGE_MS
      this.rows = parsed
        .filter(isNotification)
        .filter((row) => row.at >= cutoff)
        .slice(0, MAX_NOTIFICATIONS)
    } catch (err) {
      console.warn('[notifications] could not read the stored list', err)
    }
  }

  private persist(): void {
    if (!this.storage) return
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.rows))
    } catch (err) {
      console.warn('[notifications] could not store the list', err)
    }
  }
}

/** localStorage where it works, null where it throws (private mode, a blocked origin, a
 * test). Every caller here already degrades to "this page's session only". */
function safeStorage(): Storage | null {
  try {
    const probe = '__wd_notifications__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return window.localStorage
  } catch {
    return null
  }
}

/** The page's centre. Everything mounts against this one; tests build their own. */
export const notifications = new NotificationCenter()
