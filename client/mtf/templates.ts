import { registerIndicator, type Indicator, type IndicatorTemplate, type KLineData } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import type { MtfInterval } from './api'
import { GRAPH_ROOTS, MTF_DEFAULTS, enabledIntervals, graphConfig, type MtfConfig, type MtfTimeframeStyle } from './config'
import { publishDrawn, signalKey } from './drawn'
import { buildRootGraphs, type GraphSide, type GraphSignal, storeGraphSignals } from './graph'
import type { MtfOverlay } from './overlays'
import { chartBarAt, chartOpens, shiftSignals, toAbsolute, type ShiftedSignal } from './shift'
import { resolutionDurationMs } from '../periods'
import { peekStore } from '../plugins/store'
import type { ArevPoint } from '../arev/api'
import type { RegistryStore } from '../tsregistry/store'

// ONE klinecharts indicator template per overlay (overlays.ts), on the price pane, drawing
// that overlay's signals from as many timeframes as the user has switched on.
//
// It was eight templates — one per timeframe, ticked from the picker — and folding them
// into one is what makes per-timeframe STYLE possible at all. Eight picker entries gave a
// free multi-select but no place to put a colour: each was a separate indicator with a
// separate legend row, and klinecharts offers an indicator exactly one settings entry
// point, which edits a numeric `calcParams` array. One indicator has one gear, and that
// gear can open a panel with a group per timeframe (config.ts, drawn by the same
// chartlayers settings renderer the Levels layer uses).
//
// The trade is that "which timeframes" moves out of the picker and into that panel, and
// the legend collapses from eight rows to one naming the active set. Both are improvements
// at three timeframes and up, which is the case the overlay exists for.
//
// Like every other app-registered template here, `calc` computes no model: it reads the
// votes and bar grids the controller fetched, and does the one piece of real work this
// overlay owns — placing each vote one source bar forward, at the bar by which it was
// knowable (shift.ts, which is where that reasoning lives).
//
// Declares no figures, on the marker-template rule: a vote's `p` must not enter the price
// pane's y-axis range, or a probability near 0.5 would rescale the candles into a hairline.
// With nothing declared to suppress, `draw` returns TRUE — the opposite of the AREV
// sub-panes, which declare four lines and must return false or klinecharts renders none of
// them (`if (!isCover)`; klinechartspro #6 was that bug).

export interface ExtendData {
  /** Store key per source timeframe, for the timeframes currently switched on. */
  seriesKeys: Record<string, string>
  /** Bumped by the controller whenever any of those stores changes. */
  rev: number
  /** The chart's own interval. `calc` cannot ask the chart for it — klinecharts hands a
   * template bars and nothing about the period they were sampled at — and it is half of
   * every clock conversion the shift makes, so the controller supplies it. */
  chartInterval: string
  /** The live settings, so a colour or size change repaints without refetching anything. */
  config: MtfConfig
  /** The timeframes this pane's signal graphs start from, longest first; empty for none. The
   * controller decides them (plugin.ts `graphRootsFor`): only on an overlay that offers a
   * graph, and only roots switched on and among the timeframes drawn. */
  graphRoots?: MtfInterval[]
  /** `vendor:ticker` of the pane, for what the overlay publishes about what it drew
   * (drawn.ts). Only the graph overlay publishes, so only it needs this. */
  symbol?: string
}

/** One placed signal, plus which timeframe placed it — the template draws several at once
 * now, so a marker has to carry its own provenance. */
interface Marked extends ShiftedSignal {
  interval: MtfInterval
  /** Position in the enabled set: the drawing lane, so timeframes never overlap. */
  lane: number
}

/** One graph node, on the chart bar its marker sits on -- once, however many graphs it is
 * in (an 8h signal can root the 8h graphs and step in the 1D one). */
interface GraphDot {
  interval: MtfInterval
  price: number
  side: GraphSide
  /** Where some graph starts: drawn as a ring. */
  root: boolean
}

