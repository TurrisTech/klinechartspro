import type { SymbolInfo } from '../../src'
import { OhlcvApiError } from '../config'
import type { SimOrder, SimSnapshot, SimTrade } from './api'
import {
  formatInstant,
  formatPips,
  formatPnl,
  formatPrice,
  formatUnits,
  pipsToPrice,
  sideLabel,
  symbolKey,
  toPips,
  tradePips,
  tradePnl
} from './format'
import type { InstrumentInfo } from './instrument'
import type { TradingSession } from './session'

// The trading panel: a bottom drawer with an account strip, an order ticket, and the
// working-orders / open-positions / history tables. It reads and acts ONLY through the
// `TradingSession` interface, so the same panel serves a later replay mode unchanged.
//
// Hand-built plain DOM, the house style for app-side chrome (client/chartlayers/settings.ts):
// the library owns Svelte, the app owns the chrome around it, and the panel reuses the
// library's own token classes (kc-button, kc-input, kc-field) so it reads as native.

export interface PanelContext {
  /** The active pane's instrument, kept current by the caller on pane/symbol change. */
  activeSymbol: () => SymbolInfo
  /** Instrument facts (precision + pip size) for a key, from the config cache. */
  instrumentFor: (key: string) => InstrumentInfo
  /** Hide the panel (the header's close button; mirrors the rail toggle). */
  onClose: () => void
  /** The header title; defaults by mode ('Paper account' / 'Replay account'). */
  title?: string
}

type Tab = 'positions' | 'orders' | 'history'

export class TradingPanel {
  readonly element: HTMLElement
  private body: HTMLElement
  private accountStrip: HTMLElement
  private ticket: OrderTicket
  private tablesHost: HTMLElement
  private tabsBar: HTMLElement
  private tab: Tab = 'positions'
  private unsub: () => void

  constructor(
    private session: TradingSession,
    private ctx: PanelContext
  ) {
    this.element = el('div', 'wd-trade-panel')
    this.element.appendChild(this.buildHeader())
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
    this.render()
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

  private buildHeader(): HTMLElement {
    const header = el('div', 'wd-trade-panel-header')
    const title = el('span', 'wd-trade-panel-title')
    title.textContent = this.ctx.title ?? (this.session.mode === 'replay' ? 'Replay account' : 'Paper account')
    const spacer = el('span', 'wd-trade-panel-spacer')
    const close = button('kc-icon-button wd-trade-close-panel', '×', () => this.ctx.onClose())
    close.title = 'Hide the trading panel'
    header.append(title, spacer, close)
    return header
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
    this.ticket.showError(message)
  }

  dispose(): void {
    this.unsub()
    this.ticket.dispose()
  }
}

// -- the order ticket ----------------------------------------------------------------------

class OrderTicket {
  readonly element: HTMLElement
  private type: 'market' | 'limit' | 'stop' = 'market'
  private side: 'buy' | 'sell' = 'buy'
  private units = 10_000
  private price = ''
  private stopLoss = ''
  private takeProfit = ''
  private protectMode: 'pips' | 'price' = 'pips'
  private error = ''
  private symbol: SymbolInfo
  private key: string

  constructor(
    private session: TradingSession,
    private ctx: PanelContext
  ) {
    this.symbol = ctx.activeSymbol()
    this.key = symbolKey(this.symbol)
    this.element = el('div', 'wd-trade-ticket')
  }

  syncInstrument(): void {
    this.symbol = this.ctx.activeSymbol()
    this.key = symbolKey(this.symbol)
    void this.session.watch(this.key).catch(() => {})
  }

  showError(message: string): void {
    this.error = message
    this.render()
  }

