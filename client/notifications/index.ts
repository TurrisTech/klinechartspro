import type { KLineChartPro } from '../../src'
import { attachToSlot } from '../chartlayers/controller'
import { notifications } from './center'
import { createNotificationBell } from './bell'

export { NotificationCenter, notifications, MAX_NOTIFICATIONS } from './center'
export { createNotificationBell, relativeTime } from './bell'
export type { Notification, NotificationLevel, NotificationSink, NotificationSpec } from './types'

export interface MountedNotificationCenter {
  teardown(): void
}

/** Put the bell in the top rail's right-hand slot for this wall.
 *
 * Per MOUNT, like every other piece of chrome in client/index.ts: a workspace switch builds
 * a new chart and this one's slot goes with the old one. The CENTRE it renders is the page
 * singleton, so nothing is lost across the switch — only the view is rebuilt. */
export function mountNotificationCenter(
  chartPro: KLineChartPro,
  center = notifications
): MountedNotificationCenter {
  const bell = createNotificationBell(center)
  const detach = attachToSlot(chartPro, 'toolbar-right', bell.element)
  return {
    teardown(): void {
      // Detach first: `attachToSlot`'s MutationObserver re-parents the element whenever it
      // finds it outside the slot, so removing it before the observer is disconnected would
      // have it put straight back.
      detach()
      bell.dispose()
    }
  }
}
