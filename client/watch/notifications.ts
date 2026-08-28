import { apiSend } from '../config'
import type { NotificationBackend, RemoteNotification } from '../notifications'
import type { NotificationWire } from '../ohlcv'
import { ownerHeaders, ownerToken } from '../owner'
import { stream } from '../stream'

// The durable half of the Notification Center: the server's `/notifications` store
// (`wdashboard_server/notify`), plus the live `notification` frames on `WS /stream`.
//
// It lives HERE rather than in client/notifications because the two are meant to stay
// independent -- the centre knows a row may carry a `remoteId` and nothing else about where
// it came from, and this module knows the wire and nothing about how a bell is drawn. If a
// second server-side producer ever appears, it is served by this same backend with no change
// to either side.
//
// The socket is a fast path, never the record: every row is stored before it is sent, so a
// tab that was closed while a watch fired catches up from the REST read on its next boot and
// nothing here queues or replays.

const SEEN_DEBOUNCE_MS = 300

function toRemote(row: NotificationWire): RemoteNotification {
  return {
    remoteId: row.id,
    at: row.at,
    title: row.title,
    body: row.body,
    level: row.level,
    source: row.source,
    data: row.data,
    seen: row.seen
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const { data } = await apiSend<T>(method, path, { body, headers: ownerHeaders() })
  return data
}

export interface RemoteNotifications extends NotificationBackend {
  dispose(): void
}

/** `onPush` is called for every live row; the caller hands it to the centre's `accept`. */
export function createRemoteNotifications(
  onPush: (row: RemoteNotification) => void
): RemoteNotifications {
  const unsubscribe = stream.subscribeNotifications(ownerToken(), (row) => onPush(toRemote(row)))

  // Acknowledgements are batched: clicking the bell marks every unseen row at once, and the
  // centre reports them one call per gesture, not one per row.
  let pendingSeen: string[] = []
  let seenTimer: ReturnType<typeof setTimeout> | null = null

  function flushSeen(): void {
    seenTimer = null
    const ids = pendingSeen
    pendingSeen = []
    if (ids.length === 0) return
    void call('POST', '/notifications/seen', { ids }).catch((err) =>
      console.warn('[notifications] could not acknowledge', err)
    )
  }

  return {
    async hydrate(): Promise<RemoteNotification[]> {
      const body = await call<{ notifications: NotificationWire[] }>('GET', '/notifications')
      return body.notifications.map(toRemote)
    },
    markSeen(ids: string[]): void {
      pendingSeen = [...pendingSeen, ...ids]
      if (seenTimer) clearTimeout(seenTimer)
      seenTimer = setTimeout(flushSeen, SEEN_DEBOUNCE_MS)
    },
    clear(ids: string[]): void {
      void call('POST', '/notifications/clear', { ids }).catch((err) =>
        console.warn('[notifications] could not clear', err)
      )
    },
    dispose(): void {
      if (seenTimer) {
        clearTimeout(seenTimer)
        flushSeen()
      }
      unsubscribe()
    }
  }
}
