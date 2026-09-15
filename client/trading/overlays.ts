import type { Chart, OverlayCreate, OverlayEvent } from 'klinecharts'
import type { ChartProPane } from '../../src'
import type { SimSide, SimSnapshot } from './api'
import { formatPips, formatPrice, formatUnitsShort, symbolKey } from './format'
import type { InstrumentInfo } from './instrument'
import {
  type Amendment,
  applyAmendment,
  currentLevel,
  DEFAULT_COLORS,
  DRAFT_ID,
  type DraftController,
  type DraftOrder,
  draftFor,
  isComposing,
  type LineOwner,
  type LineSpec,
  lineColor,
  lineKey,
  linesFor,
  type OverlayColors,
  registerTradeOverlays,
  TRADE_BRACKET,
  TRADE_LINE,
  type TradeBracketData,
  type TradeLineData,
  withAlpha,
  workingFor
} from './lines'
import { OnChartLayer } from './onchart'
import { setTradePrefs, subscribeTradePrefs, tradePrefs } from './prefs'
import type { TradingSession } from './session'

// Everything a trading session puts on the candle panes, one instance per mounted wall:
//
// - canvas lines (lines.ts `wdTradeLine`): a pending order's price, an open trade's entry, and
//   every stop and target -- each with its price tagged on the axis;
// - the bracket (lines.ts `wdTradeBracket`) connecting an entry to its stop and target;
// - the HTML layer (onchart.ts): a label on each line, and the collapsible order card.
//
// Per pane, that pane's instrument only. Lines are anchored to the pane's OLDEST loaded bar
// (the template spans the width whatever x the point is at), so a live tick -- which raises
// `onVisibleRangeChange` on every update -- does not move any point, and the rebuild is skipped
// by signature. Only a history page-in, a symbol change or a snapshot that changed what is drawn
// rebuilds the set.
//
// DRAGGING. A stop, a target and a pending order's price move up and down on the pane, either by
// the line itself (klinecharts' own drag of an unlocked overlay) or by its label (the layer's
// pointer drag, which moves the line through `overrideOverlay`). For the gesture the pane's canvas
// is not rebuilt: a 2-second poll landing mid-drag would otherwise remove the overlay under the
// pointer. Entry lines stay locked: dragging one would imply the fill can move.
//
// CONFIRMATION. Nothing a drag or an on-chart button does to a working stop, target or pending
// price is sent until the user confirms it (user, 2026-09-15). The drop -- or the button -- makes
// an `Amendment`, held HERE so every pane shows the same one; every pane draws the snapshot as if
// it were confirmed (`applyAmendment`), and the layer turns that line's label into Confirm / x
// and puts the same question at the top of the card. Confirm sends it; x or Escape drops it and
// the pane redraws from the snapshot. The amendment is kept until the answer arrives, so a
// confirmed line does not flick back to its old price in between.
//
// THE DRAFT. While the account window is open, the order being written in the ticket is drawn
// too (`ctx.draft`): its entry, stop and target, a bracket, outlined labels and a row on
// the card. Its lines drag like the rest, but a drag lands in the ticket's fields as it moves --
// nothing is sent until it is placed, from the ticket or from the chart.

export { DEFAULT_COLORS, linesFor, type LineSpec, type OverlayColors } from './lines'

const GROUP = 'wd-paper'
const CANDLE_PANE = 'candle_pane'

/** The oldest and newest loaded bar, which every point on the pane is clamped between. */
export interface DataSpan {
  first: number
  last: number
}

function lineOverlay(line: LineSpec, span: DataSpan, colors: OverlayColors, dim = false): OverlayCreate<TradeLineData> {
  // While a draft is being composed, what is already working recedes, so the draft's lines are the
  // ones that read -- still there, still draggable, just quieter.
  const color = dim ? withAlpha(lineColor(line, colors), 0.4) : lineColor(line, colors)
  return {
    name: TRADE_LINE,
    paneId: CANDLE_PANE,
    lock: !line.draggable,
    // Never snap a dragged stop to a candle's OHLC, whatever the drawing bar's magnet is set to.
    mode: 'normal',
    extendData: { wd: { role: line.role, owner: line.owner, id: line.id } },
    styles: {
      line: {
        color,
        // Entries and a pending order's price are solid; a stop and a target are LONG dashes, so
        // the levels a position exits at read apart from where it entered (user, 2026-09-15: solid
        // lines, then wider dashes for SL/TP -- the short dashes they replaced read as dotted).
        // Colour does the rest: red stop, green target, the side's colour for an entry; a pending
        // order is the heavier line, and a draft is told apart by its outlined "Draft" label.
        size: line.role === 'order' ? 1.5 : 1,
        style: line.role === 'stop' || line.role === 'target' ? 'dashed' : 'solid',
        dashedValue: [10, 6]
      },
      text: {
        color: '#ffffff',
        backgroundColor: color,
        size: 11,
        paddingLeft: 4,
        paddingRight: 4,
        paddingTop: 2,
        paddingBottom: 2,
        borderRadius: 2
      }
    },
    points: [{ timestamp: span.first, value: line.price }]
  }
}

