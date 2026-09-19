import type { ChartProPane, KLineChartPro, SymbolInfo } from '../../src'
import { createDockableWindow } from '../chrome/window'
import { formatPnl, symbolKey } from './format'
import { PositionInspector } from './inspector'
import { instrumentInfo, seedInstrument, type InstrumentInfo } from './instrument'
import type { DraftController } from './lines'
import { TradingOverlays } from './overlays'
import { TradingPanel } from './panel'
import type { TradingSession } from './session'
import { OrderTicket } from './ticket'

// The trading dock, mode-agnostic: the panel (account strip, tables), the order ticket, the
// position popup, the per-pane overlays, the windows they live in, open/close and teardown --
// everything that does NOT depend on whether the session is a paper account or a replay. Both `mountPaperTrading`
// (index.ts) and `mountBarReplay` (client/replay/index.ts) build on it; the panel, ticket,
// tables and overlays are reused verbatim, bound to whichever `TradingSession` is handed in.
//
// The window is a `DockableWindow` (../chrome/window.ts): docked below the chart by default,
// because the account, ticket and tables want the width, but the user can float it over the
// chart, resize it, roll it up, or drag it between the two. A replay's own controls are NOT
// in here -- they are a second window of exactly the same kind, and drive this one's
// open/close from their Account toggle.
//
// THREE windows, each opened on its own:
//
// - the ACCOUNT (docked below the chart by default): balance, equity, the tables;
// - the TRADE BOX (user, 2026-09-19): the order ticket as a non-modal floating window, one per
//   wall, following the active pane's instrument. It floats against the right of the chart where
//   the price is, never docks, and keeps its place per browser. While it is open its order is
//   drawn on the chart as the draft;
// - the POSITION popup (inspector.ts): opened by a click on a position, beside the click.

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
  /** The same, for the trade box. */
  onTicketOpenChange?: (open: boolean) => void
}

export interface TradingDock {
  readonly element: HTMLElement
  readonly panel: TradingPanel
  readonly ticket: OrderTicket
  readonly overlays: TradingOverlays
  /** Show/hide the window; returns whether it is now open. */
  toggle(): boolean
  setOpen(open: boolean): boolean
  isOpen(): boolean
  /** The trade box, shown and hidden on its own. */
  toggleTicket(): boolean
  setTicketOpen(open: boolean): boolean
  isTicketOpen(): boolean
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
  let ticketOpen = false
  // The kc tokens are scoped under `.klinecharts-pro.dark`; the windows are body-level siblings
  // of the chart, so they carry the theme class themselves.
  const theme = document.querySelector('.klinecharts-pro.dark') ? 'dark' : ''

  const activePane = (): ChartProPane | null => {
    const id = chartPro.getActivePaneId()
    return chartPro.getPane(id) ?? chartPro.getPanes()[0] ?? null
  }
  const activeSymbol = (): SymbolInfo => activePane()?.getSymbol() ?? chartPro.getSymbol()

  // The lines, brackets, labels and order card on every candle pane. They show whether or not
  // this window is open: an order placed from the ticket appears on the chart at once, and the
  // window stays the place for the ticket and the history.
  //
  // While the trade box is open the ticket's order is on the chart as well, as a draft whose
  // lines drag straight into the ticket's fields. Closed, there is no draft: an order nobody is
  // writing should not sit on the chart.
  const draft: DraftController = {
    draft: () => (ticketOpen ? ticket.draft() : null),
    setLevel: (role, price) => ticket.setLevel(role, price),
    clearLevel: (role) => ticket.clearLevel(role),
    place: () => ticket.place()
  }
  const overlays = new TradingOverlays({ session, tag, instrumentFor: (key) => instrumentFor(key), draft })

  const instrumentFor = (key: string): InstrumentInfo =>
    instrumentInfo(key, () => {
      panel.syncInstrument()
      ticket.syncInstrument()
      inspector.render()
      overlays.update(session.snapshot)
    })

  const ticket = new OrderTicket(session, { activeSymbol, instrumentFor })
  ticket.onDraftChange(() => {
    if (ticketOpen) overlays.draftChanged()
  })

  const inspector = new PositionInspector({
    session,
    instrumentFor,
    bounds: container,
    tag,
    theme,
    selected: () => overlays.selectedId(),
    select: (id) => overlays.select(id),
    onSelectionChange: (listener) => overlays.onSelectionChange(listener)
  })
  const unsubscribeInspect = overlays.onInspect((id) => inspector.show(id))

  const panel = new TradingPanel(session, {
    instrumentFor,
    selected: () => overlays.selectedId(),
    onSelectionChange: (listener) => overlays.onSelectionChange(() => listener()),
    inspect: (id) => overlays.inspect(id),
    openTicket: () => setTicketOpen(true),
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

  const win = createDockableWindow({
    key: `${tag}-account`,
    className: 'wd-trade-window',
    title: options.title,
    bounds: container,
    theme,
    // Docked by default: the account strip and the tables are laid out across the width, and
    // the wall gives that up only while the window is open.
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

  // The trade box. Sized by its content, so it has no resize corner; it only floats.
  const ticketWin = createDockableWindow({
    key: `${tag}-ticket`,
    className: 'wd-trade-window wd-ticket-window',
    title: 'Trade',
    bounds: container,
    theme,
    dockable: false,
    floatAnchor: 'right',
    onClose: () => setTicketOpen(false)
  })
  ticketWin.element.dataset.session = session.mode ?? 'paper'
  ticketWin.body.appendChild(ticket.element)
  ticketWin.setVisible(false)

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
    options.onOpenChange?.(open)
    return open
  }

  function setTicketOpen(next: boolean): boolean {
    ticketOpen = next
    if (ticketOpen) ticket.syncInstrument()
    ticketWin.setVisible(ticketOpen)
    overlays.draftChanged()
    options.onTicketOpenChange?.(ticketOpen)
    return ticketOpen
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
    ticket,
    overlays,
    toggle: () => setOpen(!open),
    setOpen,
    isOpen: () => open,
    toggleTicket: () => setTicketOpen(!ticketOpen),
    setTicketOpen,
    isTicketOpen: () => ticketOpen,
    activeKey: () => symbolKey(activeSymbol()),
    sync(panes: ChartProPane[]): void {
      overlays.sync(panes)
      panel.syncInstrument()
      ticket.syncInstrument()
      overlays.update(session.snapshot)
      primeActive()
    },
    teardown(): void {
      unsubscribe()
      unsubscribeInspect()
      inspector.dispose()
      overlays.teardown()
      panel.dispose()
      ticket.dispose()
      win.dispose()
      ticketWin.dispose()
    }
  }
}
