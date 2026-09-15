import type { Chart, Coordinate, Crosshair, Point } from 'klinecharts'
import type { ChartProPane } from '../../src'
import { OhlcvApiError } from '../config'
import type { SimOrder, SimSnapshot, SimTrade } from './api'
import { formatMoney, formatPercent, formatPrice, formatUnitsShort, symbolKey } from './format'
import { type InstrumentInfo, seedInstrument } from './instrument'
import {
  type Amendment,
  type DraftController,
  type DraftOrder,
  draftFor,
  isComposing,
  type LineSpec,
  lineColor,
  lineKey,
  linesFor,
  type OverlayColors,
  workingFor
} from './lines'
import {
  closingPrice,
  defaultProtection,
  fillingPrice,
  layoutLabels,
  levelForBalancePercent,
  orderFigures,
  outcome,
  type PricingContext,
  pricingContext,
  protectionValid,
  restingPriceValid,
  roundTo,
  targetForReward,
  tradeFigures
} from './metrics'
import { type CardAction, h, moveText, OrderCard } from './ordercard'
import { tradePrefs } from './prefs'
import type { TradingSession } from './session'

// The HTML half of what a trading session puts on one candle pane: a LABEL on every trade line
// and the ORDER CARD (ordercard.ts). Mounted inside klinecharts' own price-area container
// (`getDom('candle_pane', 'main')`), which is absolutely positioned over exactly the candles and
// clips to them -- so the layer needs no inset arithmetic for the axes or the sub-panes below,
// and follows a separator drag for free.
//
// LABELS sit against the right edge of the price area, beside the axis tag their line already
// has, which makes each line read as one object: [SL −20.0p −20.00 ×][1.09000]. Close lines
// would stack their labels on top of each other, so placement is `layoutLabels`: every label as
// near its line as it can be without overlapping, with a leader back to the line when it had to
// move, and a label whose line is off the pane pinned to the edge it left by.
//
// DRAGGING, from the label. A stop, a target or a pending order's price follows the pointer, the
// canvas line with it (`previewLine`), and the label shows what that price would realise while
// it moves -- pips, amount -- and whether the engine would refuse it (a long's stop above the
// bid). Release PROPOSES the change: the line stays where it was dropped, its label turns into
// Confirm / x, the card asks the same question, and nothing is sent until Confirm (user,
// 2026-09-15: always confirm an interactive stop or target change). The add, remove, preset and
// breakeven buttons propose the same way. A refused or cancelled drag (Escape, pointercancel)
// puts the line back. Dragging the line itself goes through `beginCanvasDrag`/`canvasDragTo`/
// `endCanvasDrag` to the same readout and the same commit.
//
// A DRAFT -- the order being written in the ticket -- is drawn once it has a level of its own, and
// kept apart from what is already working so the two cannot be mistaken for each other: its labels
// are outlined and say "Draft", they hang in their OWN column to the
// left of the working orders' labels (a draft stop beside a real stop reads side by side on one
// line, never interleaved), and while it is being composed everything else on the pane recedes --
// dimmed lines, dimmed labels that come back on hover, faint bands, collapsed card rows. Dragging a
// draft line writes straight into the ticket; × discards the draft and the pane is as it was.
//
// EVENTS never reach the chart. klinecharts listens on its root for mouse and touch input, the
// wall pane for pointerdown (pan tracking, click-to-scroll) and the price watches for
// contextmenu and a long-press, so a press on a label or the card would otherwise also start a
// pan, seek the wall, or open the watch menu. `mouseup`, and a `mousemove` with a button down, are
// deliberately let through: a chart pan that ENDS over the card must still deliver its release.

const CANDLE_PANE = 'candle_pane'
/** Below either, the pane is phone-sized: short labels, a full-width card that starts rolled up. */
const COMPACT_WIDTH = 520
const COMPACT_HEIGHT = 300
const DRAG_THRESHOLD_PX = 3
const FLASH_MS = 6_000
const ERROR_MS = 5_000
const CONFIRM_MS = 3_000
/** A new stop or target starts this share of the visible price range away. */
const DEFAULT_DISTANCE_FRACTION = 0.12
const STOPPED_EVENTS = ['pointerdown', 'mousedown', 'touchstart', 'touchmove', 'touchend', 'click', 'dblclick', 'contextmenu', 'wheel']

export interface LayerHost {
  readonly tag: string
  readonly session: TradingSession
  readonly colors: OverlayColors
  instrumentFor(key: string): InstrumentInfo
  selected(): string | null
  select(id: string | null): void
  /** Move a canvas line (and its bracket) to `price` without committing. */
  previewLine(line: LineSpec, price: number): void
  /** Hold canvas rebuilds for a drag and its amendment; `release(true)` redraws from the snapshot. */
  hold(): void
  release(restore: boolean): void
  /** The on-chart change waiting for confirmation, and whether it is being sent. */
  amendment(): Amendment | null
  sending(): boolean
  /** Put a change to a working stop, target or pending price up for confirmation. */
  propose(change: Omit<Amendment, 'from'>): boolean
  confirmAmendment(): Promise<void>
  cancelAmendment(): void
  /** The ticket's order, while the account window is open. */
  readonly draft?: DraftController
  isCollapsed(compact: boolean): boolean
  setCollapsed(compact: boolean, collapsed: boolean): void
}

interface DragState {
  line: LineSpec
  price: number
  source: 'label' | 'canvas'
  pointerId: number | null
  startY: number
  moved: boolean
}

type LabelAction = 'stop' | 'target' | 'remove' | 'place' | 'confirm' | 'cancel'

class LineLabel {
  readonly element: HTMLElement
  readonly leader: HTMLElement
  readonly name: HTMLElement
  readonly move: HTMLElement
  readonly amount: HTMLElement
  readonly addStop: HTMLButtonElement
  readonly addTarget: HTMLButtonElement
  readonly remove: HTMLButtonElement
  readonly place: HTMLButtonElement
  readonly confirm: HTMLButtonElement
  readonly cancel: HTMLButtonElement
  line: LineSpec