function clampTime(t: number, span: DataSpan): number {
  return Math.min(Math.max(t, span.first), span.last)
}

export function bracketDatum(
  owner: LineOwner,
  id: string,
  side: SimSide,
  entry: number,
  stop: number | null,
  target: number | null,
  selected: boolean,
  colors: OverlayColors
): TradeBracketData {
  return {
    wd: {
      owner,
      id,
      entry,
      stop,
      target,
      selected,
      lossColor: colors.stop,
      profitColor: colors.target,
      entryColor: side === 'buy' ? colors.buy : colors.sell,
      pending: owner !== 'trade'
    }
  }
}

function bracketOverlay(
  time: number,
  datum: TradeBracketData,
  span: DataSpan
): OverlayCreate<TradeBracketData> {
  return {
    name: TRADE_BRACKET,
    paneId: CANDLE_PANE,
    lock: true,
    zLevel: -1,
    extendData: datum,
    points: [{ timestamp: clampTime(time, span), value: datum.wd.entry }]
  }
}

/** Every overlay for one snapshot on one pane's instrument: brackets first (so lines draw over
 * them), then lines. Pure. */
export function overlaysFor(
  snapshot: SimSnapshot,
  key: string,
  span: DataSpan,
  colors: OverlayColors,
  selected: string | null = null,
  draft: DraftOrder | null = null
): OverlayCreate[] {
  const { trades, orders } = workingFor(snapshot, key)
  const out: OverlayCreate[] = []
  const d = draftFor(draft, key)
  const drafting = isComposing(d)
  if (drafting && (d.stop !== null || d.target !== null)) {
    // Always drawn strongly -- it is what is being worked on -- and from the current bar.
    const datum = bracketDatum('draft', DRAFT_ID, d.side, d.entry, d.stop, d.target, true, colors)
    out.push(bracketOverlay(span.last, datum, span) as OverlayCreate)
  }
  for (const order of orders) {
    if (order.stopLoss === null && order.takeProfit === null) continue
    const datum = bracketDatum('order', order.id, order.side, order.price as number, order.stopLoss, order.takeProfit, !drafting && order.id === selected, colors)
    out.push(bracketOverlay(order.createdAt, datum, span) as OverlayCreate)
  }
  for (const trade of trades) {
    const datum = bracketDatum('trade', trade.id, trade.side, trade.entryPrice, trade.stopLoss, trade.takeProfit, !drafting && trade.id === selected, colors)
    out.push(bracketOverlay(trade.openedAt, datum, span) as OverlayCreate)
  }
  for (const line of linesFor(snapshot, key, d)) {
    out.push(lineOverlay(line, span, colors, drafting && line.owner !== 'draft') as OverlayCreate)
  }
  return out
}

export interface TradingOverlayContext {
  session: TradingSession
  instrumentFor: (key: string) => InstrumentInfo
  /** Console-prefix tag ('paper', 'replay'). */
  tag: string
  colors?: OverlayColors
  /** The ticket's order, drawn as a draft while the account window is open. */
  draft?: DraftController
}

interface PaneEntry {
  pane: ChartProPane
  chart: Chart
  layer: OnChartLayer
  signature: string
  span: DataSpan | null
  /** lineKey -> overlay id, and trade/order id -> bracket overlay id, for previews. */
  lineIds: Map<string, string>
  bracketIds: Map<string, string>
  /** A drag (or its amendment) is in flight: hold canvas rebuilds. */
  holds: number
  stale: boolean
  onRange: () => void
}

/** Manages the trading overlays and on-chart widgets across a wall's panes. */
export class TradingOverlays {
  private panes = new Map<string, PaneEntry>()
  private snapshot: SimSnapshot | null = null
  private selected: string | null = null
  private amendment: Amendment | null = null
  private sending = false
  private readonly amendmentListeners = new Set<() => void>()
  private colors: OverlayColors

  private readonly unsubscribePrefs: () => void

