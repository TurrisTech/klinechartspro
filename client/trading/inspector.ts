import { OhlcvApiError } from '../config'
import { createDockableWindow, type DockableWindow, type Point } from '../chrome/window'
import type { InstrumentInfo } from './instrument'
import { findInspected, type Inspected, positionStats, type StatRow } from './stats'
import type { TradingSession } from './session'

// The position popup: click a position -- its line or label on a pane, its row on the order card,
// its row in the account window's tables -- and a small window opens beside the click with that
// position's stats (stats.ts), live, and the actions that end it. The same click selects the
// position on every pane showing its instrument (TradingOverlays owns the one selection).
//
// Non-modal: a floating `DockableWindow` that never docks, dragged by its title and closed from its
// ×. It follows the selection while it is open -- a click on another position, or a fill selecting
// the new trade, switches it -- and lets go when the selection is let go. A trade that closes while
// shown stays shown, as the closed trade it now is; an order that fills becomes its trade.

export interface InspectorContext {
  session: TradingSession
  instrumentFor: (key: string) => InstrumentInfo
  /** The chart's container, which the popup stays inside. */
  bounds: HTMLElement
  /** Storage-key prefix ('paper', 'replay'). */
  tag: string
  theme: string
  /** The wall's selection (TradingOverlays). */
  selected(): string | null
  select(id: string | null): void
  onSelectionChange(listener: (id: string | null) => void): () => void
}

