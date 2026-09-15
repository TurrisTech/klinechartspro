import type { ChartProPane, KLineChartPro, SymbolInfo } from '../../src'
import { createDockableWindow } from '../chrome/window'
import { formatPnl, symbolKey } from './format'
import { instrumentInfo, seedInstrument, type InstrumentInfo } from './instrument'
import type { DraftController } from './lines'
import { TradingOverlays } from './overlays'
import { TradingPanel } from './panel'
import type { TradingSession } from './session'

// The trading dock, mode-agnostic: the panel (account strip, ticket, tables), the per-pane
// overlays, the window it all lives in, open/close and teardown -- everything that does NOT
// depend on whether the session is a paper account or a replay. Both `mountPaperTrading`
// (index.ts) and `mountBarReplay` (client/replay/index.ts) build on it; the panel, ticket,
// tables and overlays are reused verbatim, bound to whichever `TradingSession` is handed in.
//
// The window is a `DockableWindow` (../chrome/window.ts): docked below the chart by default,
// because the account, ticket and tables want the width, but the user can float it over the
// chart, resize it, roll it up, or drag it between the two. A replay's own controls are NOT
// in here -- they are a second window of exactly the same kind, and drive this one's
// open/close from their Account toggle.

export interface DockOptions {
  chartPro: KLineChartPro
  /** The chart's container: what a floating window is clamped into, and what the dock column
   * is inserted after. */
  container: HTMLElement
  /** The window's title ('Paper account', 'Replay account'). */
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
  /** Show/hide the window; returns whether it is now open. */
  toggle(): boolean
  setOpen(open: boolean): boolean
  isOpen(): boolean
  /** Resync overlays and the ticket to the current wall panes (the wall's onPanesChange). */
  sync(panes: ChartProPane[]): void
  /** The active pane's instrument key. */
  activeKey(): string
  teardown(): void
}

/** The account sits BELOW the replay's controls when both are docked. */
const DOCK_ORDER = 20

export function mountTradingDock(session: TradingSession, options: DockOptions): TradingDock {
  const { chartPro, container, tag } = options
  let open = false

  const activePane = (): ChartProPane | null => {
    const id = chartPro.getActivePaneId()
    return chartPro.getPane(id) ?? chartPro.getPanes()[0] ?? null
  }
  const activeSymbol = (): SymbolInfo => activePane()?.getSymbol() ?? chartPro.getSymbol()

  // The lines, brackets, labels and order card on every candle pane. They show whether or not
  // this window is open: an order placed from the ticket appears on the chart at once, and the
  // window stays the place for the ticket and the history.
  //
  // While the window is open the ticket's order is on the chart as well, as a draft whose lines
  // drag straight into the ticket's fields. Closed, there is no draft: an order nobody is writing
  // should not sit on the chart.
  const draft: DraftController = {
    draft: () => (open ? panel.ticket.draft() : null),
    setLevel: (role, price) => panel.ticket.setLevel(role, price),
    clearLevel: (role) => panel.ticket.clearLevel(role),
    place: () => panel.ticket.place()
  }
  const overlays = new TradingOverlays({ session, tag, instrumentFor: (key) => instrumentFor(key), draft })

  const instrumentFor = (key: string): InstrumentInfo =>
    instrumentInfo(key, () => {
      panel.syncInstrument()
      overlays.update(session.snapshot)
    })

  const panel = new TradingPanel(session, {
    activeSymbol,
    instrumentFor,
    // Table edits are confirmed through the same waiting change the chart shows.
    amendments: {
      current: () => overlays.currentAmendment(),
      sending: () => overlays.isSending(),
      propose: (change) => overlays.propose(change),
      confirm: () => overlays.confirmAmendment(),
      cancel: () => overlays.cancelAmendment(),
      onChange: (listener) => overlays.onAmendmentChange(listener)
    }
  })
  panel.ticket.onDraftChange(() => {
    if (open) overlays.draftChanged()
  })

  // The kc tokens are scoped under `.klinecharts-pro.dark`; the window is a body-level
  // sibling of the chart, so it carries the theme class itself.
  const win = createDockableWindow({
    key: `${tag}-account`,
    className: 'wd-trade-window',
    title: options.title,
    bounds: container,
    theme: document.querySelector('.klinecharts-pro.dark') ? 'dark' : '',
    // Docked by default: the account strip, the ticket and the tables are laid out across
    // the width, and the wall gives that up only while the window is open.
    defaultMode: 'dock',
    floatSize: { width: 820, height: 380 },
    // Centred rather than against the bottom of the chart: that strip is where the small
    // windows (the replay's controls) anchor, and two windows sharing an anchor open one
    // on top of the other.
    floatAnchor: 'center',
    minSize: { width: 380, height: 180 },
    order: DOCK_ORDER,
    onClose: () => setOpen(false),
    onResize: () => panel.syncShape()
  })
  win.element.dataset.session = session.mode ?? 'paper'
  win.body.appendChild(panel.element)

  // Equity and open P&L live in the TITLE BAR, so rolling the window up to that bar (or
  // docking it and collapsing it) still answers the question the account is open for.
  const summary = document.createElement('span')
  summary.className = 'wd-trade-summary'
  win.titleSlot.appendChild(summary)

  function renderSummary(): void {
    summary.innerHTML = ''
    if (!session.ready) return
    const s = session.snapshot
    const equity = document.createElement('span')
    equity.className = 'wd-trade-summary-equity'
    equity.textContent = `${s.account.equity.toFixed(2)} ${s.account.currency}`
    const pnl = document.createElement('span')
    const unrealized = s.account.unrealizedPnl
    pnl.className = `wd-trade-summary-pnl ${unrealized > 0 ? 'is-up' : unrealized < 0 ? 'is-down' : ''}`
    pnl.textContent = formatPnl(unrealized)
    summary.append(equity, pnl)
    const open = s.trades.filter((t) => t.closedAt === null).length
    if (open > 0) {
      const badge = document.createElement('span')
      badge.className = 'wd-trade-summary-open'
      badge.textContent = `${open} open`
      summary.appendChild(badge)
    }
  }
  // Hidden until asked for -- `is-hidden` is `display: none`, so a docked window costs the
  // wall nothing until the rail button (or the replay's Account toggle) opens it.
  win.setVisible(false)

  // Panel, overlays and the title-bar summary all redraw from the session, which notifies
  // on every change.
  const unsubscribe = session.subscribe(() => {
    overlays.update(session.snapshot)
    renderSummary()
  })
  renderSummary()

  function setOpen(next: boolean): boolean {
    open = next
    win.setVisible(open)
    overlays.draftChanged()
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
    element: win.element,
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
      win.dispose()
    }
  }
}