  constructor(line: LineSpec, onAction: (label: LineLabel, action: LabelAction) => void) {
    this.line = line
    this.element = h('div', 'wd-oc-tag')
    this.leader = h('span', 'wd-oc-tag-leader')
    this.leader.setAttribute('aria-hidden', 'true')
    this.name = h('span', 'wd-oc-tag-name')
    this.move = h('span', 'wd-oc-tag-move')
    this.amount = h('span', 'wd-oc-tag-amount')
    const make = (className: string, text: string, action: LabelAction): HTMLButtonElement => {
      const b = h('button', `wd-oc-tag-btn ${className}`, text)
      b.type = 'button'
      b.addEventListener('click', () => onAction(this, action))
      return b
    }
    this.addStop = make('is-add', 'SL', 'stop')
    this.addTarget = make('is-add', 'TP', 'target')
    this.remove = make('is-remove', '×', 'remove')
    this.place = make('is-place', 'Place', 'place')
    this.place.hidden = true
    this.confirm = make('is-confirm', 'Confirm', 'confirm')
    this.cancel = make('is-remove', '×', 'cancel')
    this.confirm.hidden = true
    this.cancel.hidden = true
    this.cancel.setAttribute('aria-label', 'Cancel this change')
    this.element.append(
      this.leader,
      this.name,
      this.move,
      this.amount,
      this.addStop,
      this.addTarget,
      this.place,
      this.confirm,
      this.cancel,
      this.remove
    )
  }
}

