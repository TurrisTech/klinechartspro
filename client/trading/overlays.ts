import type { Chart, OverlayCreate, OverlayEvent } from 'klinecharts'
import type { ChartProPane } from '../../src'
import type { SimSide, SimSnapshot } from './api'
import { formatPips, formatPrice, formatUnitsShort, symbolKey } from './format'
import type { InstrumentInfo } from './instrument'
import {
  DEFAULT_COLORS,
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
  workingFor
} from './lines'
import { OnChartLayer } from './onchart'
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
// pointer drag, which moves the line through `overrideOverlay`). Both routes end in `commit`,
// which sends one amendment. For the whole gesture -- and until that amendment has settled --
// the pane's canvas is not rebuilt: a 2-second poll landing mid-drag would otherwise remove the
// overlay under the pointer, and one landing before the answer would snap the line back to the
// old price for a frame. A refused amendment restores the canvas from the snapshot. Entry lines
// stay locked: dragging one would imply the fill can move.

export { DEFAULT_COLORS, linesFor, type LineSpec, type OverlayColors } from './lines'

const GROUP = 'wd-paper'
const CANDLE_PANE = 'candle_pane'

/** The oldest and newest loaded bar, which every point on the pane is clamped between. */
export interface DataSpan {
  first: number
  last: number
}

function lineOverlay(line: LineSpec, span: DataSpan, colors: OverlayColors): OverlayCreate<TradeLineData> {
  const color = lineColor(line, colors)
  const solid = line.role === 'entry'
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
        size: line.role === 'order' ? 1.5 : 1,
        style: solid ? 'solid' : 'dashed',
        dashedValue: line.role === 'order' ? [6, 3] : [4, 3]
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
  owner: 'trade' | 'order',
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
      pending: owner === 'order'
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
  selected: string | null = null
): OverlayCreate[] {
  const { trades, orders } = workingFor(snapshot, key)
  const out: OverlayCreate[] = []
  for (const order of orders) {
    if (order.stopLoss === null && order.takeProfit === null) continue
    const datum = bracketDatum('order', order.id, order.side, order.price as number, order.stopLoss, order.takeProfit, order.id === selected, colors)
    out.push(bracketOverlay(order.createdAt, datum, span) as OverlayCreate)
  }
  for (const trade of trades) {
    const datum = bracketDatum('trade', trade.id, trade.side, trade.entryPrice, trade.stopLoss, trade.takeProfit, trade.id === selected, colors)
    out.push(bracketOverlay(trade.openedAt, datum, span) as OverlayCreate)
  }
  for (const line of linesFor(snapshot, key)) out.push(lineOverlay(line, span, colors) as OverlayCreate)
  return out
}

export interface TradingOverlayContext {
  session: TradingSession
  instrumentFor: (key: string) => InstrumentInfo
  /** Console-prefix tag ('paper', 'replay'). */
  tag: string
  colors?: OverlayColors
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

const COLLAPSE_KEY = 'wd-onchart-orders:collapsed:'

/** Manages the trading overlays and on-chart widgets across a wall's panes. */
export class TradingOverlays {
  private panes = new Map<string, PaneEntry>()
  private snapshot: SimSnapshot | null = null
  private selected: string | null = null
  private colors: OverlayColors

  constructor(private ctx: TradingOverlayContext) {
    this.colors = ctx.colors ?? DEFAULT_COLORS
    registerTradeOverlays()
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
        commit: (line, price) => this.commit(line, price),
        isCollapsed: (compact) => readCollapsed(compact),
        setCollapsed: (compact, collapsed) => writeCollapsed(compact, collapsed)
      })
      this.panes.set(pane.id, entry)
      chart.subscribeAction('onVisibleRangeChange', entry.onRange)
      this.redraw(entry)
      entry.layer.render(this.snapshot)
    }
  }

  update(snapshot: SimSnapshot | null): void {
    const previous = this.snapshot
    this.snapshot = snapshot
    if (snapshot && previous && previous.id === snapshot.id) this.announce(previous, snapshot)
    if (this.selected && snapshot && !isWorking(snapshot, this.selected)) this.selected = null
    for (const entry of this.panes.values()) {
      this.redraw(entry)
      entry.layer.render(snapshot)
    }
  }

  select(id: string | null): void {
    if (this.selected === id) return
    this.selected = id
    for (const entry of this.panes.values()) {
      this.redraw(entry)
      entry.layer.render(this.snapshot)
    }
  }

  teardown(): void {
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
    const specs = this.snapshot && span && this.ctx.session.ready
      ? overlaysFor(this.snapshot, symbolKey(pane.getSymbol()), span, this.colors, this.selected)
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
      const find = (): LineSpec | null =>
        this.snapshot
          ? (linesFor(this.snapshot, symbolKey(entry.pane.getSymbol())).find(
              (l) => l.role === line.role && l.id === line.id
            ) ?? null)
          : null
      const priceOf = (event: OverlayEvent<unknown>): number | null => {
        const value = event.overlay.points?.[0]?.value
        return typeof value === 'number' ? value : null
      }
      created.onClick = () => {
        this.select(line.id)
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
        else if (line.role === 'order') next.entry = price
        entry.chart.overrideOverlay({
          id: bracketId,
          extendData: { wd: next },
          points: line.role === 'order' ? [{ timestamp: bracket.points[0]?.timestamp, value: price }] : bracket.points
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

  private async commit(line: LineSpec, price: number): Promise<void> {
    const session = this.ctx.session
    if (line.owner === 'trade') {
      if (line.role === 'stop') await session.modifyTrade(line.id, { stopLoss: price })
      else if (line.role === 'target') await session.modifyTrade(line.id, { takeProfit: price })
      return
    }
    if (line.role === 'order') await session.modifyOrder(line.id, { price })
    else if (line.role === 'stop') await session.modifyOrder(line.id, { stopLoss: price })
    else if (line.role === 'target') await session.modifyOrder(line.id, { takeProfit: price })
  }
}

function isWorking(snapshot: SimSnapshot, id: string): boolean {
  return (
    snapshot.trades.some((t) => t.id === id && t.closedAt === null) ||
    snapshot.orders.some((o) => o.id === id && o.status === 'pending')
  )
}

function readCollapsed(compact: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_KEY + (compact ? 'compact' : 'regular'))
    if (raw === '1') return true
    if (raw === '0') return false
  } catch {
    // storage blocked: fall through to the default
  }
  // A phone-sized pane starts rolled up: the card would otherwise cover most of the candles.
  return compact
}

function writeCollapsed(compact: boolean, collapsed: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSE_KEY + (compact ? 'compact' : 'regular'), collapsed ? '1' : '0')
  } catch {
    // the card still toggles; it just will not remember
  }
}
