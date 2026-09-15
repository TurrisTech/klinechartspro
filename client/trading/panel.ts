import type { SymbolInfo } from '../../src'
import { OhlcvApiError } from '../config'
import type { SimOrder, SimSnapshot, SimTrade } from './api'
import {
  formatInstant,
  formatPips,
  formatPnl,
  formatPrice,
  formatUnits,
  toPips,
  tradePips,
  tradePnl
} from './format'
import type { InstrumentInfo } from './instrument'
import type { TradingSession } from './session'
import { OrderTicket } from './ticket'

// The trading panel: an account strip, an order ticket, and the working-orders /
// open-positions / history tables. It reads and acts ONLY through the `TradingSession`
// interface, so the same panel serves a replay unchanged.
//
// It does not own its chrome: the title bar, close, dock/float and the drag live on the
// window it is mounted in (../chrome/window.ts). What it does own is its own SHAPE -- the
// three-area grid needs width, so below `NARROW_PANEL` (a floating window dragged small, or
// a narrow screen) it stacks into one column instead. That is measured from the panel's own
// box, not the viewport's, because the two now differ.
//
// Hand-built plain DOM, the house style for app-side chrome (client/chartlayers/settings.ts):
// the library owns Svelte, the app owns the chrome around it, and the panel reuses the
// library's own token classes (kc-button, kc-input, kc-field) so it reads as native.

export interface PanelContext {
  /** The active pane's instrument, kept current by the caller on pane/symbol change. */
  activeSymbol: () => SymbolInfo
  /** Instrument facts (precision + pip size) for a key, from the config cache. */
  instrumentFor: (key: string) => InstrumentInfo
}

/** Below this width the ticket stops sharing a row with the tables. */
const NARROW_PANEL = 620

type Tab = 'positions' | 'orders' | 'history'

export class TradingPanel {
  readonly element: HTMLElement
  private body: HTMLElement
  private accountStrip: HTMLElement
  readonly ticket: OrderTicket
  private tablesHost: HTMLElement
  private tabsBar: HTMLElement
  private tab: Tab = 'positions'
  private unsub: () => void
  private shape: ResizeObserver

  constructor(
    private session: TradingSession,
    private ctx: PanelContext
  ) {
    this.element = el('div', 'wd-trade-panel')
    this.body = el('div', 'wd-trade-panel-body')
    this.element.appendChild(this.body)

    this.accountStrip = el('div', 'wd-trade-account')
    this.body.appendChild(this.accountStrip)

    this.ticket = new OrderTicket(session, ctx)
    this.body.appendChild(this.ticket.element)

    this.tabsBar = this.buildTabs()
    this.tablesHost = el('div', 'wd-trade-tables')
    this.body.appendChild(this.tabsBar)
    this.body.appendChild(this.tablesHost)

    this.unsub = session.subscribe(() => this.render())
    // The panel is as wide as whatever window it is in, which the user can resize; the
    // layout follows the box rather than the page.
    this.shape = new ResizeObserver(() => this.syncShape())
    this.shape.observe(this.element)
    this.render()
  }

  /** Re-read the panel's own width and lay out for it. Driven by the observer above in a
   * painting tab, and called outright by the window on a resize or a mode change -- an
   * occluded tab delivers no observer callbacks, and a panel stuck in the wrong layout is
   * worse than one that measures twice. */
  syncShape(): void {
    const width = this.element.offsetWidth
    if (width > 0) this.element.classList.toggle('is-narrow', width < NARROW_PANEL)
  }

  /** Switch to a tab (the replay scrolls a stop's event into view). */
  showTab(tab: Tab): void {
    this.tab = tab
    this.render()
  }

  /** Called when the active pane's instrument changes. */
  syncInstrument(): void {
    this.ticket.syncInstrument()
    this.render()
  }

  private buildTabs(): HTMLElement {
    const tabs = el('div', 'wd-trade-tabs')
    const make = (id: Tab, label: string): HTMLButtonElement => {
      const b = button('wd-trade-tab', label, () => {
        this.tab = id
        this.render()
      })
      b.dataset.tab = id
      return b
    }
    tabs.append(make('positions', 'Positions'), make('orders', 'Orders'), make('history', 'History'))
    return tabs
  }

  private render(): void {
    const s = this.session.snapshot
    if (!this.session.ready) {
      this.accountStrip.innerHTML = ''
      this.accountStrip.appendChild(emptyRow(`Connecting to your ${this.session.mode ?? 'paper'} account…`))
      this.ticket.element.style.display = 'none'
      this.tabsBar.style.display = 'none'
      this.tablesHost.innerHTML = ''
      return
    }
    this.ticket.element.style.display = ''
    this.tabsBar.style.display = ''
    this.renderAccount(s)
    this.ticket.render()
    for (const b of this.tabsBar.querySelectorAll<HTMLElement>('.wd-trade-tab')) {
      b.classList.toggle('is-active', b.dataset.tab === this.tab)
    }
    this.tablesHost.innerHTML = ''
    if (this.tab === 'positions') this.tablesHost.appendChild(this.renderPositions(s))
    else if (this.tab === 'orders') this.tablesHost.appendChild(this.renderOrders(s))
    else this.tablesHost.appendChild(this.renderHistory(s))
  }