  constructor(private ctx: TradingOverlayContext) {
    this.colors = ctx.colors ?? DEFAULT_COLORS
    registerTradeOverlays()
    // The card's rolled-up state and its preset numbers are shared: a change from any pane, the
    // ticket or another tab redraws every card.
    this.unsubscribePrefs = subscribeTradePrefs(() => {
      for (const entry of this.panes.values()) entry.layer.render(this.view())
    })
  }

  /** Called from the wall's onPanesChange, exactly like a ChartLayer's sync. */
  sync(panes: ChartProPane[]): void {
    const live = new Set(panes.map((p) => p.id))
    for (const [id, entry] of this.panes) {
      if (live.has(id)) continue
      this.detach(entry)
      this.panes.delete(id)
    }
    for (const pane of panes) {
      if (this.panes.has(pane.id)) continue
      const chart = pane.getChart()
      if (!chart) continue
      const entry: PaneEntry = {
        pane,
        chart,
        layer: null as unknown as OnChartLayer,
        signature: '',
        span: null,
        lineIds: new Map(),
        bracketIds: new Map(),
        holds: 0,
        stale: false,
        onRange: () => {
          this.redraw(entry)
          entry.layer.schedule()
        }
      }
      entry.layer = new OnChartLayer(pane, chart, {
        tag: this.ctx.tag,
        session: this.ctx.session,
        colors: this.colors,
        instrumentFor: this.ctx.instrumentFor,
        selected: () => this.selected,
        select: (id) => this.select(id),
        previewLine: (line, price) => this.preview(entry, line, price),
        hold: () => this.hold(entry),
        release: (restore) => this.release(entry, restore),
        amendment: () => this.amendment,
        sending: () => this.sending,
        propose: (amendment) => this.propose(amendment),
        confirmAmendment: () => this.confirmAmendment(),
        cancelAmendment: () => this.cancelAmendment(),
        realSnapshot: () => this.snapshot,
        draft: this.ctx.draft,
        // One state for every pane (and every tab): rolled up on one, rolled up on all. Until the
        // user chooses, a phone-sized pane starts rolled up and a larger one open.
        isCollapsed: (compact) => tradePrefs().cardCollapsed ?? compact,
        setCollapsed: (_compact, collapsed) => setTradePrefs({ cardCollapsed: collapsed })
      })
      this.panes.set(pane.id, entry)
      chart.subscribeAction('onVisibleRangeChange', entry.onRange)
      this.redraw(entry)
      entry.layer.render(this.view())
    }
  }

  update(snapshot: SimSnapshot | null): void {
    const previous = this.snapshot
    this.snapshot = snapshot
    if (snapshot && previous && previous.id === snapshot.id) this.announce(previous, snapshot)
    if (this.selected && snapshot && !isWorking(snapshot, this.selected)) this.selected = null
    // An amendment to something that has since filled, closed or been cancelled has nothing left to
    // amend.
    const a = this.amendment
    if (a && snapshot && !this.sending && currentLevel(snapshot, a.owner, a.id, a.role) === undefined) {
      this.amendment = null
      this.amendmentChanged()
    }
    this.refreshAll()
  }

  /** The draft changed, appeared or went: redraw every pane. */
  draftChanged(): void {
    this.refreshAll()
  }

  select(id: string | null): void {
    if (this.selected === id) return
    this.selected = id
    this.refreshAll()
  }

  // -- confirmation -------------------------------------------------------------------------

  /** The snapshot as every pane draws it: with the amendment waiting for confirmation applied. */
  private view(): SimSnapshot | null {
    return this.snapshot ? applyAmendment(this.snapshot, this.amendment) : null
  }

  private refreshAll(force = false): void {
    const view = this.view()
    for (const entry of this.panes.values()) {
      this.redraw(entry, force)
      entry.layer.render(view)
    }
  }

  /** The waiting change, for the account window's tables, which ask the same question. */
  currentAmendment(): Amendment | null {
    return this.amendment
  }

  isSending(): boolean {
    return this.sending
  }

  /** Told whenever a change is proposed, replaced, sent or dropped. */
  onAmendmentChange(listener: () => void): () => void {
    this.amendmentListeners.add(listener)
    return () => {
      this.amendmentListeners.delete(listener)
    }
  }

  private amendmentChanged(): void {
    for (const listener of [...this.amendmentListeners]) listener()
  }

  /** Put a change up for confirmation, replacing any other still waiting. False when there is
   * nothing to ask about: the position is gone, or the level is already there. */
  propose(change: Omit<Amendment, 'from'>): boolean {
    if (!this.snapshot || this.sending) return false
    const from = currentLevel(this.snapshot, change.owner, change.id, change.role)
    if (from === undefined || from === change.price) return false
    this.amendment = { ...change, from }
    this.selected = change.id
    this.refreshAll(true)
    this.amendmentChanged()
    return true
  }