export class OnChartLayer {
  private readonly root: HTMLElement
  private readonly labelsHost: HTMLElement
  /** The draft's labels: a column of their own, left of the working orders'. */
  private readonly draftLabelsHost: HTMLElement
  private readonly card: OrderCard
  private readonly labels = new Map<string, LineLabel>()
  private main: HTMLElement | null = null
  private key = ''
  private snapshot: SimSnapshot | null = null
  private lines: LineSpec[] = []
  private draft: DraftOrder | null = null
  private drag: DragState | null = null
  private armed: string | null = null
  private armTimer: ReturnType<typeof setTimeout> | null = null
  private compact = false
  private raf = 0
  private disposed = false
  private readonly resize: ResizeObserver
  private readonly stop = (event: Event): void => {
    event.stopPropagation()
    if (event.type === 'contextmenu') event.preventDefault()
  }
  /** The price axis can be dragged to rescale without any visible-range dispatch, so a press
   * anywhere on the chart keeps the labels on their lines frame by frame. */
  private readonly onChartPointerMove = (event: PointerEvent): void => {
    if (event.buttons !== 0) this.schedule()
  }
  /** Hovering a label or the card is not pointing at a price: the crosshair goes, rather than
   * tracking underneath the widget. Only a button-less move is kept from the chart -- one with a
   * button down may be a pan that started on the candles and must keep reaching klinecharts. */
  private hovering = false
  private readonly onHover = (event: MouseEvent): void => {
    if (event.buttons !== 0) return
    event.stopPropagation()
    if (this.hovering) return
    this.hovering = true
    try {
      this.chart.executeAction('onCrosshairChange', undefined as unknown as Crosshair)
    } catch {
      // chart disposed
    }
  }
  private readonly onHoverEnd = (event: MouseEvent): void => {
    if (!(event.relatedTarget instanceof Node) || !this.root.contains(event.relatedTarget)) this.hovering = false
  }
  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    if (this.drag) this.cancelDrag()
    else if (this.host.amendment()) this.host.cancelAmendment()
  }

  constructor(
    private readonly pane: ChartProPane,
    private readonly chart: Chart,
    private readonly host: LayerHost
  ) {
    this.root = h('div', 'wd-oc')
    this.labelsHost = h('div', 'wd-oc-tags')
    this.draftLabelsHost = h('div', 'wd-oc-tags is-draft-column')
    this.card = new OrderCard((action) => this.perform(action))
    this.root.append(this.labelsHost, this.draftLabelsHost, this.card.element)
    for (const type of STOPPED_EVENTS) this.root.addEventListener(type, this.stop, { passive: type !== 'contextmenu' })
    this.root.addEventListener('mousemove', this.onHover, { passive: true })
    this.root.addEventListener('mouseout', this.onHoverEnd, { passive: true })
    this.resize = new ResizeObserver(() => this.schedule())
    chart.getDom()?.addEventListener('pointermove', this.onChartPointerMove, { passive: true })
    chart.getDom()?.addEventListener('pointerup', this.onChartPointerMove, { passive: true })
    window.addEventListener('keydown', this.onKey)
    this.mount()
  }

  // -- mounting and layout ----------------------------------------------------------------------

  /** Attach to the candle pane's price area, re-attaching if klinecharts replaced it. */
  private mount(): HTMLElement | null {
    const main = this.chart.getDom(CANDLE_PANE, 'main')
    if (!main) return null
    if (main !== this.main || this.root.parentElement !== main) {
      if (this.main) this.resize.unobserve(this.main)
      main.appendChild(this.root)
      this.resize.observe(main)
      this.main = main
    }
    return main
  }

  schedule(): void {
    if (this.raf !== 0 || this.disposed) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.layout()
    })
  }

  private priceToY(price: number): number | null {
    const c = this.chart.convertToPixel({ value: price }, { paneId: CANDLE_PANE }) as Partial<Coordinate>
    return typeof c?.y === 'number' && Number.isFinite(c.y) ? c.y : null
  }

  private yToPrice(y: number): number | null {
    const points = this.chart.convertFromPixel([{ y }], { paneId: CANDLE_PANE }) as Array<Partial<Point>>
    const value = points[0]?.value
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  private layout(): void {
    const main = this.mount()
    if (!main || this.disposed) return
    const width = main.clientWidth
    const height = main.clientHeight
    if (width === 0 || height === 0) return
    const compact = width < COMPACT_WIDTH || height < COMPACT_HEIGHT
    if (compact !== this.compact) {
      this.compact = compact
      this.render(this.snapshot)
      return
    }
    this.root.style.setProperty('--wd-oc-pane-height', `${height}px`)

    // Two columns laid out independently: the working orders' labels against the axis, the draft's
    // to their left, clear of the widest of them.
    const working = this.layoutColumn(this.lines.filter((l) => l.owner !== 'draft'), height)
    this.draftLabelsHost.style.right = `${6 + (working > 0 ? working + 8 : 0)}px`
    this.layoutColumn(this.lines.filter((l) => l.owner === 'draft'), height)
  }

  /** Places one column's labels; returns the column's width. */
  private layoutColumn(lines: LineSpec[], height: number): number {
    const placed: Array<{ label: LineLabel; y: number }> = []
    const desired: number[] = []
    let labelHeight = 0
    let width = 0
    for (const line of lines) {
      const label = this.labels.get(lineKey(line))
      if (!label) continue
      const price = this.drag && lineKey(this.drag.line) === lineKey(line) ? this.drag.price : line.price
      const y = this.priceToY(price)
      if (y === null) {
        label.element.hidden = true
        continue
      }
      label.element.hidden = false
      labelHeight = Math.max(labelHeight, label.element.offsetHeight)
      width = Math.max(width, label.element.offsetWidth)
      label.element.dataset.edge = y < 0 ? 'above' : y > height ? 'below' : ''
      if (this.drag && lineKey(this.drag.line) === lineKey(line)) {
        // The dragged label follows the pointer exactly; the rest make room around where it was.
        this.place(label, y, y, height, labelHeight || 20)
        continue
      }
      placed.push({ label, y })
      desired.push(y)
    }
    const size = (labelHeight || 20) + 2
    const ys = layoutLabels(desired, height, size)
    for (const [i, { label, y }] of placed.entries()) this.place(label, y, ys[i], height, labelHeight || 20)
    return width
  }

  private place(label: LineLabel, lineY: number, at: number, height: number, labelHeight: number): void {
    const top = Math.min(Math.max(at, labelHeight / 2), Math.max(height - labelHeight / 2, labelHeight / 2))
    label.element.style.transform = `translate3d(0, ${Math.round(top - labelHeight / 2)}px, 0)`
    const dy = lineY - top
    const onPane = lineY >= 0 && lineY <= height
    if (onPane && Math.abs(dy) > labelHeight / 2) {
      label.leader.hidden = false
      label.leader.style.top = `calc(50% + ${Math.min(0, dy)}px)`
      label.leader.style.height = `${Math.abs(dy)}px`
    } else {
      label.leader.hidden = true
    }
  }

  // -- rendering ----------------------------------------------------------------------------------

  private pricing(snapshot: SimSnapshot): PricingContext {
    const info = this.host.instrumentFor(this.key)
    return pricingContext(this.key, info, snapshot.account, snapshot.quotes[this.key], snapshot.quotes)
  }

  render(snapshot: SimSnapshot | null): void {
    if (this.disposed) return
    this.snapshot = snapshot
    const symbol = this.pane.getSymbol()
    const key = symbolKey(symbol)
    if (key !== this.key) {
      this.key = key
      seedInstrument(key, symbol.pricePrecision)
      for (const label of this.labels.values()) label.element.remove()
      this.labels.clear()
      if (this.drag) this.cancelDrag()
    }
    this.mount()
    this.root.classList.toggle('is-compact', this.compact)

    if (!snapshot || !this.host.session.ready) {
      this.lines = []
      for (const label of this.labels.values()) label.element.remove()
      this.labels.clear()
      this.card.element.hidden = true
      return
    }

    const ctx = this.pricing(snapshot)
    const { trades, orders } = workingFor(snapshot, key)
    this.draft = draftFor(this.host.draft?.draft() ?? null, key)
    const composing = isComposing(this.draft)
    this.root.classList.toggle('is-drafting', composing)
    // Composing a draft, nothing else is selected: its card row stays shut and its band faint.
    const selected = composing ? null : this.effectiveSelection(trades, orders)
    this.lines = linesFor(snapshot, key, this.draft)

    const wanted = new Set<string>()
    for (const line of this.lines) {
      const k = lineKey(line)
      wanted.add(k)
      let label = this.labels.get(k)
      if (!label) {
        label = new LineLabel(line, (l, action) => this.labelAction(l, action))
        this.bindDrag(label)
        this.labels.set(k, label)
        ;(line.owner === 'draft' ? this.draftLabelsHost : this.labelsHost).appendChild(label.element)
      }
      label.line = line
      const price = this.drag && lineKey(this.drag.line) === k ? this.drag.price : line.price
      this.fillLabel(label, snapshot, ctx, price, selected)
    }
    for (const [k, label] of this.labels) {
      if (wanted.has(k)) continue
      label.element.remove()
      this.labels.delete(k)
    }

    const symbolName = symbol.ticker ?? key
    this.card.element.classList.toggle('is-compact', this.compact)
    this.card.render({
      symbol: symbolName,
      ctx,
      trades,
      orders,
      collapsed: this.host.isCollapsed(this.compact),
      compact: this.compact,
      expanded: selected,
      armed: this.armed,
      riskPercent: tradePrefs().riskPercent,
      rewardRatio: tradePrefs().rewardRatio,
      draft: this.draft,
      confirm: this.describeAmendment(snapshot, ctx, key)
    })
    this.schedule()
  }

  /** The selection, or -- when only one thing is working -- that one, so a single trade shows its
   * details and its bracket without being clicked. */
  private effectiveSelection(trades: SimTrade[], orders: SimOrder[]): string | null {
    const selected = this.host.selected()
    if (selected && (trades.some((t) => t.id === selected) || orders.some((o) => o.id === selected))) return selected
    if (trades.length + orders.length === 1) return trades[0]?.id ?? orders[0]?.id ?? null
    return null
  }

  private fillLabel(
    label: LineLabel,
    snapshot: SimSnapshot,
    ctx: PricingContext,
    price: number,
    selected: string | null
  ): void {
    const { line } = label
    const el = label.element
    el.dataset.role = line.role
    el.dataset.side = line.side
    el.classList.toggle('is-selected', selected === line.id)
    el.classList.toggle('is-draggable', line.draggable)
    el.classList.toggle('is-dragging', this.drag !== null && lineKey(this.drag.line) === lineKey(line))
    el.style.setProperty('--wd-oc-color', lineColor(line, this.host.colors))
    const refusal = this.drag && lineKey(this.drag.line) === lineKey(line) ? this.refusal(line, price) : null
    el.classList.toggle('is-invalid', refusal !== null)

    const trade = line.owner === 'trade' ? snapshot.trades.find((t) => t.id === line.id) : undefined
    const order = line.owner === 'order' ? snapshot.orders.find((o) => o.id === line.id) : undefined
    const units = trade?.units ?? order?.units ?? 0
    const precision = ctx.info.precision
    let name = ''
    let move = ''
    let amount: number | null = null
    let title = ''
    label.addStop.hidden = true
    label.addTarget.hidden = true
    label.place.hidden = true
    label.remove.classList.remove('is-armed')
    el.classList.toggle('is-draft', line.owner === 'draft')
    const draft = line.owner === 'draft' ? this.draft : null

    if (draft && line.role === 'entry') {
      const buy = draft.side === 'buy'
      const side = this.compact ? (buy ? 'B' : 'S') : buy ? 'buy' : 'sell'
      name = `Draft ${side} ${draft.type === 'market' ? 'mkt' : draft.type === 'limit' ? (this.compact ? 'LMT' : 'limit') : this.compact ? 'STP' : 'stop'}`
      if (draft.units !== null) name += ` ${formatUnitsShort(draft.units)}`
      const fill = fillingPrice(draft.side, ctx.quote)
      if (draft.type !== 'market' && fill !== null) {
        const off = Math.abs(price - fill)
        move = `${ctx.info.pipSize ? `${(off / ctx.info.pipSize).toFixed(1)}p` : `${((off / fill) * 100).toFixed(2)}%`} away`
      }
      label.addStop.hidden = draft.stop !== null
      label.addTarget.hidden = draft.target !== null
      const armed = this.armed === 'place'
      label.place.hidden = false
      label.place.disabled = draft.problem !== null
      label.place.textContent = armed ? 'Confirm' : 'Place'
      label.place.classList.toggle('is-armed', armed)
      label.place.setAttribute('aria-label', armed ? 'Confirm placing this order' : 'Place this order')
      label.remove.textContent = '×'
      label.remove.setAttribute('aria-label', 'Discard the draft')
      title = draft.problem ?? `Draft at ${formatPrice(price, precision)} — drag to set a limit or stop price`
    } else if (draft && (line.role === 'stop' || line.role === 'target')) {
      const o = draft.units !== null ? outcome(draft.side, draft.units, draft.entry, price, ctx) : null
      name = line.role === 'stop' ? 'SL' : 'TP'
      move = o ? moveText(o) : ''
      amount = o?.amount ?? null
      label.remove.textContent = '×'
      label.remove.setAttribute('aria-label', line.role === 'stop' ? 'Remove the draft stop loss' : 'Remove the draft take profit')
      title = `Draft ${line.role === 'stop' ? 'stop loss' : 'take profit'} ${formatPrice(price, precision)} — drag to move`
    } else if (line.role === 'entry' && trade) {
      const f = tradeFigures(trade, ctx)
      name = `${trade.side === 'buy' ? (this.compact ? 'L' : 'Long') : this.compact ? 'S' : 'Short'} ${formatUnitsShort(units)}`
      move = moveText(f.pnl)
      amount = f.pnl?.amount ?? null
      label.addStop.hidden = trade.stopLoss !== null
      label.addTarget.hidden = trade.takeProfit !== null
      const armed = this.armed === `close:${trade.id}`
      label.remove.textContent = armed ? 'Close?' : '×'
      label.remove.classList.toggle('is-armed', armed)
      label.remove.setAttribute('aria-label', armed ? 'Confirm closing this trade' : 'Close this trade')
      title = `Entry ${formatPrice(trade.entryPrice, precision)}. Click to select.`
    } else if (line.role === 'order' && order) {
      const probe = { ...order, price }
      const f = orderFigures(probe, ctx)
      const type = order.type === 'limit' ? (this.compact ? 'LMT' : 'limit') : this.compact ? 'STP' : 'stop'
      name = `${order.side === 'buy' ? (this.compact ? 'B' : 'Buy') : this.compact ? 'S' : 'Sell'} ${type} ${formatUnitsShort(units)}`
      move = f.distance ? `${moveText(f.distance, false)} away` : ''
      label.addStop.hidden = order.stopLoss !== null
      label.addTarget.hidden = order.takeProfit !== null
      label.remove.textContent = '×'
      label.remove.setAttribute('aria-label', 'Cancel this order')
      title = `${formatPrice(price, precision)} — drag to move the order`
    } else if ((line.role === 'stop' || line.role === 'target') && (trade || order)) {
      const side = line.side
      const from = trade ? trade.entryPrice : (order?.price as number)
      const o = outcome(side, units, from, price, ctx)
      name = line.role === 'stop' ? 'SL' : 'TP'
      move = moveText(o)
      amount = o.amount
      label.remove.textContent = '×'
      label.remove.setAttribute('aria-label', line.role === 'stop' ? 'Remove the stop loss' : 'Remove the take profit')
      title = `${formatPrice(price, precision)} — drag to move`
    }
    label.name.textContent = name
    label.move.textContent = move
    label.amount.textContent = amount === null ? '' : formatMoney(amount)
    label.amount.hidden = amount === null
    for (const node of [label.move, label.amount]) {
      node.classList.toggle('is-up', amount !== null && amount > 0)
      node.classList.toggle('is-down', amount !== null && amount < 0)
    }
    label.addStop.setAttribute('aria-label', 'Add a stop loss')
    label.addTarget.setAttribute('aria-label', 'Add a take profit')

    // Waiting for confirmation: this label is the question, and answers it.
    const amendment = this.host.amendment()
    const proposed =
      amendment !== null &&
      line.owner === amendment.owner &&
      line.id === amendment.id &&
      line.role === (amendment.role === 'order' ? 'order' : amendment.role)
    el.classList.toggle('is-proposed', proposed)
    label.confirm.hidden = !proposed
    label.cancel.hidden = !proposed
    if (proposed) {
      label.addStop.hidden = true
      label.addTarget.hidden = true
      label.place.hidden = true
      label.remove.hidden = true
      const sending = this.host.sending()
      label.confirm.disabled = sending
      label.confirm.textContent = sending ? '…' : 'Confirm'
      if (amendment.price === null) {
        label.move.textContent = 'remove?'
        label.amount.hidden = true
      }
      title = 'Confirm to send this change, or × (Escape) to put it back'
    } else {
      label.remove.hidden = false
    }
    el.title = refusal ?? title
  }

  /** The waiting change in words, for the card, when it belongs to this pane's instrument. */
  private describeAmendment(
    snapshot: SimSnapshot,
    ctx: PricingContext,
    key: string
  ): { title: string; detail: string; refusal: string | null; sending: boolean } | null {
    const a = this.host.amendment()
    if (!a) return null
    const trade = a.owner === 'trade' ? snapshot.trades.find((t) => t.id === a.id) : undefined
    const order = a.owner === 'order' ? snapshot.orders.find((o) => o.id === a.id) : undefined
    const position = trade ?? order
    if (!position || position.symbol !== key) return null
    const precision = ctx.info.precision
    const what = a.role === 'stop' ? 'stop loss' : a.role === 'target' ? 'take profit' : `${order?.type ?? 'order'} price`
    const whose = trade ? `${trade.side === 'buy' ? 'long' : 'short'} ${formatUnitsShort(trade.units)}` : `${position.side} ${order?.type ?? ''} ${formatUnitsShort(position.units)}`
    let title: string
    if (a.price === null) title = `Remove the ${what} (${formatPrice(a.from, precision)}) from the ${whose}?`
    else if (a.from === null) title = `Add a ${what} at ${formatPrice(a.price, precision)} to the ${whose}?`
    else title = `Move the ${whose}'s ${what} ${formatPrice(a.from, precision)} → ${formatPrice(a.price, precision)}?`

    let detail = ''
    if (a.price !== null && a.role !== 'order') {
      const from = trade ? trade.entryPrice : (order?.price ?? null)
      if (from !== null) {
        const o = outcome(position.side, position.units, from, a.price, ctx)
        detail = `If hit: ${moveText(o)} · ${formatMoney(o.amount, ctx.currencies.quote)}${o.ofBalance !== null ? ` (${formatPercent(o.ofBalance)} of balance)` : ''}`
      }
    } else if (a.price === null) {
      detail = a.role === 'stop' ? 'The position will have no stop loss.' : 'The position will have no take profit.'
    } else if (order) {
      const fill = fillingPrice(order.side, ctx.quote)
      if (fill !== null) detail = `${moveText({ pips: ctx.info.pipSize ? Math.abs(a.price - fill) / ctx.info.pipSize : null, percent: (Math.abs(a.price - fill) / fill) * 100 }, false)} from the market`
    }
    const line = linesFor(snapshot, key).find((l) => l.owner === a.owner && l.id === a.id && l.role === a.role)
    const refusal = a.price !== null && line ? this.refusal(line, a.price) : null
    return { title, detail, refusal, sending: this.host.sending() }
  }

  flash(text: string, tone: 'up' | 'down' | 'info'): void {
    this.card.flash(text, tone, FLASH_MS)
  }

  private showError(err: unknown): void {
    const text =
      typeof err === 'string' ? err : err instanceof OhlcvApiError ? err.message : err instanceof Error ? err.message : 'Request failed'
    console.warn(`[${this.host.tag}] on-chart action refused`, text)
    this.card.error(text, ERROR_MS)
    // An error on a rolled-up card would be invisible; open it for the message.
    if (this.host.isCollapsed(this.compact)) {
      this.host.setCollapsed(this.compact, false)
      this.render(this.snapshot)
    }
  }

  // -- actions ------------------------------------------------------------------------------------

  /** Two-press confirmation for what cannot be undone, with no modal: the first press relabels
   * the button, a second within `CONFIRM_MS` does it. */
  private confirmed(key: string): boolean {
    if (this.armed === key) {
      this.disarm()
      return true
    }
    this.armed = key
    if (this.armTimer) clearTimeout(this.armTimer)
    this.armTimer = setTimeout(() => this.disarm(), CONFIRM_MS)
    this.render(this.snapshot)
    return false
  }

  private disarm(): void {
    if (this.armTimer) clearTimeout(this.armTimer)
    this.armTimer = null
    if (this.armed === null) return
    this.armed = null
    this.render(this.snapshot)
  }

  private run(promise: Promise<void>): void {
    promise.catch((err) => {
      this.showError(err)
      this.render(this.snapshot)
    })
  }

  private labelAction(label: LineLabel, action: LabelAction): void {
    const { line } = label
    if (line.owner === 'draft') {
      if (action === 'place') this.perform({ kind: 'draftPlace' })
      else if (action === 'stop' || action === 'target') this.perform({ kind: 'draftProtect', role: action })
      else if (line.role === 'entry') this.perform({ kind: 'draftDiscard' })
      else if (line.role === 'stop' || line.role === 'target') this.perform({ kind: 'draftClear', role: line.role })
      return
    }
    if (action === 'confirm') {
      this.perform({ kind: 'amendConfirm' })
      return
    }
    if (action === 'cancel') {
      this.perform({ kind: 'amendCancel' })
      return
    }
    if (action === 'place') return
    if (action === 'stop' || action === 'target') {
      this.perform({ kind: 'protect', owner: line.owner, id: line.id, role: action })
      return
    }
    const snapshot = this.snapshot
    if (!snapshot) return
    if (line.role === 'entry') {
      const trade = snapshot.trades.find((t) => t.id === line.id)
      if (trade) this.perform({ kind: 'close', trade })
    } else if (line.role === 'order') {
      const order = snapshot.orders.find((o) => o.id === line.id)
      if (order) this.perform({ kind: 'cancel', order })
    } else {
      this.perform({ kind: 'unprotect', owner: line.owner, id: line.id, role: line.role })
    }
  }

  private perform(action: CardAction): void {
    const session = this.host.session
    const snapshot = this.snapshot
    switch (action.kind) {
      case 'toggle':
        this.host.setCollapsed(this.compact, !this.host.isCollapsed(this.compact))
        this.render(snapshot)
        return
      case 'select':
        this.host.select(this.host.selected() === action.id ? null : action.id)
        return
      case 'close': {
        const partial = action.units !== undefined && action.units > 0 && action.units < action.trade.units
        if (!partial && !this.confirmed(`close:${action.trade.id}`)) return
        this.run(session.closeTrade(action.trade.id, partial ? action.units : undefined))
        return
      }
      case 'breakeven':
        this.proposeOrSay({ owner: 'trade', id: action.trade.id, role: 'stop', price: action.trade.entryPrice })
        return
      case 'amendConfirm':
        this.host.confirmAmendment().catch((err) => this.showError(err))
        return
      case 'amendCancel':
        this.host.cancelAmendment()
        return
      case 'cancel':
        this.run(session.cancelOrder(action.order.id))
        return
      case 'flatten':
        if (!this.confirmed('flatten')) return
        this.run(session.flatten(this.key))
        return
      case 'unprotect':
        this.proposeOrSay({ owner: action.owner, id: action.id, role: action.role, price: null })
        return
      case 'riskStop':
      case 'rewardTarget': {
        if (!snapshot) return
        const level = this.presetLevel(snapshot, action)
        if (typeof level === 'string') {
          this.showError(level)
          return
        }
        this.proposeOrSay({ owner: action.owner, id: action.id, role: action.kind === 'riskStop' ? 'stop' : 'target', price: level })
        return
      }
      case 'draftProtect': {
        const draft = this.draft
        if (!snapshot || !draft || !this.host.draft) return
        const price = this.startingLevel(snapshot, 'draft', 'draft', action.role)
        if (price !== null) this.host.draft.setLevel(action.role, price)
        return
      }
      case 'draftClear':
        this.host.draft?.clearLevel(action.role)
        return
      case 'draftDiscard':
        this.disarm()
        this.host.draft?.clearLevel('stop')
        this.host.draft?.clearLevel('target')
        this.host.draft?.clearLevel('entry')
        return
      case 'draftPreset': {
        const draft = this.draft
        if (!snapshot || !draft || !this.host.draft) return
        const level = this.draftPreset(snapshot, draft, action.role)
        if (typeof level === 'string') this.showError(level)
        else this.host.draft.setLevel(action.role, level)
        return
      }
      case 'draftPlace': {
        const controller = this.host.draft
        if (!controller || !this.draft) return
        if (!this.confirmed('place')) return
        controller.place().catch((err) => this.showError(err))
        return
      }
      case 'protect': {
        if (!snapshot) return
        const price = this.startingLevel(snapshot, action.owner, action.id, action.role)
        if (price === null) {
          this.showError('No price yet to place it from')
          return
        }
        this.proposeOrSay({ owner: action.owner, id: action.id, role: action.role, price })
        return
      }
    }
  }

  /** A button's change goes up for confirmation -- or, when it would change nothing, says so rather
   * than doing nothing visibly. */
  private proposeOrSay(change: Omit<Amendment, 'from'>): void {
    if (this.host.propose(change)) return
    const what = change.role === 'stop' ? 'stop loss' : change.role === 'target' ? 'take profit' : 'price'
    this.card.flash(change.price === null ? `No ${what} to remove` : `The ${what} is already there`, 'info', FLASH_MS / 2)
  }

  /** The card's preset levels, or why there is none: a stop that loses `riskPercent` of the
   * balance at the position's size, or a target `rewardRatio` times the stop's distance -- each
   * measured from the entry (a pending order's price), and checked against what the engine accepts
   * before it is sent. */
  private presetLevel(
    snapshot: SimSnapshot,
    action: Extract<CardAction, { kind: 'riskStop' | 'rewardTarget' }>
  ): number | string {
    const ctx = this.pricing(snapshot)
    const { riskPercent, rewardRatio } = tradePrefs()
    const trade = action.owner === 'trade' ? snapshot.trades.find((t) => t.id === action.id) : undefined
    const order = action.owner === 'order' ? snapshot.orders.find((o) => o.id === action.id) : undefined
    const position = trade ?? order
    const from = trade ? trade.entryPrice : order?.price
    if (!position || from === null || from === undefined) return 'This is no longer working'
    // The engine checks an open trade's levels against its closing side, an order's against its price.
    const reference = trade ? closingPrice(trade.side, ctx.quote) : from
    const side = position.side
    const precision = ctx.info.precision
    let level: number | null
    if (action.kind === 'riskStop') {
      level = levelForBalancePercent(side, 'stop', position.units, from, riskPercent, ctx)
      if (level === null) return `No ${ctx.account.currency} rate for ${ctx.currencies.quote}, so a stop cannot be priced from the balance`
      if (reference !== null && !protectionValid(side, 'stop', level, reference)) {
        return `Already more than ${riskPercent}% down: a stop there (${formatPrice(level, precision)}) is past the market`
      }
    } else {
      if (position.stopLoss === null) return 'Set a stop loss first'
      level = targetForReward(side, from, position.stopLoss, rewardRatio, precision)
      if (level === null) return 'The stop is past the entry, so there is no risk to multiply'
      if (reference !== null && !protectionValid(side, 'target', level, reference)) {
        return `The market is already past ${rewardRatio}R (${formatPrice(level, precision)})`
      }
    }
    return level
  }

  /** The card's presets applied to the draft: the stop at `riskPercent` of the balance for its
   * size, or the target at `rewardRatio` times its stop. */
  private draftPreset(snapshot: SimSnapshot, draft: DraftOrder, role: 'stop' | 'target'): number | string {
    const ctx = this.pricing(snapshot)
    const { riskPercent, rewardRatio } = tradePrefs()
    if (role === 'stop') {
      if (draft.riskPercent !== null) return 'The size already comes from the risk: move the stop instead'
      if (draft.units === null) return 'The draft has no size yet'
      return (
        levelForBalancePercent(draft.side, 'stop', draft.units, draft.entry, riskPercent, ctx) ??
        `No ${ctx.account.currency} rate for ${ctx.currencies.quote}, so a stop cannot be priced from the balance`
      )
    }
    if (draft.stop === null) return 'Set a stop loss first'
    return (
      targetForReward(draft.side, draft.entry, draft.stop, rewardRatio, ctx.info.precision) ??
      'The stop is past the entry, so there is no risk to multiply'
    )
  }

  /** Where a new stop or target is put: a slice of the pane's visible price range beyond the
   * entry and the market, so it lands on screen, valid, and ready to be dragged into place. */
  private startingLevel(
    snapshot: SimSnapshot,
    owner: 'trade' | 'order' | 'draft',
    id: string,
    role: 'stop' | 'target'
  ): number | null {
    const ctx = this.pricing(snapshot)
    const height = this.main?.clientHeight ?? 0
    const top = this.yToPrice(0)
    const bottom = this.yToPrice(height)
    const quote = ctx.quote
    const spread = quote ? quote.ask - quote.bid : 0
    const visible = top !== null && bottom !== null ? Math.abs(top - bottom) : 0
    const distance = Math.max(visible * DEFAULT_DISTANCE_FRACTION, spread * 3, 10 ** -ctx.info.precision)
    const range = top !== null && bottom !== null ? { low: Math.min(top, bottom), high: Math.max(top, bottom) } : undefined
    if (owner === 'draft') {
      const draft = this.draft
      if (!draft) return null
      return defaultProtection(draft.side, role, draft.entry, draft.entry, distance, ctx.info.precision, range)
    }
    if (owner === 'trade') {
      const trade = snapshot.trades.find((t) => t.id === id)
      const mark = trade ? closingPrice(trade.side, quote) : null
      if (!trade || mark === null) return null
      return defaultProtection(trade.side, role, trade.entryPrice, mark, distance, ctx.info.precision, range)
    }
    const order = snapshot.orders.find((o) => o.id === id)
    if (!order || order.price === null) return null
    return defaultProtection(order.side, role, order.price, order.price, distance, ctx.info.precision, range)
  }

  /** Why the engine would refuse `line` at `price`, in words -- or null when it would accept. */
  private refusal(line: LineSpec, price: number): string | null {
    const snapshot = this.snapshot
    if (!snapshot) return null
    const quote = snapshot.quotes[this.key]
    const precision = this.host.instrumentFor(this.key).precision
    const sideName = line.side === 'buy' ? 'long' : 'short'
    if (line.owner === 'draft') {
      // Nothing is sent from a drag, so nothing is refused; a level on the wrong side is flagged,
      // and the ticket says the same thing where Place would be.
      const draft = this.draft
      if (!draft || (line.role !== 'stop' && line.role !== 'target')) return null
      if (protectionValid(draft.side, line.role, price, draft.entry)) return null
      const below = line.role === 'stop' ? draft.side === 'buy' : draft.side === 'sell'
      return `The draft's ${line.role === 'stop' ? 'stop' : 'target'} must be ${below ? 'below' : 'above'} its entry`
    }
    if (line.owner === 'trade') {
      const trade = snapshot.trades.find((t) => t.id === line.id)
      if (!trade || trade.closedAt !== null) return 'This trade has closed'
      if (line.role !== 'stop' && line.role !== 'target') return null
      const mark = closingPrice(trade.side, quote)
      if (mark === null || protectionValid(trade.side, line.role, price, mark)) return null
      const below = line.role === 'stop' ? trade.side === 'buy' : trade.side === 'sell'
      return `A ${sideName}'s ${line.role === 'stop' ? 'stop' : 'target'} must be ${below ? 'below' : 'above'} the ${
        trade.side === 'buy' ? 'bid' : 'ask'
      } (${formatPrice(mark, precision)})`
    }
    const order = snapshot.orders.find((o) => o.id === line.id)
    if (!order || order.status !== 'pending' || order.price === null) return 'This order is no longer working'
    if (line.role === 'order') {
      if (!restingPriceValid(order.side, order.type, price, quote)) {
        const fill = fillingPrice(order.side, quote)
        if (fill === null) return null
        const below = (order.type === 'limit') === (order.side === 'buy')
        return `A ${order.side} ${order.type} must be ${below ? 'below' : 'above'} the ${order.side === 'buy' ? 'ask' : 'bid'} (${formatPrice(fill, precision)})`
      }
      if (order.stopLoss !== null && !protectionValid(order.side, 'stop', order.stopLoss, price)) {
        return 'The order would pass its own stop loss'
      }
      if (order.takeProfit !== null && !protectionValid(order.side, 'target', order.takeProfit, price)) {
        return 'The order would pass its own take profit'
      }
      return null
    }
    if ((line.role === 'stop' || line.role === 'target') && !protectionValid(order.side, line.role, price, order.price)) {
      const below = line.role === 'stop' ? order.side === 'buy' : order.side === 'sell'
      return `A ${order.side} order's ${line.role} must be ${below ? 'below' : 'above'} its price (${formatPrice(order.price, precision)})`
    }
    return null
  }

  // -- dragging -----------------------------------------------------------------------------------

  private bindDrag(label: LineLabel): void {
    const el = label.element
    el.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      if ((event.target as Element).closest('button')) return
      if (this.drag || this.host.sending()) return
      // Suppresses the compatibility mousedown klinecharts would otherwise start a pan from.
      event.preventDefault()
      const line = label.line
      if (!line.draggable) {
        if (line.owner !== 'draft') this.perform({ kind: 'select', id: line.id })
        return
      }
      el.setPointerCapture(event.pointerId)
      this.drag = {
        line,
        price: line.price,
        source: 'label',
        pointerId: event.pointerId,
        startY: event.clientY,
        moved: false
      }
    })
    el.addEventListener('pointermove', (event) => {
      const drag = this.drag
      if (!drag || drag.source !== 'label' || drag.pointerId !== event.pointerId) return
      if (!drag.moved) {
        if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return
        drag.moved = true
        this.host.hold()
        this.root.classList.add('is-dragging')
        if (drag.line.owner !== 'draft') this.host.select(drag.line.id)
      }
      const rect = this.main?.getBoundingClientRect()
      if (!rect) return
      const price = this.yToPrice(event.clientY - rect.top)
      if (price === null) return
      this.dragTo(price, true)
    })
    const end = (event: PointerEvent): void => {
      const drag = this.drag
      if (!drag || drag.source !== 'label' || drag.pointerId !== event.pointerId) return
      if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId)
      if (event.type === 'pointercancel') {
        if (drag.moved) this.cancelDrag()
        else this.drag = null
        return
      }
      if (!drag.moved) {
        this.drag = null
        if (drag.line.owner !== 'draft') this.perform({ kind: 'select', id: drag.line.id })
        return
      }
      this.finishDrag()
    }
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
  }

  private dragTo(raw: number, moveCanvas: boolean): void {
    const drag = this.drag
    if (!drag) return
    const precision = this.host.instrumentFor(this.key).precision
    const price = roundTo(raw, precision)
    drag.price = price
    if (moveCanvas) this.host.previewLine(drag.line, price)
    if (drag.line.owner === 'draft') this.dragDraft(drag.line, price)
    const label = this.labels.get(lineKey(drag.line))
    if (label && this.snapshot) {
      this.fillLabel(label, this.snapshot, this.pricing(this.snapshot), price, drag.line.id)
    }
    this.schedule()
  }

  /** A draft line moved: write it into the ticket now, and bring along whatever the ticket moved
   * with it -- a stop and target stated in pips follow their entry. The canvas is held for the
   * gesture, so those sibling lines are moved by preview. */
  private dragDraft(line: LineSpec, price: number): void {
    const controller = this.host.draft
    if (!controller || (line.role !== 'entry' && line.role !== 'stop' && line.role !== 'target')) return
    controller.setLevel(line.role, price)
    const next = controller.draft()
    if (!next) return
    for (const sibling of this.lines) {
      if (sibling.owner !== 'draft' || sibling.role === line.role) continue
      const moved = sibling.role === 'entry' ? next.entry : sibling.role === 'stop' ? next.stop : next.target
      if (moved !== null && moved !== sibling.price) this.host.previewLine(sibling, moved)
    }
  }

  /** klinecharts started dragging an unlocked trade line. */
  beginCanvasDrag(line: LineSpec): void {
    if (this.drag) return
    this.drag = { line, price: line.price, source: 'canvas', pointerId: null, startY: 0, moved: true }
    this.host.hold()
    this.root.classList.add('is-dragging')
    if (line.owner !== 'draft') this.host.select(line.id)
  }

  canvasDragTo(price: number): void {
    if (this.drag?.source !== 'canvas') return
    this.dragTo(price, false)
  }

  endCanvasDrag(price: number | null): void {
    const drag = this.drag
    if (drag?.source !== 'canvas') return
    if (price !== null) drag.price = roundTo(price, this.host.instrumentFor(this.key).precision)
    this.finishDrag()
  }

  private cancelDrag(): void {
    const drag = this.drag
    if (!drag) return
    this.drag = null
    // A draft drag has been writing into the ticket as it went: put the level back where it began.
    const { line } = drag
    if (line.owner === 'draft' && drag.moved && (line.role === 'entry' || line.role === 'stop' || line.role === 'target')) {
      this.host.draft?.setLevel(line.role, line.price)
    }
    this.root.classList.remove('is-dragging')
    if (drag.moved) this.host.release(true)
    this.render(this.snapshot)
  }

  private finishDrag(): void {
    const drag = this.drag
    if (!drag) return
    if (drag.line.owner === 'draft') {
      // Already in the ticket, move by move; there is nothing to send and nothing to refuse.
      this.drag = null
      this.root.classList.remove('is-dragging')
      this.host.release(false)
      this.render(this.snapshot)
      return
    }
    const refusal = this.refusal(drag.line, drag.price)
    if (refusal !== null || drag.price === drag.line.price) {
      this.cancelDrag()
      if (refusal !== null) this.showError(refusal)
      return
    }
    // Proposed, not sent: the line stays where it was dropped until the change is confirmed.
    const { line, price } = drag
    this.drag = null
    this.root.classList.remove('is-dragging')
    this.host.release(false)
    if (line.owner !== 'draft' && (line.role === 'stop' || line.role === 'target' || line.role === 'order')) {
      this.host.propose({ owner: line.owner, id: line.id, role: line.role, price })
    }
    this.render(this.snapshot)
  }

  dispose(): void {
    this.disposed = true
    if (this.raf !== 0) cancelAnimationFrame(this.raf)
    if (this.armTimer) clearTimeout(this.armTimer)
    if (this.drag?.moved) this.host.release(false)
    this.drag = null
    this.resize.disconnect()
    window.removeEventListener('keydown', this.onKey)
    try {
      this.chart.getDom()?.removeEventListener('pointermove', this.onChartPointerMove)
      this.chart.getDom()?.removeEventListener('pointerup', this.onChartPointerMove)
    } catch {
      // chart disposed
    }
    this.card.dispose()
    this.root.remove()
  }
}
