import { registerIndicator, type Indicator, type IndicatorTemplate, type KLineData } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import type { MtfInterval } from './api'
import { MTF_DEFAULTS, enabledIntervals, graphConfig, type MtfConfig, type MtfTimeframeStyle } from './config'
import { buildGraphs, type GraphSide, type GraphSignal, graphStart, rootLookbackMs, storeGraphSignals } from './graph'
import type { MtfOverlay } from './overlays'
import { chartBarAt, chartOpens, shiftSignals, type ShiftedSignal } from './shift'
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
  /** The timeframe this pane's signal graphs start from, or null for none. The controller
   * decides it (plugin.ts `graphRoot`): only on an overlay that offers a graph, with the
   * setting on and the root among the timeframes drawn. */
  graphRoot?: MtfInterval | null
}

/** One placed signal, plus which timeframe placed it — the template draws several at once
 * now, so a marker has to carry its own provenance. */
interface Marked extends ShiftedSignal {
  interval: MtfInterval
  /** Position in the enabled set: the drawing lane, so timeframes never overlap. */
  lane: number
}

/** One graph node, on the chart bar its marker sits on. */
interface GraphDot {
  interval: MtfInterval
  price: number
  side: GraphSide
  /** A root-timeframe signal: where a graph starts. */
  root: boolean
}

/** One graph edge, filed on its CHILD's bar -- the later end. */
interface GraphEdge {
  /** The parent's bar index in the chart's data list -- negative and fractional when the
   * parent is older than the loaded bars (`placeGraphs`). */
  fromIndex: number
  fromPrice: number
  toPrice: number
  /** The child's timeframe, whose colour the edge takes. */
  interval: MtfInterval
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

function calc(dataList: KLineData[], indicator: Indicator<Value, number, ExtendData>): Value[] {
  const extend = indicator.extendData
  if (!extend) return dataList.map(() => ({}))
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
  if (extend.graphRoot) placeGraphs(values, dataList, extend, extend.graphRoot)
  return values
}

/**
 * The signal graphs (graph.ts), filed on the chart bars their markers sit on.
 *
 * Built from every signal the drawn timeframes' stores hold, from the start of the graph in
 * force at the loaded left edge -- the same `graphStart` the controller sized those stores'
 * windows by, so the walk begins where the fetched history is known to be whole. A node on
 * no loaded bar is not drawn.
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
function placeGraphs(values: Value[], dataList: KLineData[], extend: ExtendData, root: MtfInterval): void {
  if (dataList.length === 0) return
  const signals: GraphSignal[] = []
  const rootSignals: GraphSignal[] = []
  for (const [interval, key] of Object.entries(extend.seriesKeys)) {
    const store = peekStore<RegistryStore<ArevPoint>>(key)
    if (!store) continue
    const read = storeGraphSignals(interval, store)
    signals.push(...read)
    if (interval === root) rootSignals.push(...read)
  }
  const chartAbs = chartOpens(extend.chartInterval, dataList)
  const settings = graphConfig(extend.config)
  const graphs = buildGraphs(signals, {
    root,
    // The settings panel commits every keystroke, so a half-typed number reaches here.
    maxStep: Math.max(2, settings.maxStep),
    from: graphStart(rootSignals, chartAbs[0], rootLookbackMs(root))
  })
  const last = chartAbs.length - 1
  const msPerBar = last > 0 ? (chartAbs[last] - chartAbs[0]) / last : resolutionDurationMs(extend.chartInterval)
  /** Where a parent sits: its bar, or an extrapolated index left of the loaded bars. */
  const parentIndex = (knownAt: number): number | null => {
    if (knownAt < chartAbs[0]) return (knownAt - chartAbs[0]) / msPerBar
    const at = chartBarAt(knownAt, chartAbs, extend.chartInterval)
    return at < 0 ? null : at
  }
  for (const graph of graphs) {
    const at = graph.nodes.map((node) => chartBarAt(node.signal.knownAt, chartAbs, extend.chartInterval))
    graph.nodes.forEach((node, k) => {
      const index = at[k]
      if (index < 0) return
      const value = values[index]
      const interval = node.signal.interval as MtfInterval
      value.dots = value.dots ?? []
      value.dots.push({ interval, price: node.signal.price, side: graph.side, root: node.parent < 0 })
      if (node.parent < 0) return
      const parent = graph.nodes[node.parent].signal
      const fromIndex = parentIndex(parent.knownAt)
      if (fromIndex === null) return
      value.edges = value.edges ?? []
      value.edges.push({
        fromIndex,
        fromPrice: parent.price,
        toPrice: node.signal.price,
        interval
      })
    })
  }
}

function shouldUpdate(prev: Indicator<Value, number, ExtendData>, cur: Indicator<Value, number, ExtendData>) {
  const a = prev.extendData
  const b = cur.extendData
  const dataChanged =
    a?.rev !== b?.rev ||
    a?.chartInterval !== b?.chartInterval ||
    a?.graphRoot !== b?.graphRoot ||
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
 * off screen -- hence the walk runs to the end of the data, not to the visible range's. */
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
  for (let i = from; i < result.length; i++) {
    const edges = result[i]?.edges
    if (!edges) continue
    for (const edge of edges) {
      if (edge.fromIndex > to) continue
      const color = config.timeframes[edge.interval]?.color
      if (!color) continue
      ctx.strokeStyle = color
      ctx.beginPath()
      ctx.moveTo(x(edge.fromIndex), y(edge.fromPrice))
      ctx.lineTo(x(i), y(edge.toPrice))
      ctx.stroke()
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
      extendData: { seriesKeys: {}, rev: 0, chartInterval: '', config: MTF_DEFAULTS, graphRoot: null },
      series: 'price',
      figures: [],
      minValue: null,
      maxValue: null,
      styles: null,
      shouldUpdate,
      calc,
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
        if (indicator.extendData?.graphRoot) {
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
