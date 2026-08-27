import type { ChartProPane, KLineChartPro, SymbolInfo } from '../../src'
import { symbolKey } from './format'
import { instrumentInfo, seedInstrument, type InstrumentInfo } from './instrument'
import { TradingOverlays } from './overlays'
import { TradingPanel } from './panel'
import type { TradingSession } from './session'

// The trading dock, mode-agnostic: the panel (account strip, ticket, tables), the per-pane
// overlays, the dock element below the chart, open/close and teardown -- everything that
// does NOT depend on whether the session is a paper account or a replay. Both
// `mountPaperTrading` (index.ts) and `mountBarReplay` (client/replay/index.ts) build on it;
// the panel, ticket, tables and overlays are reused verbatim, bound to whichever
// `TradingSession` is handed in. A replay's own controls are NOT in here: they float over
// the chart (client/replay/window.ts) and drive this dock's open/close from their Account
// toggle.

export interface DockOptions {
  chartPro: KLineChartPro
  /** The chart's container: the dock is inserted as its next sibling. */
  container: HTMLElement
  /** The panel's header title ('Paper account', 'Replay account'). */
  title: string
  /** Console-prefix tag ('paper', 'replay'). */
  tag: string
  /** Told whenever the dock is shown or hidden, by whatever did it -- a rail button, the
   * replay's Account toggle, or the panel's own close button. */
  onOpenChange?: (open: boolean) => void
}

export interface TradingDock {
  readonly element: HTMLElement
  readonly panel: TradingPanel
  readonly overlays: TradingOverlays
  /** Show/hide the dock; returns whether it is now open. */
  toggle(): boolean
  setOpen(open: boolean): boolean
  isOpen(): boolean
  /** Resync overlays and the ticket to the current wall panes (the wall's onPanesChange). */
  sync(panes: ChartProPane[]): void
  /** The active pane's instrument key. */
  activeKey(): string
  teardown(): void
}

export function mountTradingDock(session: TradingSession, options: DockOptions): TradingDock {
  const { chartPro, container, tag } = options

  const activePane = (): ChartProPane | null => {
    const id = chartPro.getActivePaneId()
    return chartPro.getPane(id) ?? chartPro.getPanes()[0] ?? null
  }
  const activeSymbol = (): SymbolInfo => activePane()?.getSymbol() ?? chartPro.getSymbol()

  const overlays = new TradingOverlays((kind, trade, price) => {
    void session
      .modifyTrade(trade.id, kind === 'stop' ? { stopLoss: price } : { takeProfit: price })
      .catch((err) => console.warn(`[${tag}] trade amend failed`, err))
  }, tag)

  const instrumentFor = (key: string): InstrumentInfo =>
    instrumentInfo(key, () => {
      panel.syncInstrument()
      overlays.update(session.snapshot)
    })

  const dock = document.createElement('div')
  // Minimized by default: `is-hidden` is `display: none`, so the dock is removed from the
  // layout and the chart uses the whole wall until the rail button opens it.
  // The kc tokens are scoped under `.klinecharts-pro.dark`; the dock is a body-level sibling
  // of the chart, so it carries the theme class itself.
  dock.className = `wd-trade-dock is-hidden ${document.querySelector('.klinecharts-pro.dark') ? 'dark' : ''}`
  dock.dataset.mode = session.mode ?? 'paper'

  const panel = new TradingPanel(session, {
    activeSymbol,
    instrumentFor,
    onClose: () => setOpen(false),
    title: options.title
  })
  dock.appendChild(panel.element)

  // The dock takes its own row below the chart: #app flexes to fill the space above it, the
  // dock takes its height below. Inserting it as #app's sibling (not inside the chart's own
  // container) keeps it out of the pane grid's layout.
  document.body.insertBefore(dock, container.nextSibling)
  document.body.classList.add('wd-has-dock')

  // Panel and overlays both redraw from the session, which notifies on every change.
  const unsubscribe = session.subscribe(() => overlays.update(session.snapshot))

  let open = false
  function setOpen(next: boolean): boolean {
    open = next
    dock.classList.toggle('is-hidden', !open)
    options.onOpenChange?.(open)
    return open
  }

  function primeActive(): void {
    const symbol = activeSymbol()
    seedInstrument(symbolKey(symbol), symbol.pricePrecision)
    instrumentFor(symbolKey(symbol)) // warm the pip/precision cache
  }
  primeActive()
  overlays.update(session.snapshot)

  return {
    element: dock,
    panel,
    overlays,
    toggle: () => setOpen(!open),
    setOpen,
    isOpen: () => open,
    activeKey: () => symbolKey(activeSymbol()),
    sync(panes: ChartProPane[]): void {
      overlays.sync(panes)
      panel.syncInstrument()
      overlays.update(session.snapshot)
      primeActive()
    },
    teardown(): void {
      unsubscribe()
      overlays.teardown()
      panel.dispose()
      dock.remove()
      if (!document.body.querySelector('.wd-trade-dock')) {
        document.body.classList.remove('wd-has-dock')
      }
    }
  }
}
