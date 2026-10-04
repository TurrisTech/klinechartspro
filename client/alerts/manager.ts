import { createDockableWindow, type DockableWindow } from '../chrome/window'
import { formatInstant } from '../trading/format'
import { Arming } from '../trading/kit'
import { labelOperand, type ServerCatalogue } from './catalogue'
import { createAlertEditor, type EditorContext } from './editor'
import { describeRule, type Labeller } from './rules'
import type { ClientAlertStore } from './store'
import type { Alert, AlertKind, AlertSource } from './types'

// GLUE (DOM). THE ALERT MANAGER: one window listing every alert, by kind.
//
//   Client  this browser's alerts (./store.ts): switch one on or off, re-arm one that fired,
//           edit it, delete it (two presses -- the trading kit's rule for anything that
//           cannot be taken back), or write a new one (./editor.ts, in this same window)
//   Server  alerts the server evaluates, which fire with every tab closed. Not built: the tab
//           says so, and says what does run on the server today (price watches)
//
// A dockable window (../chrome/window.ts) like the replay controls and the account: floating,
// centred, remembered per browser. It renders any `AlertSource`, so a server backend is a
// second source in the list, not a second manager.

const WINDOW_KEY = 'alerts'
const DOCK_ORDER = 30

export interface AlertManagerOptions {
  store: ClientAlertStore
  /** The server's half, when there is one. Absent: the Server tab explains that it is not
   * built yet. */
  server?: AlertSource
  /** The element a floating window stays inside: the chart's container. */
  bounds: HTMLElement
  /** Where a new alert starts: read when the editor opens. */
  context: () => EditorContext
  catalogue: () => Promise<ServerCatalogue>
  /** Told when the window opens or closes, for a toggle elsewhere to redraw. */
  onOpenChange?: (open: boolean) => void
}

export interface AlertManager {
  /** The window's card; building it if it has not been opened yet. */
  readonly element: HTMLElement
  isOpen(): boolean
  open(): void
  close(): void
  toggle(): void
  /** Open straight on a new alert's editor. */
  create(): void
  dispose(): void
}

type View = { kind: 'list' } | { kind: 'edit'; alert: Alert | null }

