import { registerOverlay, utils } from 'klinecharts'
import type { OverlayFigure, OverlayTemplate } from 'klinecharts'
import type { SimOrder, SimSide, SimSnapshot, SimTrade } from './api'

// The two chart figures a trade is drawn with, registered once per page.
//
// `wdTradeLine` -- one horizontal line across the pane and a PERSISTENT price tag on the axis.
// It is a registered template for the reason client/watch/template.ts gives: `OverlayCreate`
// omits `createYAxisFigures`, and klinecharts' default axis tag is drawn only while the overlay
// is selected. The line figure carries events, so an unlocked instance is draggable by the
// line itself (`eventPressedOtherMove` applies the pointer's delta to the single point); the
// HTML label beside it (onchart.ts) is the larger handle for the same move.
//
// `wdTradeBracket` -- what connects a position's entry to its stop and target: a translucent
// loss band from the entry to the stop, a profit band from the entry to the target, both from
// the bar the position opened on to the right edge, a dashed connector down that bar, and a dot
// where the entry filled. Every figure ignores events, so the bracket never steals a pan or a
// click from the chart underneath it.

export const TRADE_LINE = 'wdTradeLine'
export const TRADE_BRACKET = 'wdTradeBracket'

export type LineRole = 'entry' | 'order' | 'stop' | 'target'

/** What a trade line carries; the manager reads it back on every drag event. */
export interface TradeLineData {
  wd: {
    role: LineRole
    owner: 'trade' | 'order'
    id: string
  }
}

export interface TradeBracketData {
  wd: {
    owner: 'trade' | 'order'
    id: string
    entry: number
    stop: number | null
    target: number | null
    /** Selected brackets are drawn stronger; the rest recede so a busy pane stays legible. */
    selected: boolean
    lossColor: string
    profitColor: string
    entryColor: string
    /** A pending order has not filled: no fill dot, and a fainter band. */
    pending: boolean
  }
}

const lineTemplate: OverlayTemplate<TradeLineData> = {
  name: TRADE_LINE,
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, bounding }) => {
    if (coordinates.length === 0) return []
    const y = coordinates[0].y
    return [{ type: 'line', attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] } }]
  },
  createYAxisFigures: ({ chart, overlay, coordinates, bounding, yAxis }) => {
    if (coordinates.length === 0) return []
    const value = overlay.points[0]?.value
    if (typeof value !== 'number') return []
    const fromZero = yAxis?.isFromZero() ?? false
    const precision = chart.getSymbol()?.pricePrecision ?? 5
    return {
      type: 'text',
      attrs: {
        x: fromZero ? 0 : bounding.width,
        y: coordinates[0].y,
        text: utils.formatPrecision(value, precision),
        align: fromZero ? 'left' : 'right',
        baseline: 'middle'
      },
      ignoreEvent: true
    }
  }
}

