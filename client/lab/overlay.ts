import { type Indicator, type IndicatorTemplate, type KLineData, registerIndicator } from 'klinecharts'
import { graphLineStyle, MTF_DEFAULTS } from '../mtf/config'
import { chartBarAt, chartOpens } from '../mtf/shift'
import { resolutionDurationMs } from '../periods'
import { timestampCalc } from '../plugins/calc'
import type { CandleGrid } from '../replay/timeframes'
import type { LabRun } from './runner'

// THE STRATEGY OVERLAY: one price-pane template, `LAB:strategy`, drawing one run of a strategy
// (runner.ts) -- its graphs, its entries, the signals of its pool and its simulated trades -- on
// whatever chart it is on. The Strategy Lab's chart draws the run it just made; a dashboard pane
// draws a SAVED strategy's run on the pane's own instrument (./plugin.ts). The same template both
// ways, so what the lab shows is what the wall shows.
//
// Like the AREV21 MTF overlay (client/mtf/templates.ts), which it draws the graphs the same way
// as: every node sits on the chart bar in force when it became KNOWABLE (its candle's close --
// mtf/shift.ts `chartBarAt`), never on the bar it was cast on; edges take their graph's ROOT
// colour and their width and dash from the timeframe they arrive at; a root is a ring, a step a
// dot, an entry a star.
//
// The run itself is not in extendData -- it holds a candle grid of closures and maps, which
// extendData must not (it is compared and may be copied) -- but in a module registry under a key
// (`publishRun`); extendData carries the key and a revision.

export const LAB_TEMPLATE = 'LAB:strategy'
/** The lab page's own: the same drawing, driven by the page rather than by the plugin host, so
 * the host never binds it (./plugin.ts matches `LAB_TEMPLATE` only). Never in a picker. */
export const LAB_DRAFT_TEMPLATE = 'LAB:draft'

export interface ShowOptions {
  graphs: boolean
  entries: boolean
  /** Every signal of the pool, not only those in a graph. */
  signals: boolean
  trades: boolean
}

export const DEFAULT_SHOW: ShowOptions = { graphs: true, entries: true, signals: false, trades: true }

export interface LabExtendData {
  /** Where the run is (`publishRun`), or null for none. */
  runKey: string | null
  rev: number
  chartInterval: string
  show: ShowOptions
  /** An entry or trade to ring (the results table's selection): its entry id. */
  selected?: string | null
}

const runs = new Map<string, LabRun | null>()

/** File a run under `key` for every `LAB:strategy` indicator naming it; null clears it. */
export function publishRun(key: string, run: LabRun | null): void {
  runs.set(key, run)
}

export function publishedRun(key: string | null): LabRun | null {
  return key ? (runs.get(key) ?? null) : null
}

// -- placement ----------------------------------------------------------------------------------

interface Dot {
  interval: string
  price: number
  side: 'top' | 'bottom'
  root: boolean
  entry: boolean
  /** An entry the filter took out: a hollow star. */
  filtered: boolean
  selected: boolean
}

interface Edge {
  fromIndex: number
  fromPrice: number
  toPrice: number
  /** The root timeframe: the edge's colour. */
  root: string
  /** The timeframe it arrives at: its width and dash. */
  interval: string
}

interface Mark {
  interval: string
  side: 'top' | 'bottom'
}

interface TradeMark {
  kind: 'open' | 'close'
  direction: 'long' | 'short'
  price: number
  /** For a close: where its open sits, and how it went. */
  fromIndex?: number
  fromPrice?: number
  win?: boolean
  stop?: number | null
  target?: number | null
  selected: boolean
}

export interface Value {
  dots?: Dot[]
  edges?: Edge[]
  marks?: Mark[]
  trades?: TradeMark[]
}

