import type { KLineChartPro } from '../../src'
import { attachToSlot } from '../chartlayers/controller'
import type { NotificationSink } from '../notifications'
import { stream } from '../stream'
import { loadServerCatalogue, type ServerCatalogue } from './catalogue'
import { HttpAlertData } from './data'
import type { EditorContext } from './editor'
import { type AlertManager, createAlertManager } from './manager'
import { AlertMonitor } from './monitor'
import { AlertSearch } from './search'
import { ClientAlertStore, defaultPersistence } from './store'

// THE ALERT MANAGER, wired. Two lifetimes:
//
//   the PAGE   the store, the live monitor and the search -- started once (`startAlerts`), so
//              an alert keeps being watched through a workspace switch and a bar replay, and
//              a replay's Next alert reuses the bars a previous search fetched
//   a WALL     the toolbar button and the window (`mountAlertManager`), built and torn down
//              with the wall, like the notification bell beside it
//
// client/index.ts is the one module that knows the alerts, the Notification Center and the
// replay exist together.

export type { Alert, AlertDefinition, AlertSource, Operand, Rule } from './types'
export type { AlertManager } from './manager'

export interface AlertsRuntime {
  store: ClientAlertStore
  monitor: AlertMonitor
  search: AlertSearch
  catalogue: () => Promise<ServerCatalogue>
}

declare global {
  interface Window {
    __wdAlerts?: {
      list: () => unknown[]
      running: () => string[]
      flush: () => Promise<void>
    }
  }
}

let runtime: Promise<AlertsRuntime> | null = null

/** Load this account's alerts and start watching them. Once per page; later calls get the
 * same runtime. */
export function startAlerts(notify: NotificationSink): Promise<AlertsRuntime> {
  runtime ??= (async () => {
    const store = new ClientAlertStore(defaultPersistence())
    await store.load()
    const data = new HttpAlertData()
    const catalogue = loadServerCatalogue
    const monitor = new AlertMonitor({ store, notify, data, catalogue, stream })
    monitor.start()
    window.__wdAlerts = { list: () => store.list(), running: () => monitor.running(), flush: () => monitor.flush() }
    return { store, monitor, search: new AlertSearch(data, catalogue), catalogue }
  })()
  return runtime
}

export interface MountedAlertManager {
  readonly manager: AlertManager
  /** Told when the alerts change or the window opens or closes -- what a toggle elsewhere (the
   * replay's Alerts) redraws on. */
  subscribe(listener: () => void): () => void
  teardown(): void
}

/** The Alerts button in the top rail's right-hand slot (beside the bell) and the window it
 * opens, for this wall. */
export function mountAlertManager(
  chartPro: KLineChartPro,
  alerts: AlertsRuntime,
  options: { bounds: HTMLElement; context: () => EditorContext }
): MountedAlertManager {
  const toolbarButton = document.createElement('button')
  toolbarButton.type = 'button'
  toolbarButton.className = 'kc-button wd-alerts-button'
  const badge = document.createElement('span')
  badge.className = 'wd-alerts-badge'
  toolbarButton.append('Alerts', badge)

  const manager = createAlertManager({
    store: alerts.store,
    bounds: options.bounds,
    context: options.context,
    catalogue: alerts.catalogue,
    onOpenChange: () => {
      paint()
      for (const listener of [...openListeners]) listener()
    }
  })
  const openListeners = new Set<() => void>()

  function paint(): void {
    const list = alerts.store.list()
    const on = list.filter((a) => a.enabled).length
    const fired = list.filter((a) => a.status === 'fired').length
    badge.textContent = on > 0 ? String(on) : ''
    badge.hidden = on === 0
    toolbarButton.classList.toggle('is-active', manager.isOpen())
    toolbarButton.setAttribute('aria-pressed', String(manager.isOpen()))
    toolbarButton.title =
      list.length === 0
        ? 'Alerts: none yet -- open to create one'
        : `Alerts: ${on} on${fired > 0 ? `, ${fired} fired and waiting to be re-armed` : ''} (of ${list.length})`
  }
  toolbarButton.addEventListener('click', () => manager.toggle())
  const unsubscribe = alerts.store.subscribe(paint)
  paint()
  const detach = attachToSlot(chartPro, 'toolbar-right', toolbarButton)

  return {
    manager,
    subscribe(listener) {
      openListeners.add(listener)
      const off = alerts.store.subscribe(listener)
      return () => {
        openListeners.delete(listener)
        off()
      }
    },
    teardown(): void {
      // Detach first: the slot's observer re-parents an element it finds outside the slot.
      detach()
      unsubscribe()
      manager.dispose()
      toolbarButton.remove()
    }
  }
}
