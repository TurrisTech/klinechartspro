import { OhlcvApiError } from '../config'
import { createDockableWindow, type DockableWindow, type Point } from '../chrome/window'
import { amendmentRefusal, describeAmendment } from './amend'
import type { InstrumentInfo } from './instrument'
import { Arming, armKey, ConfirmBar, type ConfirmView, FigureList, h, kbtn, type TradeAction, TradeActions } from './kit'
import { closeFraction, reverseTrade, tradeActionsView } from './manage'
import { pricingContext } from './metrics'
import type { PanelAmendments } from './panel'
import { tradePrefs } from './prefs'
import type { TradingSession } from './session'
import { findInspected, type Inspected, positionStats } from './stats'

// The position popup: click a position -- its line or label on a pane, its row on the order card,
// its row in the account window's tables -- and a small window opens beside the click with that
// position's stats (stats.ts), live, and the actions that end it. The same click selects the
// position on every pane showing its instrument (TradingOverlays owns the one selection).
//
// Non-modal: a floating `DockableWindow` that never docks, dragged by its title and closed from its
// ×. It follows the selection while it is open -- a click on another position, or a fill selecting
// the new trade, switches it -- and lets go when the selection is let go. A trade that closes while
// shown stays shown, as the closed trade it now is; an order that fills becomes its trade.
//
// Built from the trading kit like the trade box and the order card (user, 2026-10-03): its figures
// are the same rows, an open trade's actions are the same row as the card's -- Breakeven, Reverse,
// Close ¼ ½ ¾ All -- with the same two-press rule (or one press, one-click), and a breakeven it
// proposes asks the same question in the same bar, here as well as on the pane.

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
  /** The waiting change shared with the pane and the account window (TradingOverlays). */
  amendments: PanelAmendments
}

/** A click this recent placed the popup beside itself. Older, it opens where it last was. */
const CLICK_MS = 1_500

export class PositionInspector {
  private readonly win: DockableWindow
  private readonly headline: HTMLElement
  private readonly figures: FigureList
  private readonly confirmBar: ConfirmBar
  private readonly tradeActions: TradeActions
  private readonly orderActions: HTMLElement
  private readonly cancel: HTMLButtonElement
  private readonly errorNode: HTMLElement
  private readonly arming: Arming
  private id: string | null = null
  private open = false
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
    this.win.body.classList.add('wd-tk')
    this.arming = new Arming(() => this.render())
    this.headline = h('div', 'wd-pos-headline')
    this.figures = new FigureList('is-single')
    this.confirmBar = new ConfirmBar(
      () => ctx.amendments.confirm().catch((err) => this.showError(err)),
      () => ctx.amendments.cancel()
    )
    this.tradeActions = new TradeActions((action) => this.act(action))
    this.orderActions = h('div', 'wd-tk-row is-end')
    this.cancel = kbtn('Cancel order', () => this.act({ kind: 'cancel' }), ['danger'])
    this.orderActions.append(this.cancel)
    this.errorNode = h('div', 'wd-tk-problem is-error')
    this.errorNode.setAttribute('role', 'alert')
    this.errorNode.hidden = true
    this.win.body.append(this.headline, this.confirmBar.element, this.figures.element, this.tradeActions.element, this.orderActions, this.errorNode)