/** Every element of the run on the chart bar it belongs to. Exported for its test. */
export function placeRun(dataList: KLineData[], run: LabRun, extend: LabExtendData): Value[] {
  const values: Value[] = dataList.map(() => ({}))
  if (dataList.length === 0) return values
  // One past the last bar too, for what became knowable at its close (mtf/shift.ts `chartBarAt`).
  const valueAt = (i: number): Value => {
    values[i] ??= {}
    return values[i]
  }
  const grid: CandleGrid = run.grid
  const chartAbs = chartOpens(extend.chartInterval, dataList, grid)
  const last = chartAbs.length - 1
  const msPerBar = last > 0 ? (chartAbs[last] - chartAbs[0]) / last : resolutionDurationMs(extend.chartInterval)
  const at = (knownAt: number): number => chartBarAt(knownAt, chartAbs, extend.chartInterval)
  /** Where something older than the loaded bars would sit, extrapolated to the left. */
  const index = (knownAt: number): number | null => {
    if (knownAt < chartAbs[0]) return (knownAt - chartAbs[0]) / msPerBar
    const i = at(knownAt)
    return i < 0 ? null : i
  }
  const { show } = extend
  const entryIds = new Set(run.entries.map((e) => e.id))
  const filteredIds = new Set(run.filtered.map((e) => e.id))
  const inGraph = new Set<string>()

  if (show.graphs || show.entries) {
    for (const graph of run.graphs) {
      graph.nodes.forEach((node, k) => {
        inGraph.add(node.signal.key)
        const i = at(node.signal.knownAt)
        if (i < 0) return
        const entry = show.entries && (entryIds.has(node.signal.key) || filteredIds.has(node.signal.key))
        const isRoot = node.parent < 0
        if (show.graphs || entry) {
          const value = valueAt(i)
          value.dots ??= []
          const same = value.dots.find((d) => d.interval === node.signal.interval && d.price === node.signal.price && d.side === graph.side)
          const dot: Dot = {
            interval: node.signal.interval,
            price: node.signal.price,
            side: graph.side,
            root: show.graphs && isRoot,
            entry,
            filtered: filteredIds.has(node.signal.key) && !entryIds.has(node.signal.key),
            selected: extend.selected === node.signal.key
          }
          if (same) {
            same.root ||= dot.root
            same.entry ||= dot.entry
            same.selected ||= dot.selected
          } else value.dots.push(dot)
        }
        if (!show.graphs || isRoot) return
        const parent = graph.nodes[node.parent].signal
        const from = index(parent.knownAt)
        if (from === null) return
        const value = valueAt(i)
        value.edges ??= []
        value.edges.push({ fromIndex: from, fromPrice: parent.price, toPrice: node.signal.price, root: graph.root, interval: node.signal.interval })
        void k
      })
    }
  }
  // Without a graph, entries are events: a star each.
  if (show.entries && !run.strategy.graph.enabled) {
    for (const entry of [...run.entries, ...run.filtered]) {
      const i = at(entry.at)
      if (i < 0) continue
      const value = valueAt(i)
      value.dots ??= []
      value.dots.push({
        interval: entry.signal.interval,
        price: entry.signal.price,
        side: entry.side,
        root: false,
        entry: true,
        filtered: filteredIds.has(entry.id),
        selected: extend.selected === entry.id
      })
    }
  }
  if (show.signals) {
    for (const signal of run.signals) {
      if (show.graphs && inGraph.has(signal.key)) continue
      const i = at(signal.knownAt)
      if (i < 0) continue
      const value = valueAt(i)
      value.marks ??= []
      value.marks.push({ interval: signal.interval, side: signal.side })
    }
  }
  if (show.trades && run.sim) {
    for (const trade of run.sim.trades) {
      const open = at(trade.openedAt)
      const selected = extend.selected === trade.entry.id
      if (open >= 0) {
        const value = valueAt(open)
        value.trades ??= []
        value.trades.push({ kind: 'open', direction: trade.direction, price: trade.openPrice, selected })
      }
      if (trade.closedAt === null || trade.closePrice === null) continue
      const close = at(trade.closedAt)
      if (close < 0) continue
      const from = index(trade.openedAt)
      const value = valueAt(close)
      value.trades ??= []
      value.trades.push({
        kind: 'close',
        direction: trade.direction,
        price: trade.closePrice,
        fromIndex: from ?? undefined,
        fromPrice: trade.openPrice,
        win: (trade.pnl ?? 0) > 0,
        stop: trade.stop,
        target: trade.target,
        selected
      })
    }
  }
  return values
}