/** One graph edge, filed on its CHILD's bar -- the later end. */
interface GraphEdge {
  /** The parent's bar index in the chart's data list -- negative and fractional when the
   * parent is older than the loaded bars (`placeGraphs`). */
  fromIndex: number
  fromPrice: number
  toPrice: number
  /** The root timeframe of the graph the edge belongs to, whose colour it takes. With several
   * roots on, graphs overlap and cross, and the root's colour is what says which graph a line
   * is part of; the dots keep their own timeframe's colour, so each step still names its
   * timeframe. */
  root: MtfInterval
}

export interface Value {
  marks?: Marked[]
  dots?: GraphDot[]
  edges?: GraphEdge[]
}

/** Clearance between the candle's own high/low and the first lane. */
const LANE_INSET = 6
/** Vertical room one timeframe's markers occupy. Sized from the widest arrow and text the
 * settings allow, so a lane cannot collide with the next however the sizes are turned up. */
const LANE_GAP = 4

function laneHeight(style: MtfTimeframeStyle): number {
  return style.arrowSize * 1.4 + (style.textSize > 0 ? style.textSize + 2 : 0) + LANE_GAP
}

function calc(dataList: KLineData[], indicator: Indicator<Value, number, ExtendData>, overlay: MtfOverlay): Value[] {
  const extend = indicator.extendData
  if (!extend) return dataList.map(() => ({}))
  return computeValues(dataList, extend, overlay)
}

/** Everything `calc` decides, from the bars and the pane's settings: the markers, the graphs,
 * the "hide signals outside the graph" filter, and what the pane then publishes about what it
 * drew. Exported for its own test -- it reads the stores and nothing else. */
export function computeValues(dataList: KLineData[], extend: ExtendData, overlay: MtfOverlay): Value[] {
  const intervals = enabledIntervals(extend.config)
  // Per bar, the marks from every enabled timeframe, each tagged with its lane. Built once
  // here rather than in `draw` because `draw` runs every frame and this walks every vote.
  const byBar = new Map<number, Marked[]>()
  intervals.forEach((interval, lane) => {
    const key = extend.seriesKeys[interval]
    const store = peekStore<RegistryStore<ArevPoint>>(key)
    if (!store) return
    const placed = shiftSignals({
      sourceInterval: interval,
      chartInterval: extend.chartInterval,
      points: store.values.values(),
      grid: store.grid(),
      chartBars: dataList
    })
    for (const [timestamp, signals] of placed) {
      const marks = byBar.get(timestamp) ?? []
      for (const signal of signals) marks.push({ ...signal, interval, lane })
      byBar.set(timestamp, marks)
    }
  })
  const values: Value[] = dataList.map((bar) => {
    const marks = byBar.get(bar.timestamp)
    return marks ? { marks } : {}
  })
  const inGraph = extend.graphRoots?.length ? placeGraphs(values, dataList, extend, extend.graphRoots) : null
  // "Hide signals outside the graph": every arrow the graphs did not take comes off the pane.
  // Only with a graph drawn -- with no root on there is nothing to judge by, and emptying the
  // pane of its markers would read as a broken overlay rather than as a filter.
  if (inGraph && graphConfig(extend.config).onlyGraph) {
    for (const value of values) {
      if (!value.marks) continue
      const kept = value.marks.filter((mark) => inGraph.has(signalKey(mark.interval, mark.sourceDate)))
      if (kept.length > 0) value.marks = kept
      else value.marks = undefined
    }
  }
  if (overlay.graph && overlay.signals) publish(overlay, extend, dataList, values, byBar)
  return values
}

/** What this pane draws, for the replay's "next signal" (drawn.ts). Published from `calc`, so
 * it is the placement itself that is published rather than a second derivation of it. */
