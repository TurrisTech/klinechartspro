import type { Chart, Overlay, OverlayCreate } from 'klinecharts'
import type { ChartProPane } from '../../src'
import type { SimSnapshot, SimTrade } from './api'
import { symbolKey } from './format'

// The trading overlays on each candle pane: a horizontal line per pending order, per open
// trade (its entry), and per protective stop/target, coloured by side and drawn only for the
// pane's own instrument. Modelled on the Levels layer (client/levels/layer.ts): overlays are
// stamped with a `groupId` so the whole set can be removed and rebuilt from a snapshot, and
// every price line spans a clamped window so klinecharts never extrapolates a ray to a
// runaway coordinate and locks the tab.
//
// A trade's stop and target lines are DRAGGABLE: releasing one calls back with the new price,
// which the caller sends as a trade amendment. Everything else is locked -- dragging an entry
// line would imply the fill can move, which it cannot.

const GROUP = 'wd-paper'
const CANDLE_PANE = 'candle_pane'

// Far enough past the visible window that a ray reaches the edge at any zoom, but bounded so
// it is never the runaway coordinate the levels note warns about.
const DRAW_MARGIN_FACTOR = 1

export interface OverlayColors {
  buy: string
  sell: string
  pending: string
  stop: string
  target: string
}

export const DEFAULT_COLORS: OverlayColors = {
  buy: '#26a69a',
  sell: '#ef5350',
  pending: '#787b86',
  stop: '#ef5350',
  target: '#26a69a'
}

export type DragHandler = (kind: 'stop' | 'target', trade: SimTrade, price: number) => void

interface OverlayDatum {
  wd: {
    kind: 'order' | 'entry' | 'stop' | 'target'
    id: string
    draggable: boolean
    trade?: SimTrade
  }
}

function drawWindow(chart: Chart): { from: number; to: number } | null {
  const data = chart.getDataList()
  if (data.length === 0) return null
  const from = data[0].timestamp
  const to = data[data.length - 1].timestamp
  const span = Math.max(to - from, 1)
  return { from: from - span * DRAW_MARGIN_FACTOR, to: to + span * DRAW_MARGIN_FACTOR }
}

// A locked line spans the full window as a plain segment; a draggable one is a
// `horizontalStraightLine` (one point, spans the whole pane) so a drag has a single price to
// report. klinecharts renders the overlay's price on the y-axis for both by default.
function line(
  price: number,
  color: string,
  datum: OverlayDatum['wd'],
  window: { from: number; to: number },
  dashed = false
): OverlayCreate {
  const style = { color, size: 1, style: dashed ? ('dashed' as const) : ('solid' as const) }
  if (datum.draggable) {
    return {
      name: 'horizontalStraightLine',
      paneId: CANDLE_PANE,
      lock: false,
      extendData: { wd: datum } as OverlayDatum,
      styles: { line: style },
      points: [{ timestamp: window.from, value: price }]
    }
  }
  return {
    name: 'horizontalSegment',
    paneId: CANDLE_PANE,
    lock: true,
    extendData: { wd: datum } as OverlayDatum,
    styles: { line: style },
    points: [
      { timestamp: window.from, value: price },
      { timestamp: window.to, value: price }
    ]
  }
}

/** Every overlay for one snapshot on one pane's instrument. Pure. */
export function overlaysFor(
  snapshot: SimSnapshot,
  key: string,
  window: { from: number; to: number },
  colors: OverlayColors
): OverlayCreate[] {
  const out: OverlayCreate[] = []
  for (const order of snapshot.orders) {
    if (order.symbol !== key || order.status !== 'pending' || order.price === null) continue
    out.push(line(order.price, colors.pending, { kind: 'order', id: order.id, draggable: false }, window, true))
  }
  for (const trade of snapshot.trades) {
    if (trade.symbol !== key || trade.closedAt !== null) continue
    const color = trade.side === 'buy' ? colors.buy : colors.sell
    out.push(line(trade.entryPrice, color, { kind: 'entry', id: trade.id, draggable: false }, window))
    if (trade.stopLoss !== null) {
      out.push(line(trade.stopLoss, colors.stop, { kind: 'stop', id: trade.id, draggable: true, trade }, window, true))
    }
    if (trade.takeProfit !== null) {
      out.push(line(trade.takeProfit, colors.target, { kind: 'target', id: trade.id, draggable: true, trade }, window, true))
    }
  }
  return out
}

/** Manages the trading overlays across a wall's panes. One instance per mounted wall. */
export class TradingOverlays {
  private panes = new Map<string, { pane: ChartProPane; chart: Chart }>()
  private snapshot: SimSnapshot | null = null
  private colors: OverlayColors = DEFAULT_COLORS

  constructor(private onDrag: DragHandler) {}

  /** Called from the wall's onPanesChange, exactly like a ChartLayer's sync. */
  sync(panes: ChartProPane[]): void {
    const live = new Set(panes.map((p) => p.id))
    for (const [id, entry] of this.panes) {
      if (!live.has(id)) {
        this.clear(entry.chart)
        this.panes.delete(id)
      }
    }
    for (const pane of panes) {
      if (this.panes.has(pane.id)) continue
      const chart = pane.getChart()
      if (!chart) continue
      const entry = { pane, chart }
      this.panes.set(pane.id, entry)
      chart.subscribeAction('onVisibleRangeChange', () => this.redraw(entry))
      this.redraw(entry)
    }
  }

  update(snapshot: SimSnapshot | null): void {
    this.snapshot = snapshot
    for (const entry of this.panes.values()) this.redraw(entry)
  }

  private clear(chart: Chart): void {
    try {
      chart.removeOverlay({ groupId: GROUP })
    } catch {
      // chart disposed
    }
  }

  private redraw(entry: { pane: ChartProPane; chart: Chart }): void {
    const { pane, chart } = entry
    this.clear(chart)
    if (!this.snapshot) return
    const key = symbolKey(pane.getSymbol())
    const window = drawWindow(chart)
    if (!window) return
    for (const spec of overlaysFor(this.snapshot, key, window, this.colors)) {
      const created = spec as OverlayCreate & {
        groupId: string
        onPressedMoveEnd?: (e: { overlay: Overlay }) => boolean
      }
      created.groupId = GROUP
      const datum = (spec.extendData as OverlayDatum | undefined)?.wd
      if (datum?.draggable && datum.trade) {
        const trade = datum.trade
        const kind = datum.kind as 'stop' | 'target'
        created.onPressedMoveEnd = (e: { overlay: Overlay }) => {
          const price = e.overlay.points?.[0]?.value
          if (typeof price === 'number') this.onDrag(kind, trade, price)
          return false
        }
      }
      try {
        chart.createOverlay(created)
      } catch (err) {
        console.warn('[paper] overlay create failed', err)
      }
    }
  }

  teardown(): void {
    for (const entry of this.panes.values()) this.clear(entry.chart)
    this.panes.clear()
  }
}