/** A click this recent placed the popup beside itself. Older, it opens where it last was. */
const CLICK_MS = 1_500
const CONFIRM_MS = 3_000

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export class PositionInspector {
  private readonly win: DockableWindow
  private readonly headline: HTMLElement
  private readonly grid: HTMLElement
  private readonly actions: HTMLElement
  private readonly errorNode: HTMLElement
  private readonly closeHalf: HTMLButtonElement
  private readonly closeAll: HTMLButtonElement
  private readonly cancel: HTMLButtonElement
  private id: string | null = null
  private open = false
  private armed: string | null = null
  private armTimer: ReturnType<typeof setTimeout> | null = null
  private rowSignature = ''
  private values: HTMLElement[] = []
  private lastClick: { point: Point; at: number } | null = null
  private readonly unsubscribe: Array<() => void> = []

  constructor(private readonly ctx: InspectorContext) {
    this.win = createDockableWindow({
      key: `${ctx.tag}-position`,
      className: 'wd-trade-window wd-pos-window',
      title: 'Position',
      bounds: ctx.bounds,
      theme: ctx.theme,
      dockable: false,
      floatAnchor: 'center',
      onClose: () => this.hide()
    })
    this.win.setVisible(false)
    this.headline = h('div', 'wd-pos-headline')
    this.grid = h('dl', 'wd-pos-grid')
    this.errorNode = h('div', 'kc-field-error wd-pos-error')
    this.errorNode.hidden = true
    this.actions = h('div', 'wd-pos-actions')
    const action = (text: string, onClick: () => void, cls = 'kc-button-outline'): HTMLButtonElement => {
      const b = h('button', `kc-button ${cls} wd-pos-action`, text)
      b.type = 'button'
      b.addEventListener('click', onClick)
      return b
    }
    this.closeHalf = action('Close ½', () => this.act('half'))
    this.closeAll = action('Close', () => this.act('close'))
    this.cancel = action('Cancel order', () => this.act('cancel'))
    this.actions.append(this.closeHalf, this.closeAll, this.cancel)
    this.win.body.append(this.headline, this.grid, this.actions, this.errorNode)

    // Where the click that opens it happened. Captured on the window, before the chart layer stops
    // the event reaching anything else.
    const onPointer = (event: PointerEvent): void => {
      this.lastClick = { point: { x: event.clientX, y: event.clientY }, at: performance.now() }
    }
    window.addEventListener('pointerdown', onPointer, true)
    this.unsubscribe.push(() => window.removeEventListener('pointerdown', onPointer, true))
    this.unsubscribe.push(ctx.session.subscribe(() => this.render()))
    this.unsubscribe.push(ctx.onSelectionChange((id) => this.followSelection(id)))
  }

  isOpen(): boolean {
    return this.open
  }

  /** Show `id`'s stats: beside the click that asked, or where the popup already is. */
  show(id: string): void {
    const switching = this.id !== id
    this.id = id
    if (switching) this.disarm()
    this.errorNode.hidden = true
    const click = this.lastClick && performance.now() - this.lastClick.at < CLICK_MS ? this.lastClick.point : null
    this.render()
    if (!this.id) return
    // Already open, it stays put: moving under the pointer on every click would chase the user.
    if (this.open) return
    this.open = true
    if (click) this.win.showNear(click)
    else this.win.setVisible(true)
  }

  hide(): void {
    if (!this.open) return
    this.open = false
    this.disarm()
    this.win.setVisible(false)
    // Closing the popup lets the position go on the panes too, unless something else took over.
    if (this.id !== null && this.ctx.selected() === this.id) this.ctx.select(null)
    this.id = null
  }

  private followSelection(id: string | null): void {
    if (!this.open) return
    if (id !== null) {
      if (id !== this.id) this.show(id)
      return
    }
    // Let go of on the chart: close with it -- unless what it shows has closed, which is why the
    // selection went, and is exactly when its final figures are worth reading.
    const item = this.id ? findInspected(this.ctx.session.snapshot, this.id) : null
    if (item && !(item.kind === 'trade' && item.trade.closedAt !== null)) this.hide()
  }

  private item(): Inspected | null {
    if (!this.id) return null
    const snapshot = this.ctx.session.snapshot
    const found = findInspected(snapshot, this.id)
    if (found) return found
    // A pending order that filled is now its trade.
    const order = snapshot.orders.find((o) => o.id === this.id)
    if (order?.status === 'filled' && order.tradeId) {
      this.id = order.tradeId
      return findInspected(snapshot, order.tradeId)
    }
    return null
  }

  render(): void {
    if (!this.open && this.id === null) return
    const item = this.item()
    if (!item) {
      // Cancelled, or gone with the session: nothing left to show.
      if (this.open) this.hide()
      return
    }
    const key = item.kind === 'trade' ? item.trade.symbol : item.order.symbol
    const stats = positionStats(item, this.ctx.session.snapshot, this.ctx.instrumentFor(key))

    this.win.element.dataset.side = stats.side
    const title = this.win.element.querySelector('.wd-window-title')
    if (title) title.textContent = stats.title
    this.headline.hidden = stats.headline === null
    this.headline.textContent = stats.headline?.text ?? ''
    this.headline.className = `wd-pos-headline ${stats.headline?.tone ? `is-${stats.headline.tone}` : ''}`
    this.renderRows(stats.rows)

    const open = stats.kind === 'trade'
    this.closeHalf.hidden = !open
    this.closeAll.hidden = !open
    this.cancel.hidden = stats.kind !== 'order'
    this.actions.hidden = stats.kind === 'closed'
    this.closeHalf.disabled = !open || (item.kind === 'trade' && Math.floor(item.trade.units / 2) <= 0)
    this.closeAll.textContent = this.armed === 'close' ? 'Confirm close' : 'Close'
    this.closeAll.classList.toggle('is-armed', this.armed === 'close')
    this.win.reflow()
  }

  /** Rows are rebuilt only when WHICH rows there are changes; otherwise their values are written
   * in place, so a two-second poll does not rebuild what is being read (or selected to copy). */
  private renderRows(rows: StatRow[]): void {
    const signature = rows.map((r) => r.label).join('|')
    if (signature !== this.rowSignature) {
      this.rowSignature = signature
      this.grid.innerHTML = ''
      this.values = rows.map((row) => {
        const dt = h('dt', 'wd-pos-label', row.label)
        const dd = h('dd', 'wd-pos-value')
        this.grid.append(dt, dd)
        return dd
      })
    }
    rows.forEach((row, i) => {
      const node = this.values[i]
      node.textContent = row.value
      node.className = `wd-pos-value ${row.tone ? `is-${row.tone}` : ''}`
    })
  }

  private act(kind: 'half' | 'close' | 'cancel'): void {
    const item = this.item()
    if (!item) return
    const session = this.ctx.session
    let request: Promise<unknown>
    if (item.kind === 'order') {
      request = session.cancelOrder(item.order.id)
    } else if (kind === 'half') {
      request = session.closeTrade(item.trade.id, Math.floor(item.trade.units / 2))
    } else {
      // Closing the whole trade takes two presses, like everywhere else it can be done.
      if (this.armed !== 'close') {
        this.armed = 'close'
        if (this.armTimer) clearTimeout(this.armTimer)
        this.armTimer = setTimeout(() => {
          this.disarm()
          this.render()
        }, CONFIRM_MS)
        this.render()
        return
      }
      this.disarm()
      request = session.closeTrade(item.trade.id)
    }
    this.errorNode.hidden = true
    request.catch((err) => {
      this.errorNode.textContent = err instanceof OhlcvApiError ? err.message : 'Request failed'
      this.errorNode.hidden = false
    })
    this.render()
  }

  private disarm(): void {
    this.armed = null
    if (this.armTimer) clearTimeout(this.armTimer)
    this.armTimer = null
  }

  dispose(): void {
    this.disarm()
    for (const off of this.unsubscribe) off()
    this.win.dispose()
  }
}
