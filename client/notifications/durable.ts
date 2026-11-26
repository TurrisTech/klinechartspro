// A NotificationSink whose rows the SERVER holds too: raised here at once, so the bell answers
// without waiting on the network, and posted to the server, which stores the row, pushes it to
// every open tab and delivers it to the owner's channels (Pushover, Telegram -- set up from the
// bell's Delivery button, ./channels). When the server answers, the page's row takes the
// server's id (`NotificationCenter.bind`), so the live push of the same row is not a second
// one. When it cannot be reached the row stays this page's alone -- what every client alert
// was before the server could hold them.
//
// Who uses it: the live alert monitor (client/alerts/monitor.ts), handed this sink by
// client/index.ts when the server advertises `notification_raise`. A bar replay does NOT: its
// rows are about a past market, raised into the centre directly, and this sink refuses to post
// one even if handed it (LOCAL_ONLY_SOURCES) -- the server refuses them as well.
//
// Generic on purpose: it knows the centre and one function that raises a row remotely, not the
// wire (client/watch/notifications.ts `raiseNotification` is that function).

import type { NotificationCenter } from './center'
import { LOCAL_ONLY_SOURCES, type Notification, type NotificationSink, type NotificationSpec, type RemoteNotification } from './types'

/** Raise `spec` on the server; resolves with the row it holds (the same row for the same key). */
type RaiseRemote = (spec: NotificationSpec) => Promise<RemoteNotification>

export function durableSink(center: NotificationCenter, raise: RaiseRemote): NotificationSink {
  return {
    notify(spec: NotificationSpec): Notification {
      const row = center.notify(spec)
      if (LOCAL_ONLY_SOURCES.has(spec.source ?? '')) return row
      raise(spec).then(
        (remote) => center.bind(row.id, remote.remoteId),
        (err) => console.warn('[notifications] the server did not take this row; it stays in this tab only', err)
      )
      return row
    }
  }
}