/** A timeframe's colour: the MTF overlay's, so a 5m node is the same indigo in both. */
export function timeframeColor(interval: string): string {
  const style = (MTF_DEFAULTS.timeframes as Record<string, { color: string } | undefined>)[interval]
  if (style) return style.color
  return FALLBACK[Math.abs(hashCode(interval)) % FALLBACK.length]
}

const FALLBACK = ['#26A69A', '#EF5350', '#AB47BC', '#42A5F5', '#FFA726', '#8D6E63']

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

// -- the template ---------------------------------------------------------------------------------

const calc = timestampCalc((dataList: KLineData[], indicator: Indicator<Value, number, LabExtendData>): Value[] => {
  const extend = indicator.extendData
  const run = publishedRun(extend?.runKey ?? null)
  if (!extend || !run) return dataList.map(() => ({}))
  return placeRun(dataList, run, extend)
})

function shouldUpdate(prev: Indicator<Value, number, LabExtendData>, cur: Indicator<Value, number, LabExtendData>) {
  const a = prev.extendData
  const b = cur.extendData
  const changed =
    a?.runKey !== b?.runKey || a?.rev !== b?.rev || a?.chartInterval !== b?.chartInterval || a?.selected !== b?.selected || JSON.stringify(a?.show) !== JSON.stringify(b?.show)
  return { calc: changed, draw: true }
}

function star(ctx: CanvasRenderingContext2D, cx: number, cy: number, outer: number): void {
  const inner = outer * 0.45
  for (let k = 0; k < 10; k++) {
    const r = k % 2 === 0 ? outer : inner
    const a = -Math.PI / 2 + (k * Math.PI) / 5
    if (k === 0) ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
    else ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
  }
  ctx.closePath()
}

const WIDTH = 1.5
const WIN = '#26A69A'
const LOSS = '#EF5350'