function publish(
  overlay: MtfOverlay,
  extend: ExtendData,
  dataList: KLineData[],
  values: Value[],
  byBar: Map<number, Marked[]>
): void {
  const signals = overlay.signals
  if (!signals || !extend.symbol) return
  const drawn = new Set<string>()
  for (const value of values) for (const mark of value.marks ?? []) drawn.add(signalKey(mark.interval, mark.sourceDate))
  const known = new Set<string>()
  for (const marks of byBar.values()) for (const mark of marks) known.add(signalKey(mark.interval, mark.sourceDate))
  const lastOpen = dataList.length > 0 ? toAbsolute(extend.chartInterval, dataList[dataList.length - 1].timestamp) : 0
  publishDrawn(`${extend.symbol}|${extend.chartInterval}|${overlay.id}`, {
    symbol: extend.symbol,
    plugin: signals.plugin,
    variant: signals.variant,
    intervals: Object.keys(extend.seriesKeys) as MtfInterval[],
    drawn,
    known,
    coversTo: lastOpen + resolutionDurationMs(extend.chartInterval)
  })
}

/**
 * The signal graphs (graph.ts), filed on the chart bars their markers sit on.
 *
 * Every root's graphs, each built from every signal the drawn timeframes' stores hold, from
 * the start of that root's graph in force at the loaded left edge -- the same `graphStart` the
 * controller sized those stores' windows by, so each walk begins where the fetched history is
 * known to be whole. A node on no loaded bar is not drawn.
 *
 * An edge INTO a drawn node from a parent older than the loaded bars is drawn all the same,
 * from where that parent would sit. On a short chart that is most of them -- a 5m chart holds
 * a day or two, and the root that a whole graph hangs from is usually days back -- so leaving
 * them out left the nodes floating with nothing to say what they had stepped from. The
 * parent's place is extrapolated at the loaded bars' own average spacing, which counts the
 * market-closed gaps inside the loaded span the way the chart does; it is exact once a pan
 * loads the parent's bar. An edge's child is never newer than the loaded bars (that would be
 * lookahead, and `chartBarAt` refuses it), so nothing is extrapolated to the right.
 */
function placeGraphs(values: Value[], dataList: KLineData[], extend: ExtendData, roots: MtfInterval[]): Set<string> {
  const inGraph = new Set<string>()
  if (dataList.length === 0) return inGraph
  const signals: GraphSignal[] = []
  for (const [interval, key] of Object.entries(extend.seriesKeys)) {
    const store = peekStore<RegistryStore<ArevPoint>>(key)
    if (store) signals.push(...storeGraphSignals(interval, store))
  }
  const chartAbs = chartOpens(extend.chartInterval, dataList)
  // The settings panel commits every keystroke, so a half-typed number reaches here.
  const maxStep = Math.max(2, graphConfig(extend.config).maxStep)
  const graphs = buildRootGraphs(signals, roots, maxStep, chartAbs[0])
  const last = chartAbs.length - 1
  const msPerBar = last > 0 ? (chartAbs[last] - chartAbs[0]) / last : resolutionDurationMs(extend.chartInterval)
  /** Where a parent sits: its bar, or an extrapolated index left of the loaded bars. */
  const parentIndex = (knownAt: number): number | null => {
    if (knownAt < chartAbs[0]) return (knownAt - chartAbs[0]) / msPerBar
    const at = chartBarAt(knownAt, chartAbs, extend.chartInterval)
    return at < 0 ? null : at
  }
  for (const graph of graphs) {
    const root = graph.root as MtfInterval
    const at = graph.nodes.map((node) => chartBarAt(node.signal.knownAt, chartAbs, extend.chartInterval))
    graph.nodes.forEach((node, k) => {
      inGraph.add(signalKey(node.signal.interval, node.signal.sourceDate))
      const index = at[k]
      if (index < 0) return
      const value = values[index]
      const interval = node.signal.interval as MtfInterval
      const price = node.signal.price
      value.dots = value.dots ?? []
      const same = value.dots.find((d) => d.interval === interval && d.price === price && d.side === graph.side)
      if (same) same.root ||= node.parent < 0
      else value.dots.push({ interval, price, side: graph.side, root: node.parent < 0 })
      if (node.parent < 0) return
      const parent = graph.nodes[node.parent].signal
      const fromIndex = parentIndex(parent.knownAt)
      if (fromIndex === null) return
      value.edges = value.edges ?? []
      value.edges.push({ fromIndex, fromPrice: parent.price, toPrice: price, root })
    })
  }
  return inGraph
}

