import type {
  Notification,
  NotificationBackend,
  NotificationSink,
  NotificationSpec,
  RemoteNotification
} from './types'

// The Notification Center's model: an ordered, capped, newest-first list of notifications,
// plus who has seen what. No DOM, no chart, no producer — `bell.ts` renders it and
// `client/watch/notifications.ts` fills it from the server, and neither is imported here.
//
// It is a PAGE-LEVEL singleton (`notifications` below), like `client/stream.ts`'s client and
// unlike anything in `client/index.ts`'s `mountWall`: a workspace switch tears the whole wall
// down and builds another, and a notification raised on the wall you just left is exactly the
// one you still need to see.
//
// **The server is the durable half.** Rows raised by a watch are stored server-side before
// they are sent (`wdashboard_server/notify`), so this holds no persistence of its own -- an
// earlier version mirrored the list into localStorage, which is exactly the thing a
// server-side store replaces. What lives only here is a row raised locally by the page
// itself, and it lives for the page.

/** Ceiling on the list. Old rows are dropped from the tail as new ones arrive. */
export const MAX_NOTIFICATIONS = 100

/** How many ids `bind` and `accept` remember having been dismissed here (a bound on memory, far
 * beyond what a round trip could leave outstanding). */
const REMEMBERED = 500

export type NotificationListener = (list: Notification[]) => void

export class NotificationCenter implements NotificationSink {
  private rows: Notification[] = []
  private readonly listeners = new Set<NotificationListener>()
  private backend: NotificationBackend | null = null
  private sequence = 0
  /** Page rows dismissed before the server named them (./durable.ts): when it does, the dismissal
   * is passed on to it. */
  private readonly dismissedUnbound = new Set<string>()
  /** Server ids dismissed here: a live push or a hydrate that brings one back again (it was in
   * flight, or the server had not deleted it yet) is not shown again. */
  private readonly dismissedRemote = new Set<string>()

  /** Newest first. A copy: nothing outside may mutate the list in place. */
  list(): Notification[] {
    return [...this.rows]
  }

  unseen(): number {
    return this.rows.reduce((count, row) => count + (row.seen ? 0 : 1), 0)
  }

  /** Attach the durable half and adopt what it holds. Idempotent per backend; attaching a
   * second time (a workspace switch remounting the wall) re-reads rather than duplicating,
   * because `accept` is keyed by `remoteId`. */
  async attach(backend: NotificationBackend): Promise<void> {
    this.backend = backend
    try {
      for (const row of (await backend.hydrate()).reverse()) this.accept(row)
    } catch (err) {
      console.warn('[notifications] could not read the stored list', err)
    }
  }

  detach(backend: NotificationBackend): void {
    if (this.backend === backend) this.backend = null
  }

  /** A row raised by this page. Not persisted anywhere. */
  notify(spec: NotificationSpec): Notification {
    return this.insert(spec)
  }

  /** A row that came from the server. Deduplicated by `remoteId`, so a push that races the
   * hydrate -- or a re-hydrate on reconnect -- cannot show the same alert twice. */
  accept(spec: RemoteNotification): Notification | null {
    if (this.dismissedRemote.has(spec.remoteId)) return null
    const existing = this.rows.find((row) => row.remoteId === spec.remoteId)
    if (existing) return existing
    return this.insert(spec, spec.seen)
  }