  cancelAmendment(): void {
    if (!this.amendment || this.sending) return
    this.amendment = null
    this.refreshAll(true)
    this.amendmentChanged()
  }

  /** Send the waiting change. Throws what the server said, after putting the chart back. */
  async confirmAmendment(): Promise<void> {
    const a = this.amendment
    if (!a || this.sending) return
    this.sending = true
    this.refreshAll()
    this.amendmentChanged()
    try {
      const session = this.ctx.session
      if (a.owner === 'trade') {
        await session.modifyTrade(a.id, a.role === 'stop' ? { stopLoss: a.price } : { takeProfit: a.price })
      } else if (a.role === 'order') {
        if (a.price !== null) await session.modifyOrder(a.id, { price: a.price })
      } else {
        await session.modifyOrder(a.id, a.role === 'stop' ? { stopLoss: a.price } : { takeProfit: a.price })
      }
    } finally {
      this.sending = false
      if (this.amendment === a) this.amendment = null
      this.refreshAll(true)
      this.amendmentChanged()
    }
  }

  teardown(): void {
    this.unsubscribePrefs()
    for (const entry of this.panes.values()) this.detach(entry)
    this.panes.clear()
  }

  // -- what changed between two snapshots ---------------------------------------------------

  /** A fill, a stop or target hit, a manual close: said once on the card of every pane showing
   * that instrument, and a newly working trade or order is selected, so the lines just created
   * are the ones that stand out. */
  private announce(previous: SimSnapshot, next: SimSnapshot): void {
    const wasOpen = new Map(previous.trades.filter((t) => t.closedAt === null).map((t) => [t.id, t]))
    const wasPending = new Map(previous.orders.filter((o) => o.status === 'pending').map((o) => [o.id, o]))
    const messages: Array<{ key: string; text: string; tone: 'up' | 'down' | 'info' }> = []
    let newest: { id: string; at: number } | null = null
    for (const trade of next.trades) {
      if (trade.closedAt !== null && wasOpen.has(trade.id)) {
        const info = this.ctx.instrumentFor(trade.symbol)
        const move =
          trade.closePrice === null
            ? null
            : trade.side === 'buy'
              ? trade.closePrice - trade.entryPrice
              : trade.entryPrice - trade.closePrice
        const pips = move !== null && info.pipSize ? `${formatPips(move / info.pipSize)}p ` : ''
        const pnl = trade.realizedPnl ?? 0
        const reason =
          trade.closeReason === 'stop_loss'
            ? 'Stop hit'
            : trade.closeReason === 'take_profit'
              ? 'Target hit'
              : 'Closed'
        messages.push({
          key: trade.symbol,
          text: `${reason} ${pips}${pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(2)}`,
          tone: pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'info'
        })
      }
      if (trade.closedAt === null && !wasOpen.has(trade.id) && (!newest || trade.openedAt >= newest.at)) {
        newest = { id: trade.id, at: trade.openedAt }
      }
    }
    for (const order of next.orders) {
      const before = wasPending.get(order.id)
      if (before && order.status === 'filled') {
        const info = this.ctx.instrumentFor(order.symbol)
        messages.push({
          key: order.symbol,
          text: `Filled ${order.side === 'buy' ? 'buy' : 'sell'} ${formatUnitsShort(order.units)} @ ${formatPrice(order.fillPrice, info.precision)}`,
          tone: 'info'
        })
      }
      if (order.status === 'pending' && !before && (!newest || order.createdAt >= newest.at)) {
        newest = { id: order.id, at: order.createdAt }
      }
    }
    if (newest) this.selected = newest.id
    for (const message of messages) {
      for (const entry of this.panes.values()) {
        if (symbolKey(entry.pane.getSymbol()) === message.key) entry.layer.flash(message.text, message.tone)
      }
    }
  }

  // -- canvas ---------------------------------------------------------------------------------

  private detach(entry: PaneEntry): void {
    try {
      entry.chart.unsubscribeAction('onVisibleRangeChange', entry.onRange)
    } catch {
      // chart disposed
    }
    this.clear(entry)
    entry.layer.dispose()
  }

  private clear(entry: PaneEntry): void {
    entry.lineIds.clear()
    entry.bracketIds.clear()
    try {
      entry.chart.removeOverlay({ groupId: GROUP })
    } catch {
      // chart disposed
    }
  }