function shouldUpdate(prev: Indicator<Value, number, ExtendData>, cur: Indicator<Value, number, ExtendData>) {
  const a = prev.extendData
  const b = cur.extendData
  const dataChanged =
    a?.rev !== b?.rev ||
    a?.chartInterval !== b?.chartInterval ||
    JSON.stringify(a?.graphRoots) !== JSON.stringify(b?.graphRoots) ||
    JSON.stringify(a?.seriesKeys) !== JSON.stringify(b?.seriesKeys) ||
    // A style-only edit still has to recalc, because which timeframes are ENABLED decides
    // both what `calc` places and each one's lane. Comparing the whole config rather than
    // just the enabled set keeps that honest if a future field affects placement too.
    JSON.stringify(a?.config) !== JSON.stringify(b?.config)
  return { calc: dataChanged, draw: true }
}

function arrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  tipY: number,
  size: number,
  color: string,
  pointingUp: boolean
): void {
  // `tipY` is the point of the arrow; the base is `size * 1.4` away, on the side it came
  // from — so an up arrow's body hangs BELOW its tip and a down arrow's above.
  const dir = pointingUp ? 1 : -1
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(x, tipY)
  ctx.lineTo(x - size, tipY + dir * size * 1.4)
  ctx.lineTo(x + size, tipY + dir * size * 1.4)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  ctx.restore()
}