  render(): void {
    const s = this.session.snapshot
    const info = this.ctx.instrumentFor(this.key)
    const prec = info.precision
    const pipSize = info.pipSize
    const quote = s.quotes[this.key]
    this.element.innerHTML = ''

    // Row 1: instrument, quote, and the live spread in pips (OANDA prices in pips).
    const head = el('div', 'wd-trade-ticket-head')
    const name = el('span', 'wd-trade-ticket-symbol')
    name.textContent = shortSymbol(this.key)
    const bidask = el('span', 'wd-trade-ticket-quote')
    if (quote) {
      const spread = toPips(quote.ask - quote.bid, pipSize)
      bidask.textContent =
        `${formatPrice(quote.bid, prec)} / ${formatPrice(quote.ask, prec)}` +
        (spread !== null ? ` · ${spread.toFixed(1)} pip${spread === 1 ? '' : 's'}` : '')
    } else {
      bidask.textContent = 'no quote yet'
    }
    head.append(name, bidask)
    this.element.appendChild(head)

    // Row 2: side + type.
    const controls = el('div', 'wd-trade-ticket-row')
    controls.appendChild(
      this.segmented(['buy', 'sell'], this.side, (v) => {
        this.side = v as 'buy' | 'sell'
        this.render()
      }, { buy: 'wd-trade-buy', sell: 'wd-trade-sell' })
    )
    controls.appendChild(
      this.segmented(['market', 'limit', 'stop'], this.type, (v) => {
        this.type = v as typeof this.type
        this.render()
      })
    )
    this.element.appendChild(controls)

    // Row 3: units + price (if resting).
    const fields = el('div', 'wd-trade-ticket-fields')
    fields.appendChild(
      this.numberField('Units', String(this.units), (v) => {
        this.units = Number(v) || 0
      }, 'wd-trade-units')
    )
    if (this.type !== 'market') {
      fields.appendChild(this.numberField('Price', this.price, (v) => { this.price = v }))
    }
    // Stop loss / take profit: a pip distance for a forex instrument (the OANDA-native way),
    // or an absolute price. The toggle only shows when the instrument has a pip size.
    const pipMode = pipSize !== null && this.protectMode === 'pips'
    fields.appendChild(
      this.numberField(pipMode ? 'Stop loss (pips)' : 'Stop loss', this.stopLoss, (v) => {
        this.stopLoss = v
      })
    )
    fields.appendChild(
      this.numberField(pipMode ? 'Take profit (pips)' : 'Take profit', this.takeProfit, (v) => {
        this.takeProfit = v
      })
    )
    this.element.appendChild(fields)

    if (pipSize !== null) {
      const modeRow = el('div', 'wd-trade-ticket-mode')
      const label = el('span', 'wd-trade-field-label')
      label.textContent = 'SL / TP as'
      modeRow.append(
        label,
        this.segmented(['pips', 'price'], this.protectMode, (v) => {
          this.protectMode = v as 'pips' | 'price'
          this.render()
        })
      )
      this.element.appendChild(modeRow)
    }

    if (this.error) {
      const err = el('div', 'kc-field-error wd-trade-ticket-error')
      err.textContent = this.error
      this.element.appendChild(err)
    }

    const submit = button(
      `kc-button kc-button-primary wd-trade-submit ${this.side === 'buy' ? 'is-buy' : 'is-sell'}`,
      `${sideLabel(this.side)} ${this.type === 'market' ? 'market' : this.type}`,
      () => void this.submit()
    )
    if (!quote) submit.disabled = true
    this.element.appendChild(submit)
  }

  private async submit(): Promise<void> {
    this.error = ''
    const price = this.type === 'market' ? undefined : Number(this.price)
    if (this.type !== 'market' && (!price || !Number.isFinite(price))) {
      this.showError('A limit or stop order needs a price')
      return
    }
    const info = this.ctx.instrumentFor(this.key)
    const quote = this.session.snapshot.quotes[this.key]
    // The price a pip distance is measured from: the resting price for a limit/stop, else the
    // side the order fills on (ask for a buy, bid for a sell).
    const anchor = price ?? (quote ? (this.side === 'buy' ? quote.ask : quote.bid) : undefined)
    let stopLoss: number | undefined
    let takeProfit: number | undefined
    try {
      stopLoss = this.resolveProtection(this.stopLoss, 'stop', anchor, info.pipSize)
      takeProfit = this.resolveProtection(this.takeProfit, 'target', anchor, info.pipSize)
    } catch (err) {
      this.showError(err instanceof Error ? err.message : 'Invalid stop/target')
      return
    }
    try {
      await this.session.watch(this.key)
      await this.session.placeOrder({
        symbol: this.key,
        side: this.side,
        type: this.type,
        units: this.units,
        price,
        stopLoss,
        takeProfit
      })
      this.price = ''
      this.stopLoss = ''
      this.takeProfit = ''
      this.render()
    } catch (err) {
      this.showError(err instanceof OhlcvApiError ? err.message : 'Order rejected')
    }
  }

  /** A stop/target field to an absolute price: a pip distance from the anchor in pip mode, or
   * the value as-is in price mode. Empty stays undefined (no protection). */
  private resolveProtection(
    raw: string,
    which: 'stop' | 'target',
    anchor: number | undefined,
    pipSize: number | null
  ): number | undefined {
    const trimmed = raw.trim()
    if (trimmed === '') return undefined
    const value = Number(trimmed)
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${which}`)
    if (pipSize === null || this.protectMode === 'price') return value
    if (anchor === undefined) throw new Error('No price to measure pips from yet')
    // A long's stop is below and its target above; a short's the reverse.
    const awayBelow = which === 'stop' ? this.side === 'buy' : this.side === 'sell'
    return Number(
      pipsToPrice(anchor, value, pipSize, awayBelow).toFixed(this.ctx.instrumentFor(this.key).precision)
    )
  }

  private segmented(
    options: string[],
    current: string,
    onPick: (value: string) => void,
    classes: Record<string, string> = {}
  ): HTMLElement {
    const group = el('div', 'wd-trade-segmented')
    for (const option of options) {
      const b = button(
        `wd-trade-seg ${classes[option] ?? ''}`,
        option[0].toUpperCase() + option.slice(1),
        () => onPick(option)
      )
      b.classList.toggle('is-active', option === current)
      group.appendChild(b)
    }
    return group
  }

  private numberField(label: string, value: string, onInput: (value: string) => void, cls = ''): HTMLElement {
    const field = el('label', `wd-trade-field ${cls}`)
    const l = el('span', 'wd-trade-field-label')
    l.textContent = label
    const input = document.createElement('input')
    input.type = 'text'
    input.inputMode = 'decimal'
    input.className = 'kc-input wd-trade-input'
    input.value = value
    input.addEventListener('input', () => onInput(input.value))
    field.append(l, input)
    return field
  }

  dispose(): void {}
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