export function createAlertManager(options: AlertManagerOptions): AlertManager {
  const { store } = options
  let view: View = { kind: 'list' }
  let tab: AlertKind = 'client'
  let catalogue: ServerCatalogue | null = null
  const label: Labeller = (operand) => labelOperand(operand, catalogue)
  const arming = new Arming(() => render())

  // Built on first open, not with the wall: a window clamps its size to the chart as it stands
  // when it is made, and while the wall is still mounting the chart is a fraction of its
  // height -- the clamped size would then be the one it keeps.
  let made: DockableWindow | null = null
  function windowFor(): DockableWindow {
    if (made) return made
    made = createDockableWindow({
      key: WINDOW_KEY,
      className: 'wd-alerts-window',
      title: 'Alerts',
      bounds: options.bounds,
      theme: document.querySelector('.klinecharts-pro.dark') ? 'dark' : '',
      defaultMode: 'float',
      floatAnchor: 'center',
      floatSize: { width: 660, height: 540 },
      minSize: { width: 380, height: 220 },
      order: DOCK_ORDER,
      onClose: () => close()
    })
    // Made hidden: `open` is what shows it.
    made.setVisible(false)
    return made
  }

  const unsubscribe = store.subscribe(() => {
    if (view.kind === 'list') render()
  })
  const unsubscribeServer = options.server?.subscribe(() => {
    if (view.kind === 'list') render()
  })

  void options
    .catalogue()
    .then((loaded) => {
      catalogue = loaded
      render()
    })
    .catch(() => {})

  function render(): void {
    if (!made?.visible) return
    const win = made
    const body = win.body
    body.innerHTML = ''
    if (view.kind === 'edit') {
      const editing = view.alert
      const editor = createAlertEditor({
        alert: editing,
        context: options.context(),
        catalogue,
        label,
        onSave: async (definition) => {
          if (editing) await store.update(editing.id, definition)
          else await store.create(definition)
          view = { kind: 'list' }
          render()
        },
        onCancel: () => {
          view = { kind: 'list' }
          render()
        }
      })
      body.appendChild(editor.element)
      win.reflow()
      return
    }
    body.append(renderTabs(), tab === 'client' ? renderClient() : renderServer())
    win.reflow()
  }

  function renderTabs(): HTMLElement {
    const row = el('div', 'wd-alerts-tabs')
    const tabButton = (kind: AlertKind, text: string): HTMLButtonElement => {
      const b = button(`kc-button wd-alerts-tab${tab === kind ? ' is-on' : ''}`, text, () => {
        tab = kind
        arming.disarm()
        render()
      })
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', String(tab === kind))
      return b
    }
    const count = store.list().length
    row.append(tabButton('client', count > 0 ? `Client · ${count}` : 'Client'), tabButton('server', 'Server'))
    const spacer = el('span', 'wd-alerts-spacer')
    const add = button('kc-button kc-button-primary wd-alerts-new', 'New alert', () => create())
    add.hidden = tab !== 'client'
    row.append(spacer, add)
    return row
  }

  function renderClient(): HTMLElement {
    const box = el('div', 'wd-alerts-list')
    const alerts = store.list()
    if (alerts.length === 0) {
      const empty = el('div', 'wd-alerts-empty')
      empty.textContent =
        'No alerts yet. An alert reads indicator values on an instrument -- a close, an RSI, an AREV series, a signal -- and tells you at the bar close where its rule holds. In a bar replay, Next alert jumps to the next place one would have.'
      box.appendChild(empty)
      return box
    }
    for (const alert of alerts) box.appendChild(renderRow(alert, store))
    return box
  }

  function renderRow(alert: Alert, source: AlertSource): HTMLElement {
    const row = el('div', `wd-alert-row is-${alert.status}`)
    row.dataset.alert = alert.id

    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.className = 'wd-alert-switch'
    toggle.checked = alert.enabled
    toggle.title = alert.enabled ? 'On -- click to switch off' : 'Off -- click to switch on'
    toggle.setAttribute('aria-label', `${alert.enabled ? 'Disable' : 'Enable'} ${alert.name}`)
    toggle.addEventListener('change', () => {
      void source.setEnabled(alert.id, toggle.checked)
    })

    const main = el('div', 'wd-alert-main')
    const title = el('div', 'wd-alert-title')
    const nameEl = el('span', 'wd-alert-name')
    nameEl.textContent = alert.name
    const status = el('span', `wd-alert-status is-${alert.status}`)
    status.textContent = alert.status
    title.append(nameEl, status)
    const rule = el('div', 'wd-alert-rule-text')
    rule.textContent = `${alert.symbol.split(':')[1] ?? alert.symbol} · ${describeRule(alert.rule, label)}`
    rule.title = rule.textContent
    const meta = el('div', 'wd-alert-meta')
    const fired = alert.fireCount > 0 ? `fired ${alert.fireCount}× · last ${formatInstant(alert.lastFiredAt)}` : 'not fired yet'
    const how = alert.trigger === 'edge' ? 'when it starts holding' : 'at every close it holds'
    meta.textContent = [fired, how, alert.repeat === 'once' ? 'once' : '', alert.note].filter(Boolean).join(' · ')
    main.append(title, rule, meta)

    const actions = el('div', 'wd-alert-actions')
    if (alert.status === 'fired') {
      actions.appendChild(button('kc-button kc-button-outline', 'Re-arm', () => void source.rearm(alert.id)))
    }
    if (source === store) {
      actions.appendChild(
        button('kc-button kc-button-outline', 'Edit', () => {
          view = { kind: 'edit', alert }
          render()
        })
      )
    }
    const key = `delete:${alert.id}`
    const armed = arming.key === key
    const remove = button(`kc-button wd-alert-delete${armed ? ' is-armed' : ''}`, armed ? 'Confirm delete' : 'Delete', () => {
      if (!arming.press(key, false)) return
      void source.remove(alert.id)
    })
    remove.title = armed ? 'Press again to delete it for good' : 'Delete this alert'
    actions.appendChild(remove)

    row.append(toggle, main, actions)
    return row
  }

  function renderServer(): HTMLElement {
    const server = options.server
    if (server?.available) {
      const box = el('div', 'wd-alerts-list')
      for (const alert of server.list()) box.appendChild(renderRow(alert, server))
      return box
    }
    const box = el('div', 'wd-alerts-empty')
    box.textContent =
      server?.unavailable ||
      'Server alerts -- evaluated by the server, so they fire with every tab closed -- are not built yet. Client alerts run in this browser while a dashboard tab is open. What the server does watch today is a price: right-click the chart to place a price watch.'
    return box
  }

  const isOpen = (): boolean => made?.visible === true

  function open(): void {
    if (isOpen()) return
    windowFor().setVisible(true)
    render()
    options.onOpenChange?.(true)
  }

  function close(): void {
    if (!isOpen()) return
    arming.disarm()
    view = { kind: 'list' }
    made?.setVisible(false)
    options.onOpenChange?.(false)
  }

  function create(): void {
    tab = 'client'
    view = { kind: 'edit', alert: null }
    if (isOpen()) render()
    else open()
  }

  return {
    get element() {
      return windowFor().element
    },
    isOpen,
    open,
    close,
    toggle: () => (isOpen() ? close() : open()),
    create,
    dispose(): void {
      unsubscribe()
      unsubscribeServer?.()
      arming.disarm()
      made?.dispose()
    }
  }
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  return node
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = className
  b.textContent = text
  b.addEventListener('click', onClick)
  return b
}