function draw(ctx: CanvasRenderingContext2D, result: Value[], data: KLineData[], from: number, to: number, x: (i: number) => number, y: (p: number) => number): void {
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  // Edges first (the whole data list: one reaching in from the right has its child off screen).
  for (let i = from; i < result.length; i++) {
    for (const edge of result[i]?.edges ?? []) {
      if (edge.fromIndex > to) continue
      const line = graphLineStyle(edge.interval, WIDTH)
      ctx.strokeStyle = timeframeColor(edge.root)
      ctx.lineWidth = line.width
      ctx.setLineDash(line.dash)
      ctx.beginPath()
      ctx.moveTo(x(edge.fromIndex), y(edge.fromPrice))
      ctx.lineTo(x(i), y(edge.toPrice))
      ctx.stroke()
    }
    // Trades: the line from the open to the close, and the stop and target over the trade.
    for (const trade of result[i]?.trades ?? []) {
      if (trade.kind !== 'close' || trade.fromIndex === undefined || trade.fromPrice === undefined || trade.fromIndex > to) continue
      const color = trade.win ? WIN : LOSS
      ctx.setLineDash([4, 3])
      ctx.lineWidth = trade.selected ? 2.5 : 1.2
      ctx.strokeStyle = color
      ctx.beginPath()
      ctx.moveTo(x(trade.fromIndex), y(trade.fromPrice))
      ctx.lineTo(x(i), y(trade.price))
      ctx.stroke()
      ctx.setLineDash([2, 2])
      ctx.lineWidth = 1
      for (const [level, c] of [
        [trade.stop, LOSS],
        [trade.target, WIN]
      ] as const) {
        if (level === null || level === undefined) continue
        ctx.strokeStyle = c
        ctx.globalAlpha = 0.6
        ctx.beginPath()
        ctx.moveTo(x(trade.fromIndex), y(level))
        ctx.lineTo(x(i), y(level))
        ctx.stroke()
        ctx.globalAlpha = 1
      }
    }
  }
  ctx.setLineDash([])
  for (let i = Math.max(0, from); i <= Math.min(to, result.length - 1); i++) {
    const value = result[i]
    if (!value) continue
    const cx = x(i)
    // The slot after the last bar has no candle yet: its marks hang off the last close.
    const bar = data[i] ?? { high: data[data.length - 1].close, low: data[data.length - 1].close }
    for (const mark of value.marks ?? []) {
      // A pool signal outside any graph: a small triangle off the candle, its timeframe's colour.
      const above = mark.side === 'top'
      const tip = above ? y(bar.high) - 4 : y(bar.low) + 4
      const dir = above ? -1 : 1
      ctx.beginPath()
      ctx.moveTo(cx, tip)
      ctx.lineTo(cx - 3.5, tip + dir * 6)
      ctx.lineTo(cx + 3.5, tip + dir * 6)
      ctx.closePath()
      ctx.fillStyle = timeframeColor(mark.interval)
      ctx.globalAlpha = 0.7
      ctx.fill()
      ctx.globalAlpha = 1
    }
    for (const dot of value.dots ?? []) {
      const color = timeframeColor(dot.interval)
      const cy = y(dot.price)
      ctx.beginPath()
      ctx.lineWidth = WIDTH
      if (dot.entry) {
        star(ctx, cx, cy, 4 * WIDTH + 8)
        if (dot.filtered) {
          ctx.strokeStyle = color
          ctx.stroke()
        } else {
          ctx.fillStyle = color
          ctx.fill()
          ctx.save()
          ctx.lineJoin = 'miter'
          ctx.strokeStyle = MTF_DEFAULTS.graph.starOutline
          ctx.stroke()
          ctx.restore()
        }
      } else if (dot.root) {
        ctx.arc(cx, cy, WIDTH + 3, 0, Math.PI * 2)
        ctx.strokeStyle = color
        ctx.stroke()
      } else {
        ctx.arc(cx, cy, WIDTH + 1.5, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
      }
      if (dot.selected) {
        ctx.beginPath()
        ctx.arc(cx, cy, 4 * WIDTH + 14, 0, Math.PI * 2)
        ctx.strokeStyle = '#FFFFFF'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }
    for (const trade of value.trades ?? []) {
      const cy = y(trade.price)
      ctx.lineWidth = trade.selected ? 2.5 : 1.5
      if (trade.kind === 'open') {
        // A triangle pointing the trade's way, at the fill.
        const up = trade.direction === 'long'
        ctx.beginPath()
        ctx.moveTo(cx + 9, cy)
        ctx.lineTo(cx + 3, cy + (up ? 5 : -5))
        ctx.lineTo(cx + 15, cy + (up ? 5 : -5))
        ctx.closePath()
        ctx.fillStyle = up ? WIN : LOSS
        ctx.fill()
      } else {
        // An x at the close, in how it went.
        ctx.strokeStyle = trade.win ? WIN : LOSS
        ctx.beginPath()
        ctx.moveTo(cx - 4, cy - 4)
        ctx.lineTo(cx + 4, cy + 4)
        ctx.moveTo(cx + 4, cy - 4)
        ctx.lineTo(cx - 4, cy + 4)
        ctx.stroke()
      }
    }
  }
  ctx.restore()
}

let registered = false

/** Register the two templates (once per page). */
export function registerLabTemplate(): void {
  if (registered) return
  registered = true
  for (const name of [LAB_TEMPLATE, LAB_DRAFT_TEMPLATE]) registerIndicator(template(name))
}

function template(name: string): IndicatorTemplate<Value, number, LabExtendData> {
  return {
    name,
    shortName: 'STRATEGY',
    precision: 5,
    // Its settings are not numbers (the gear opens the plugin's own, ./plugin.ts).
    calcParams: [],
    shouldOhlc: false,
    shouldFormatBigNumber: false,
    visible: true,
    zLevel: 0,
    extendData: { runKey: null, rev: 0, chartInterval: '', show: DEFAULT_SHOW },
    series: 'price',
    // No figures: a price in the run must not rescale the candles (the marker-template rule).
    figures: [],
    minValue: null,
    maxValue: null,
    styles: null,
    shouldUpdate,
    calc,
    regenerateFigures: null,
    createTooltipDataSource: null,
    draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
      const range = chart.getVisibleRange()
      draw(
        ctx,
        indicator.result,
        chart.getDataList(),
        Math.max(0, range.realFrom),
        range.realTo,
        (i) => xAxis.convertToPixel(i),
        (p) => yAxis.convertToPixel(p)
      )
      return true
    }
  }
}