  /** A row this page raised that the server now holds too (./durable.ts): it takes the server's
   * id, so acknowledging or clearing it reaches the server, and the live push of the same row
   * finds it rather than adding a second. If that push arrived first, the page's copy goes. An
   * acknowledgement made before the server answered is passed on now. */
  bind(id: string, remoteId: string): void {
    if (this.dismissedUnbound.delete(id)) {
      // Dismissed while the server was answering: dismiss it there too, and any copy of it a
      // live push has added since.
      remember(this.dismissedRemote, remoteId)
      const before = this.rows.length
      this.rows = this.rows.filter((candidate) => candidate.remoteId !== remoteId)
      this.backend?.clear([remoteId])
      if (this.rows.length !== before) this.emit()
      return
    }
    const row = this.rows.find((candidate) => candidate.id === id)
    if (!row || row.remoteId === remoteId) return
    const pushed = this.rows.find((candidate) => candidate.remoteId === remoteId)
    if (pushed) {
      // The live push landed first: keep the server's row, and the acknowledgement the page's
      // copy carried.
      this.rows = this.rows.filter((candidate) => candidate.id !== id)
      if (row.seen && !pushed.seen) {
        this.rows = this.rows.map((candidate) => (candidate === pushed ? { ...candidate, seen: true } : candidate))
        this.backend?.markSeen([remoteId])
      }
      this.emit()
      return
    }
    this.rows = this.rows.map((candidate) => (candidate.id === id ? { ...candidate, remoteId } : candidate))
    if (row.seen) this.backend?.markSeen([remoteId])
    this.emit()
  }

  private insert(spec: NotificationSpec, seen = false): Notification {
    this.sequence += 1
    const row: Notification = {
      ...spec,
      id: `n${Date.now().toString(36)}-${this.sequence.toString(36)}`,
      at: spec.at ?? Date.now(),
      level: spec.level ?? 'info',
      seen
    }
    // Insert in order rather than unshifting: hydrate replays the server's list oldest-first
    // and a live push can arrive in the middle of it, so position is decided by `at`, not by
    // arrival.
    const index = this.rows.findIndex((existing) => existing.at <= row.at)
    this.rows = index < 0 ? [...this.rows, row] : [...this.rows.slice(0, index), row, ...this.rows.slice(index)]
    this.rows = this.rows.slice(0, MAX_NOTIFICATIONS)
    this.emit()
    return row
  }

  /** Acknowledge every row — what clicking the bell does, and the only thing that stops the
   * blink. Deliberately all-or-nothing: a per-row "seen" would leave the blink running for a
   * row the user has already scrolled past. */
  markAllSeen(): void {
    const unseen = this.rows.filter((row) => !row.seen)
    if (unseen.length === 0) return
    this.rows = this.rows.map((row) => (row.seen ? row : { ...row, seen: true }))
    this.pushSeen(unseen)
    this.emit()
  }

  /** Everything, or just one producer's rows. */
  clear(source?: string): void {
    const dropped = source === undefined ? this.rows : this.rows.filter((row) => row.source === source)
    if (dropped.length === 0) return
    this.rows = this.rows.filter((row) => !dropped.includes(row))
    this.pushClear(dropped)
    this.emit()
  }

  remove(id: string): void {
    const row = this.rows.find((candidate) => candidate.id === id)
    if (!row) return
    this.rows = this.rows.filter((candidate) => candidate.id !== id)
    this.pushClear([row])
    this.emit()
  }

  /** Immediately reports the current list, then every change — the same contract as
   * `stream.onStatus`, so a view never has to render once before subscribing. */
  subscribe(listener: NotificationListener): () => void {
    this.listeners.add(listener)
    listener([...this.rows])
    return () => this.listeners.delete(listener)
  }

  private pushSeen(rows: Notification[]): void {
    const remote = rows.map((row) => row.remoteId).filter((id): id is string => !!id)
    if (remote.length > 0) this.backend?.markSeen(remote)
  }

  private pushClear(rows: Notification[]): void {
    const remote: string[] = []
    for (const row of rows) {
      if (row.remoteId) {
        remote.push(row.remoteId)
        remember(this.dismissedRemote, row.remoteId)
      } else {
        remember(this.dismissedUnbound, row.id)
      }
    }
    if (remote.length > 0) this.backend?.clear(remote)
  }

  private emit(): void {
    const snapshot = [...this.rows]
    for (const listener of this.listeners) listener(snapshot)
  }
}

function remember(set: Set<string>, id: string): void {
  set.add(id)
  // Oldest first: a Set iterates in insertion order.
  for (const old of set) {
    if (set.size <= REMEMBERED) break
    set.delete(old)
  }
}

/** The page's centre. Everything mounts against this one; tests build their own. */
export const notifications = new NotificationCenter()