  private renderAccount(s: SimSnapshot): void {
    this.accountStrip.innerHTML = ''
    const stat = (label: string, value: string, cls = ''): HTMLElement => {
      const wrap = el('div', 'wd-trade-stat')
      const l = el('span', 'wd-trade-stat-label')
      l.textContent = label
      const v = el('span', `wd-trade-stat-value ${cls}`)
      v.textContent = value
      wrap.append(l, v)
      return wrap
    }
    const c = s.account.currency
    const upnlCls =
      s.account.unrealizedPnl > 0 ? 'is-up' : s.account.unrealizedPnl < 0 ? 'is-down' : ''
    this.accountStrip.append(
      stat('Balance', `${s.account.balance.toFixed(2)} ${c}`),
      stat('Equity', `${s.account.equity.toFixed(2)} ${c}`),
      stat('Unrealized', `${formatPnl(s.account.unrealizedPnl)} ${c}`, upnlCls),
      stat('Open', String(s.trades.filter((t) => t.closedAt === null).length))
    )
    const flatten = button('kc-button kc-button-outline wd-trade-flatten', 'Flatten all', () => {
      void this.session.flatten().catch((err) => this.reportError(err))
    })
    if (s.trades.every((t) => t.closedAt !== null) && s.orders.every((o) => o.status !== 'pending')) {
      flatten.disabled = true
    }
    this.accountStrip.appendChild(flatten)
  }

  private renderPositions(s: SimSnapshot): HTMLElement {
    const open = s.trades.filter((t) => t.closedAt === null)
    if (open.length === 0) return emptyRow('No open positions')
    const table = tableEl(['', 'Instrument', 'Units', 'Entry', 'Price', 'SL', 'TP', 'Pips', 'P&L', ''])
    const tbody = table.tBodies[0]
    for (const trade of open) {
      const key = trade.symbol
      const info = this.ctx.instrumentFor(key)
      const prec = info.precision
      const quote = s.quotes[key]
      const mark = quote ? (trade.side === 'buy' ? quote.bid : quote.ask) : null
      const pnl = tradePnl(trade, quote)
      const pips = tradePips(trade, quote, info.pipSize)
      const dir = pnl !== null && pnl > 0 ? 'is-up' : pnl !== null && pnl < 0 ? 'is-down' : ''
      const row = document.createElement('tr')
      row.append(
        cell(sideBadge(trade.side)),
        cell(shortSymbol(key)),
        cell(formatUnits(trade.units)),
        cell(formatPrice(trade.entryPrice, prec)),
        cell(formatPrice(mark, prec)),
        editableCell(formatPrice(trade.stopLoss, prec), (raw) => this.editTrade(trade, 'stopLoss', raw)),
        editableCell(formatPrice(trade.takeProfit, prec), (raw) => this.editTrade(trade, 'takeProfit', raw)),
        cell(formatPips(pips), dir),
        cell(formatPnl(pnl), dir),
        cell(
          button('kc-button kc-button-outline wd-trade-close', 'Close', () => {
            void this.session.closeTrade(trade.id).catch((err) => this.reportError(err))
          })
        )
      )
      tbody.appendChild(row)
    }
    return table
  }

  private renderOrders(s: SimSnapshot): HTMLElement {
    const pending = s.orders.filter((o) => o.status === 'pending')
    if (pending.length === 0) return emptyRow('No working orders')
    const table = tableEl(['', 'Instrument', 'Type', 'Units', 'Price', 'SL', 'TP', ''])
    const tbody = table.tBodies[0]
    for (const order of pending) {
      const prec = this.ctx.instrumentFor(order.symbol).precision
      const row = document.createElement('tr')
      row.append(
        cell(sideBadge(order.side)),
        cell(shortSymbol(order.symbol)),
        cell(order.type.toUpperCase()),
        cell(formatUnits(order.units)),
        editableCell(formatPrice(order.price, prec), (raw) => this.editOrder(order, 'price', raw)),
        editableCell(formatPrice(order.stopLoss, prec), (raw) => this.editOrder(order, 'stopLoss', raw)),
        editableCell(formatPrice(order.takeProfit, prec), (raw) => this.editOrder(order, 'takeProfit', raw)),
        cell(
          button('kc-button kc-button-outline wd-trade-close', 'Cancel', () => {
            void this.session.cancelOrder(order.id).catch((err) => this.reportError(err))
          })
        )
      )
      tbody.appendChild(row)
    }
    return table
  }

