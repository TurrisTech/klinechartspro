import type { ChartProPane, KLineChartPro } from '../../src'
import { hasFeature } from '../capabilities'
import type { SimQuote } from './api'
import { mountTradingDock } from './dock'
import { PaperTradingSession } from './session'

// The paper-trading feature on the client: the paper account (a `PaperTradingSession`, one
// of the two `TradingSession` implementations) bound to the shared trading dock (dock.ts:
// the panel, the chart overlays, the dock element below the chart).
//
// Created once per mounted live wall (client/index.ts). The dock is minimized by default --
// it takes no screen space until the "Paper" button in the drawing rail's footer is pressed.
//
// The server holds the money logic (the fill engine, the account); this client holds the
// view and polls. Every action goes through the `TradingSession` interface; the replay mode
// (client/replay) binds the same dock to its own implementation.

export interface PaperTradingController {
  /** Show/hide the panel; returns whether it is now open. */
  toggle(): boolean
  isOpen(): boolean
  /** Told whenever the window is shown or hidden, by whatever did it: the rail button, or
   * the window's own close. */
  onOpenChange(listener: (open: boolean) => void): void
  /** The trade box (the order ticket's own floating window), shown and hidden on its own. */
  toggleTicket(): boolean
  onTicketOpenChange(listener: (open: boolean) => void): void
  /** Resync overlays and the ticket to the current wall panes (the wall's onPanesChange). */
  sync(panes: ChartProPane[]): void
  /** The instrument's bid/ask as the account holds it now. Watches the instrument first --
   * idempotent, and the server never lets a stored seed overwrite a live tick -- then reads
   * the account fresh, since a repeat watch sends nothing (`PaperTradingSession.quote`). */
  quote(key: string): Promise<SimQuote | undefined>
  teardown(): void
}

export function mountPaperTrading(chartPro: KLineChartPro, container: HTMLElement): PaperTradingController | null {
  if (!hasFeature('sim')) return null

  const session = new PaperTradingSession()
  let onOpenChange: (open: boolean) => void = () => {}
  let onTicketOpenChange: (open: boolean) => void = () => {}
  const dock = mountTradingDock(session, {
    chartPro,
    container,
    title: 'Paper account',
    tag: 'paper',
    onOpenChange: (open) => onOpenChange(open),
    onTicketOpenChange: (open) => onTicketOpenChange(open)
  })

  // Load the account and bring the active instrument in at once, so the ticket has a quote
  // and the overlays draw whatever is already open. The panel shows a connecting state until
  // the load resolves.
  void session.load().then(() => {
    void session.watch(dock.activeKey()).catch(() => {})
    dock.overlays.update(session.snapshot)
  })

  return {
    toggle: () => dock.toggle(),
    isOpen: () => dock.isOpen(),
    onOpenChange(listener: (open: boolean) => void): void {
      onOpenChange = listener
    },
    toggleTicket: () => dock.toggleTicket(),
    onTicketOpenChange(listener: (open: boolean) => void): void {
      onTicketOpenChange = listener
    },
    sync(panes: ChartProPane[]): void {
      dock.sync(panes)
      void session.watch(dock.activeKey()).catch(() => {})
    },
    quote: (key: string): Promise<SimQuote | undefined> => session.quote(key),
    teardown(): void {
      dock.teardown()
      session.dispose()
    }
  }
}

export { mountTradingDock, type TradingDock } from './dock'