function label(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
  size: number,
  above: boolean
): void {
  ctx.save()
  ctx.font = `${size}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = above ? 'bottom' : 'top'
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
  ctx.restore()
}

/** The signal graphs: every edge whose span reaches the visible range, then every node in
 * it. Edges are filed on their later end, so one reaching in from the right has its child
 * off screen -- hence the walk runs to the end of the data, not to the visible range's.
 *
 * One pass per root, shortest first, so where two graphs share a segment -- an 8h node's step
 * to a 1h signal is often the same line in the 8h graph and the 1D graph -- the longer root's
 * colour is the one on top. */
function drawGraphs(
  ctx: CanvasRenderingContext2D,
  result: Value[],
  config: MtfConfig,
  from: number,
  to: number,
  x: (index: number) => number,
  y: (price: number) => number
): void {
  const width = graphConfig(config).lineWidth
  if (!(width > 0)) return
  ctx.save()
  // Solid, said explicitly: the context arrives carrying whatever dash the last figure drawn
  // on the pane set (the Levels lines are dotted), and `save` preserves it.
  ctx.setLineDash([])
  ctx.lineWidth = width
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const layer of [...GRAPH_ROOTS].reverse()) {
    const color = config.timeframes[layer]?.color
    if (!color) continue
    ctx.strokeStyle = color
    for (let i = from; i < result.length; i++) {
      const edges = result[i]?.edges
      if (!edges) continue
      for (const edge of edges) {
        if (edge.root !== layer || edge.fromIndex > to) continue
        ctx.beginPath()
        ctx.moveTo(x(edge.fromIndex), y(edge.fromPrice))
        ctx.lineTo(x(i), y(edge.toPrice))
        ctx.stroke()
      }
    }
  }
  for (let i = from; i <= Math.min(to, result.length - 1); i++) {
    const dots = result[i]?.dots
    if (!dots) continue
    for (const dot of dots) {
      const color = config.timeframes[dot.interval]?.color
      if (!color) continue
      const cx = x(i)
      const cy = y(dot.price)
      ctx.beginPath()
      if (dot.root) {
        // A ring, so where a graph starts reads apart from the steps it takes.
        ctx.arc(cx, cy, width + 3, 0, Math.PI * 2)
        ctx.strokeStyle = color
        ctx.stroke()
      } else {
        ctx.arc(cx, cy, width + 1.5, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
      }
    }
  }
  ctx.restore()
}

const registered = new Set<string>()

// Registers the overlay's one template and returns its picker group for
// ChartProOptions.indicatorGroups. Call only when the server advertises the overlay's
// feature -- the host does, off the plugin's `feature`.
export function registerMtfIndicators(overlay: MtfOverlay): IndicatorGroup[] {
  if (!registered.has(overlay.templateName)) {
    const template: IndicatorTemplate<Value, number, ExtendData> = {
      name: overlay.templateName,
      shortName: overlay.title,
      precision: 3,
      // Deliberately empty, and it must stay empty: klinecharts prints calcParams into the
      // legend, and this indicator's settings are not numbers. See config.ts.
      calcParams: [],
      shouldOhlc: false,
      shouldFormatBigNumber: false,
      visible: true,
      zLevel: 0,
      // The real defaults, not an empty shell: klinecharts draws an indicator the moment it
      // is created, which is before the controller's next poll applies anything, so this
      // placeholder is what the first frames actually render against.
      extendData: { seriesKeys: {}, rev: 0, chartInterval: '', config: MTF_DEFAULTS, graphRoots: [] },
      series: 'price',
      figures: [],
      minValue: null,
      maxValue: null,
      styles: null,
      shouldUpdate,
      calc: (dataList, indicator) => calc(dataList, indicator, overlay),
      regenerateFigures: null,
      // Never reaches the screen: ChartPane.svelte's createIndicator wrapper replaces every
      // template's tooltip source with its own icons-only one. The `p` a reader wants is
      // drawn on the canvas beside the arrow instead.
      createTooltipDataSource: null,
      draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
        const config = indicator.extendData?.config
        if (!config) return true
        const data = chart.getDataList()
        const range = chart.getVisibleRange()
        // Under the markers, so a line never hides an arrow or its label.
        if (indicator.extendData?.graphRoots?.length) {
          drawGraphs(
            ctx,
            indicator.result,
            config,
            Math.max(0, range.realFrom),
            range.realTo,
            (index) => xAxis.convertToPixel(index),
            (price) => yAxis.convertToPixel(price)
          )
        }
        const intervals = enabledIntervals(config)
        const zoneAbove = overlay.placement === 'zone'
        // Lane offsets accumulate the heights of the lanes BELOW each one, so a timeframe
        // with big arrows and a label pushes the ones outside it out rather than being
        // drawn over by them.
        const offsets: number[] = []
        let running = LANE_INSET
        for (const interval of intervals) {
          offsets.push(running)
          const style = config.timeframes[interval]
          if (style) running += laneHeight(style)
        }
        for (let i = Math.max(0, range.realFrom); i <= Math.min(data.length - 1, range.realTo); i++) {
          const marks = indicator.result[i]?.marks
          if (!marks) continue
          const bar = data[i]
          const x = xAxis.convertToPixel(i)
          for (const mark of marks) {
            const style = config.timeframes[mark.interval]
            if (!style?.enabled) continue
            const offset = offsets[mark.lane] ?? LANE_INSET
            const size = style.arrowSize
            const text = `${mark.interval} ${mark.p.toFixed(2)}`
            // `'zone'` placement puts a long above the high and a short below the low; the
            // arrow still points the signal's way, so there it points away from the candle.
            const above = zoneAbove ? mark.up : !mark.up
            const armLength = size * 1.4
            if (!above) {
              // Below the low: an up arrow's tip touches the lane, a down arrow's base does.
              const nearY = yAxis.convertToPixel(bar.low) + offset
              const tipY = mark.up ? nearY : nearY + armLength
              arrow(ctx, x, tipY, size, style.color, mark.up)
              if (style.textSize > 0) {
                label(ctx, x, nearY + armLength + 2, text, style.color, style.textSize, false)
              }
            } else {
              const nearY = yAxis.convertToPixel(bar.high) - offset
              const tipY = mark.up ? nearY - armLength : nearY
              arrow(ctx, x, tipY, size, style.color, mark.up)
              if (style.textSize > 0) {
                label(ctx, x, nearY - armLength - 2, text, style.color, style.textSize, true)
              }
            }
          }
        }
        return true
      }
    }
    registerIndicator(template)
    registered.add(overlay.templateName)
  }
  return [
    {
      label: overlay.groupLabel,
      main: true,
      items: [
        {
          name: overlay.templateName,
          label: overlay.title,
          description: overlay.description
        }
      ]
    }
  ]
}