  private renderHistory(s: SimSnapshot): HTMLElement {
    const closed = s.trades
      .filter((t) => t.closedAt !== null)
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    if (closed.length === 0) return emptyRow('No closed trades')
    const table = tableEl(['', 'Instrument', 'Units', 'Entry', 'Exit', 'Reason', 'Pips', 'P&L', 'Closed'])
    const tbody = table.tBodies[0]
    for (const trade of closed) {
      const info = this.ctx.instrumentFor(trade.symbol)
      const prec = info.precision
      const pnl = trade.realizedPnl ?? 0
      const dir = pnl > 0 ? 'is-up' : pnl < 0 ? 'is-down' : ''
      const pips =
        trade.closePrice !== null
          ? toPips(
              trade.side === 'buy'
                ? trade.closePrice - trade.entryPrice
                : trade.entryPrice - trade.closePrice,
              info.pipSize
            )
          : null
      const row = document.createElement('tr')
      row.append(
        cell(sideBadge(trade.side)),
        cell(shortSymbol(trade.symbol)),
        cell(formatUnits(trade.units)),
        cell(formatPrice(trade.entryPrice, prec)),
        cell(formatPrice(trade.closePrice, prec)),
        cell((trade.closeReason ?? '').replace('_', ' ')),
        cell(formatPips(pips), dir),
        cell(formatPnl(pnl), dir),
        cell(formatInstant(trade.closedAt))
      )
      tbody.appendChild(row)
    }
    return table
  }

  private async editTrade(trade: SimTrade, field: 'stopLoss' | 'takeProfit', raw: string): Promise<void> {
    const value = parsePriceInput(raw)
    if (value === undefined) return
    try {
      await this.session.modifyTrade(trade.id, { [field]: value })
    } catch (err) {
      this.reportError(err)
    }
  }

  private async editOrder(order: SimOrder, field: 'price' | 'stopLoss' | 'takeProfit', raw: string): Promise<void> {
    const value = parsePriceInput(raw)
    if (value === undefined) return
    if (field === 'price' && value === null) return // an order must keep a price
    try {
      await this.session.modifyOrder(order.id, { [field]: value })
    } catch (err) {
      this.reportError(err)
    }
  }

  private reportError(err: unknown): void {
    const message = err instanceof OhlcvApiError ? err.message : 'Request failed'
    // A refused edit leaves the state as it was: redraw the tables so the typed value goes.
    this.render()
    this.ticket.showError(message)
  }

  dispose(): void {
    this.unsub()
    this.shape.disconnect()
    this.ticket.dispose()
  }
}

// -- small DOM helpers ---------------------------------------------------------------------

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

function tableEl(headers: string[]): HTMLTableElement {
  const table = document.createElement('table')
  table.className = 'wd-trade-table'
  const thead = document.createElement('thead')
  const tr = document.createElement('tr')
  for (const h of headers) {
    const th = document.createElement('th')
    th.textContent = h
    tr.appendChild(th)
  }
  thead.appendChild(tr)
  table.appendChild(thead)
  table.appendChild(document.createElement('tbody'))
  return table
}

function cell(content: string | HTMLElement, cls = ''): HTMLTableCellElement {
  const td = document.createElement('td')
  if (cls) td.className = cls
  if (typeof content === 'string') td.textContent = content
  else td.appendChild(content)
  return td
}

function editableCell(value: string, onCommit: (raw: string) => void): HTMLTableCellElement {
  const td = document.createElement('td')
  td.className = 'wd-trade-editable'
  const input = document.createElement('input')
  input.type = 'text'
  input.inputMode = 'decimal'
  input.className = 'wd-trade-cell-input'
  input.value = value === '—' ? '' : value
  input.placeholder = '—'
  const original = value === '—' ? '' : value
  const commit = (): void => {
    if (input.value !== original) onCommit(input.value)
  }
  input.addEventListener('blur', commit)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur()
    if (e.key === 'Escape') {
      input.value = original
      input.blur()
    }
  })
  td.appendChild(input)
  return td
}

function sideBadge(side: 'buy' | 'sell'): HTMLElement {
  const span = el('span', `wd-trade-side-badge ${side === 'buy' ? 'is-buy' : 'is-sell'}`)
  span.textContent = side === 'buy' ? 'L' : 'S'
  return span
}

function emptyRow(text: string): HTMLElement {
  const div = el('div', 'wd-trade-empty')
  div.textContent = text
  return div
}

function shortSymbol(key: string): string {
  return key.includes(':') ? key.split(':', 2)[1] : key
}

/** '' -> null (clear), a number -> that number, unparsable -> undefined (ignore). */
function parsePriceInput(raw: string): number | null | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isFinite(value) && value > 0 ? value : undefined
}