/** `#rrggbb` at an alpha, for the translucent bands. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return hex
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`
}

const bracketTemplate: OverlayTemplate<TradeBracketData> = {
  name: TRADE_BRACKET,
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates, bounding, yAxis }) => {
    const datum = overlay.extendData?.wd
    if (!datum || coordinates.length === 0 || !yAxis) return []
    // The anchor bar may be scrolled off either side; the bands still run to the right edge.
    const x = Math.min(Math.max(coordinates[0].x, 0), bounding.width)
    const yEntry = yAxis.convertToPixel(datum.entry)
    const alpha = (datum.selected ? 0.16 : 0.06) * (datum.pending ? 0.6 : 1)
    const figures: OverlayFigure[] = []
    const band = (price: number | null, color: string): number | null => {
      if (price === null) return null
      const y = yAxis.convertToPixel(price)
      figures.push({
        type: 'rect',
        attrs: { x, y: Math.min(y, yEntry), width: Math.max(bounding.width - x, 0), height: Math.abs(y - yEntry) },
        styles: { style: 'fill', color: withAlpha(color, alpha) },
        ignoreEvent: true
      })
      return y
    }
    const yStop = band(datum.stop, datum.lossColor)
    const yTarget = band(datum.target, datum.profitColor)
    if (datum.selected && (yStop !== null || yTarget !== null) && coordinates[0].x >= 0) {
      figures.push({
        type: 'line',
        attrs: { coordinates: [{ x, y: yStop ?? yEntry }, { x, y: yTarget ?? yEntry }] },
        styles: { style: 'dashed', dashedValue: [3, 3], color: withAlpha(datum.entryColor, 0.7), size: 1 },
        ignoreEvent: true
      })
    }
    if (!datum.pending && coordinates[0].x >= 0 && coordinates[0].x <= bounding.width) {
      figures.push({
        type: 'circle',
        attrs: { x, y: yEntry, r: datum.selected ? 4 : 3 },
        styles: { style: 'fill', color: datum.entryColor },
        ignoreEvent: true
      })
    }
    return figures
  }
}

// -- which lines a snapshot draws (pure) --------------------------------------------------------

export interface OverlayColors {
  buy: string
  sell: string
  stop: string
  target: string
}

export const DEFAULT_COLORS: OverlayColors = {
  buy: '#26a69a',
  sell: '#ef5350',
  stop: '#ef5350',
  target: '#26a69a'
}

/** One line on the pane, as both the canvas and the HTML layer see it. */
export interface LineSpec {
  role: LineRole
  owner: 'trade' | 'order'
  id: string
  side: SimSide
  price: number
  draggable: boolean
}

export function lineKey(line: Pick<LineSpec, 'role' | 'id'>): string {
  return `${line.role}:${line.id}`
}

/** The open trades and pending orders of one instrument, oldest first. */
export function workingFor(snapshot: SimSnapshot, key: string): { trades: SimTrade[]; orders: SimOrder[] } {
  return {
    trades: snapshot.trades
      .filter((t) => t.symbol === key && t.closedAt === null)
      .sort((a, b) => a.openedAt - b.openedAt),
    orders: snapshot.orders
      .filter((o) => o.symbol === key && o.status === 'pending' && o.price !== null)
      .sort((a, b) => a.createdAt - b.createdAt)
  }
}

/** Every line for one snapshot on one instrument. Pure. */
export function linesFor(snapshot: SimSnapshot, key: string): LineSpec[] {
  const { trades, orders } = workingFor(snapshot, key)
  const out: LineSpec[] = []
  for (const order of orders) {
    const base = { owner: 'order' as const, id: order.id, side: order.side, draggable: true }
    out.push({ ...base, role: 'order', price: order.price as number })
    if (order.stopLoss !== null) out.push({ ...base, role: 'stop', price: order.stopLoss })
    if (order.takeProfit !== null) out.push({ ...base, role: 'target', price: order.takeProfit })
  }
  for (const trade of trades) {
    const base = { owner: 'trade' as const, id: trade.id, side: trade.side }
    out.push({ ...base, role: 'entry', price: trade.entryPrice, draggable: false })
    if (trade.stopLoss !== null) out.push({ ...base, role: 'stop', price: trade.stopLoss, draggable: true })
    if (trade.takeProfit !== null) out.push({ ...base, role: 'target', price: trade.takeProfit, draggable: true })
  }
  return out
}

export function lineColor(line: Pick<LineSpec, 'role' | 'side'>, colors: OverlayColors): string {
  if (line.role === 'stop') return colors.stop
  if (line.role === 'target') return colors.target
  return line.side === 'buy' ? colors.buy : colors.sell
}

let registered = false

/** Idempotent: klinecharts' overlay registry is process-global. */
export function registerTradeOverlays(): void {
  if (registered) return
  registered = true
  registerOverlay(lineTemplate)
  registerOverlay(bracketTemplate)
}