  private redraw(entry: PaneEntry, force = false): void {
    if (entry.holds > 0) {
      entry.stale = true
      return
    }
    const { pane, chart } = entry
    const data = chart.getDataList()
    const span = data.length === 0 ? null : { first: data[0].timestamp, last: data[data.length - 1].timestamp }
    entry.span = span
    const view = this.view()
    const specs = view && span && this.ctx.session.ready
      ? overlaysFor(view, symbolKey(pane.getSymbol()), span, this.colors, this.selected, this.ctx.draft?.draft() ?? null)
      : []
    const signature = JSON.stringify(specs)
    if (!force && signature === entry.signature) return
    entry.signature = signature
    this.clear(entry)
    for (const spec of specs) this.create(entry, spec)
  }

  private create(entry: PaneEntry, spec: OverlayCreate): void {
    const created: OverlayCreate = { ...spec, groupId: GROUP }
    const line = (spec.extendData as TradeLineData | undefined)?.wd
    if (spec.name === TRADE_LINE && line) {
      const find = (): LineSpec | null => {
        const view = this.view()
        return view
          ? (linesFor(view, symbolKey(entry.pane.getSymbol()), this.ctx.draft?.draft() ?? null).find(
              (l) => l.role === line.role && l.id === line.id
            ) ?? null)
          : null
      }
      const priceOf = (event: OverlayEvent<unknown>): number | null => {
        const value = event.overlay.points?.[0]?.value
        return typeof value === 'number' ? value : null
      }
      if (line.owner !== 'draft') {
        created.onClick = () => {
          this.select(line.id)
        }
      }
      // klinecharts REMOVES an overlay on right-click unless the default is prevented.
      created.onRightClick = (event) => {
        ;(event as { preventDefault?: () => void }).preventDefault?.()
      }
      if (!spec.lock) {
        created.onPressedMoveStart = () => {
          const spec = find()
          if (spec) entry.layer.beginCanvasDrag(spec)
        }
        created.onPressedMoving = (event) => {
          const price = priceOf(event)
          if (price !== null) entry.layer.canvasDragTo(price)
        }
        created.onPressedMoveEnd = (event) => {
          const price = priceOf(event)
          entry.layer.endCanvasDrag(price)
        }
      }
    }
    try {
      const id = entry.chart.createOverlay(created)
      if (typeof id !== 'string') return
      if (spec.name === TRADE_LINE && line) entry.lineIds.set(lineKey(line), id)
      const bracket = (spec.extendData as TradeBracketData | undefined)?.wd
      if (spec.name === TRADE_BRACKET && bracket) entry.bracketIds.set(bracket.id, id)
    } catch (err) {
      console.warn(`[${this.ctx.tag}] overlay create failed`, err)
    }
  }

  /** Move a line (and its bracket edge) to `price` without committing anything. */
  private preview(entry: PaneEntry, line: LineSpec, price: number): void {
    if (!entry.span || !this.snapshot) return
    const lineId = entry.lineIds.get(lineKey(line))
    try {
      if (lineId) entry.chart.overrideOverlay({ id: lineId, points: [{ timestamp: entry.span.first, value: price }] })
      const bracketId = entry.bracketIds.get(line.id)
      const bracket = bracketId ? entry.chart.getOverlays({ id: bracketId })[0] : undefined
      const datum = (bracket?.extendData as TradeBracketData | undefined)?.wd
      if (bracketId && bracket && datum) {
        const next = { ...datum }
        if (line.role === 'stop') next.stop = price
        else if (line.role === 'target') next.target = price
        else if (line.role === 'order' || line.role === 'entry') next.entry = price
        entry.chart.overrideOverlay({
          id: bracketId,
          extendData: { wd: next },
          points:
            line.role === 'order' || line.role === 'entry'
              ? [{ timestamp: bracket.points[0]?.timestamp, value: price }]
              : bracket.points
        })
      }
    } catch {
      // chart disposed mid-drag
    }
  }

  private hold(entry: PaneEntry): void {
    entry.holds += 1
  }

  private release(entry: PaneEntry, restore: boolean): void {
    entry.holds = Math.max(0, entry.holds - 1)
    if (entry.holds > 0) return
    if (restore || entry.stale) {
      entry.stale = false
      this.redraw(entry, restore)
    }
  }
}

function isWorking(snapshot: SimSnapshot, id: string): boolean {
  return (
    snapshot.trades.some((t) => t.id === id && t.closedAt === null) ||
    snapshot.orders.some((o) => o.id === id && o.status === 'pending')
  )
}
