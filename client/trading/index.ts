import type { ChartProPane, KLineChartPro, SymbolInfo } from '../../src'
import { hasFeature } from '../capabilities'
import { symbolKey } from './format'
import { instrumentInfo, seedInstrument, type InstrumentInfo } from './instrument'
import { TradingOverlays } from './overlays'
import { TradingPanel } from './panel'
import { PaperTradingSession } from './session'

// The paper-trading feature on the client: it owns the trading panel, the chart overlays and
// the paper account (a `PaperTradingSession`, the one `TradingSession` implementation today).
//
// Created once per mounted wall (client/index.ts). The panel is a dock BELOW the chart,
// minimized by default -- it takes no screen space until the "Paper" button in the drawing
// rail's footer is pressed. The overlays draw the working orders and open trades on each
// pane; the stop/target lines are draggable and report an amendment back through the session.
//
// The server holds the money logic (the fill engine, the account); this client holds the
// view and polls. Every action goes through the `TradingSession` interface, so a later replay
// mode swaps the implementation and this whole module works unchanged.

export interface PaperTradingController {
  /** Show/hide the panel; returns whether it is now open. */
  toggle(): boolean
  isOpen(): boolean
  /** Resync overlays and the ticket to the current wall panes (the wall's onPanesChange). */
  sync(panes: ChartProPane[]): void
  teardown(): void
}

export function mountPaperTrading(
  chartPro: KLineChartPro,
  container: HTMLElement
): PaperTradingController | null {
  if (!hasFeature('sim')) return null

  const session = new PaperTradingSession()

  const activePane = (): ChartProPane | null => {
    const id = chartPro.getActivePaneId()
    return chartPro.getPane(id) ?? chartPro.getPanes()[0] ?? null
  }
  const activeSymbol = (): SymbolInfo => activePane()?.getSymbol() ?? chartPro.getSymbol()

  const overlays = new TradingOverlays((kind, trade, price) => {
    void session
      .modifyTrade(trade.id, kind === 'stop' ? { stopLoss: price } : { takeProfit: price })
      .catch((err) => console.warn('[paper] trade amend failed', err))
  })

  const instrumentFor = (key: string): InstrumentInfo =>
    instrumentInfo(key, () => {
      panel.syncInstrument()
      overlays.update(session.snapshot)
    })

  const dock = document.createElement('div')
  // Minimized by default: `is-hidden` is `display: none`, so the panel is removed from the
  // layout and the chart uses the whole wall until the rail button opens it.
  dock.className = 'wd-trade-dock is-hidden'

  const panel = new TradingPanel(session, {
    activeSymbol,
    instrumentFor,
    onClose: () => setOpen(false)
  })
  dock.appendChild(panel.element)

  // The dock takes its own row below the chart: #app flexes to fill the space above it, the
  // dock takes its height below. Inserting it as #app's sibling (not inside the chart's own
  // container) keeps it out of the pane grid's layout.
  document.body.insertBefore(dock, container.nextSibling)
  document.body.classList.add('wd-has-dock')

  // Panel and overlays both redraw from the session, which notifies on every change -- an
  // action's answer, or a poll that found a fill without the client asking.
  const unsubscribe = session.subscribe(() => overlays.update(session.snapshot))

  let open = false
  function setOpen(next: boolean): boolean {
    open = next
    dock.classList.toggle('is-hidden', !open)
    return open
  }

  function primeActive(): void {
    const symbol = activeSymbol()
    seedInstrument(symbolKey(symbol), symbol.pricePrecision)
    instrumentFor(symbolKey(symbol)) // warm the pip/precision cache
  }

  // Load the account and bring the active instrument in at once, so the ticket has a quote
  // and the overlays draw whatever is already open. The panel shows a connecting state until
  // the load resolves.
  primeActive()
  void session.load().then(() => {
    void session.watch(symbolKey(activeSymbol())).catch(() => {})
    overlays.update(session.snapshot)
  })

  return {
    toggle: () => setOpen(!open),
    isOpen: () => open,
    sync(panes: ChartProPane[]): void {
      overlays.sync(panes)
      panel.syncInstrument()
      overlays.update(session.snapshot)
      primeActive()
      void session.watch(symbolKey(activeSymbol())).catch(() => {})
    },
    teardown(): void {
      unsubscribe()
      session.dispose()
      overlays.teardown()
      panel.dispose()
      dock.remove()
      if (!document.body.querySelector('.wd-trade-dock')) {
        document.body.classList.remove('wd-has-dock')
      }
    }
  }
}