    // Where the click that opens it happened. Captured on the window, before the chart layer stops
    // the event reaching anything else.
    const onPointer = (event: PointerEvent): void => {
      this.lastClick = { point: { x: event.clientX, y: event.clientY }, at: performance.now() }
    }
    window.addEventListener('pointerdown', onPointer, true)
    this.unsubscribe.push(() => window.removeEventListener('pointerdown', onPointer, true))
    this.unsubscribe.push(ctx.session.subscribe(() => this.render()))
    this.unsubscribe.push(ctx.onSelectionChange((id) => this.followSelection(id)))
    this.unsubscribe.push(ctx.amendments.onChange(() => this.render()))
  }

  isOpen(): boolean {
    return this.open
  }

  /** Show `id`'s stats: beside the click that asked, or where the popup already is. */
  show(id: string): void {
    const switching = this.id !== id
    this.id = id
    if (switching) this.arming.disarm()
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
    this.arming.disarm()
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
    const snapshot = this.ctx.session.snapshot
    const info = this.ctx.instrumentFor(key)
    const stats = positionStats(item, snapshot, info)

    this.win.element.dataset.side = stats.side
    const title = this.win.element.querySelector('.wd-window-title')
    if (title) title.textContent = stats.title
    this.headline.hidden = stats.headline === null
    this.headline.textContent = stats.headline?.text ?? ''
    this.headline.className = `wd-pos-headline ${stats.headline?.tone ? `is-${stats.headline.tone}` : ''}`
    this.figures.update(stats.rows)
    this.confirmBar.update(this.question(item, info))

    const ctx = pricingContext(key, info, snapshot.account, snapshot.quotes[key], snapshot.quotes)
    const armed = this.arming.key
    this.tradeActions.element.hidden = stats.kind !== 'trade'
    if (stats.kind === 'trade' && item.kind === 'trade') this.tradeActions.update(tradeActionsView(item.trade, ctx, armed))
    this.orderActions.hidden = stats.kind !== 'order'
    const cancelArmed = item.kind === 'order' && armed === armKey.cancel(item.order.id)
    this.cancel.textContent = cancelArmed ? 'Confirm cancel' : 'Cancel order'
    this.cancel.classList.toggle('is-armed', cancelArmed)
    this.win.reflow()
  }

  /** The waiting change, when it is to the position shown. */
  private question(item: Inspected, info: InstrumentInfo): ConfirmView | null {
    const a = this.ctx.amendments.current()
    const id = item.kind === 'trade' ? item.trade.id : item.order.id
    if (!a || a.id !== id) return null
    const snapshot = this.ctx.session.snapshot
    const words = describeAmendment(a, snapshot, info)
    if (!words) return null
    return { ...words, refusal: amendmentRefusal(a, snapshot, info), sending: this.ctx.amendments.sending() }
  }

  private act(action: TradeAction | { kind: 'cancel' }): void {
    const item = this.item()
    if (!item) return
    const session = this.ctx.session
    const oneClick = tradePrefs().oneClick
    this.errorNode.hidden = true
    if (item.kind === 'order') {
      if (action.kind !== 'cancel' || !this.arming.press(armKey.cancel(item.order.id), oneClick)) return
      session.cancelOrder(item.order.id).catch((err) => this.showError(err))
      return
    }
    const trade = item.trade
    const snapshot = session.snapshot
    const ctx = pricingContext(trade.symbol, this.ctx.instrumentFor(trade.symbol), snapshot.account, snapshot.quotes[trade.symbol], snapshot.quotes)
    if (action.kind === 'breakeven') {
      // Proposed, like every change to a working stop: the bar above asks.
      this.ctx.amendments.propose({ owner: 'trade', id: trade.id, role: 'stop', price: trade.entryPrice })
      return
    }
    if (action.kind === 'reverse') {
      if (!this.arming.press(armKey.reverse(trade.id), oneClick)) return
      reverseTrade(session, trade, ctx).catch((err) => this.showError(err))
      return
    }
    if (action.kind !== 'close' || !this.arming.press(armKey.close(trade.id, action.fraction), oneClick)) return
    closeFraction(session, trade, action.fraction, ctx).catch((err) => this.showError(err))
  }

  private showError(err: unknown): void {
    this.errorNode.textContent = err instanceof OhlcvApiError ? err.message : err instanceof Error ? err.message : 'Request failed'
    this.errorNode.hidden = false
    this.win.reflow()
  }

  dispose(): void {
    this.arming.disarm()
    for (const off of this.unsubscribe) off()
    this.win.dispose()
  }
}
