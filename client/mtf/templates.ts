import { registerIndicator, type Indicator, type IndicatorTemplate, type KLineData } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import type { MtfInterval } from './api'
import { GRAPH_ROOTS, MTF_DEFAULTS, graphConfig, graphLineStyle, type MtfConfig, type MtfTimeframeStyle } from './config'
import type { MtfOverlay } from './overlays'
import { chartBarAt, chartOpens } from './shift'
import { resolutionDurationMs } from '../periods'
import { peekStore } from '../plugins/store'
import type { MtfGraphStore } from './store'
import { gridOf, type Schedule } from '../replay/timeframes'
import { timestampCalc } from '../plugins/calc'

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
// `calc` computes no model and no graph: the server answers both (`GET /mtf/graph`, read into
// one store by plugin.ts), every row stamped with the instant it became knowable. What is left
// here is the chart's own business -- which of ITS bars was open at each of those instants
// (`chartBarAt`), how a bar's marks stack, and where an edge from a parent older than the loaded
// bars comes in from the left.
//
// Declares no figures, on the marker-template rule: a vote's `p` must not enter the price
// pane's y-axis range, or a probability near 0.5 would rescale the candles into a hairline.
// With nothing declared to suppress, `draw` returns TRUE — the opposite of the AREV
// sub-panes, which declare four lines and must return false or klinecharts renders none of
// them (`if (!isCover)`; klinechartspro #6 was that bug).

export interface ExtendData {
  /** The host's store key per source -- this overlay's one is `graph` (plugin.ts). */
  seriesKeys: Record<string, string>
  /** Bumped by the controller whenever that store changes. */
  rev: number
  /** The chart's own interval. `calc` cannot ask the chart for it — klinecharts hands a
   * template bars and nothing about the period they were sampled at — and every placement is
   * a question about its bars, so the controller supplies it. */
  chartInterval: string
  /** The pane's instrument's candle schedule (plugin.ts, from its resolved market hours):
   * every conversion between a wire date and an open is on it. Absent -- an unbound template,
   * or an instrument with no market hours -- nothing is placed. */
  schedule?: Schedule
  /** The live settings, so a colour or size change repaints without refetching anything. */
  config: MtfConfig
  /** The timeframes this pane's signal graphs start from, longest first; empty for none. */
  graphRoots?: MtfInterval[]
  /** The timeframes drawn, shortest first: the order a bar's marks stack in. */
  intervals?: MtfInterval[]
}

/** One placed signal, plus which timeframe placed it — the template draws several at once,
 * so a marker has to carry its own provenance. */
interface Marked {
  interval: MtfInterval
  /** The wire date of the candle it was cast on, on its own timeframe. */
  sourceDate: number
  /** The instant it became knowable, absolute. */
  knownAt: number
  p: number | null
  /** The server's label: `'long'` argues up. */
  up: boolean
  /** Position among the timeframes drawn: the order a bar's marks stack in, outward from the
   * candle, so the shorter timeframe is always the nearer one. Not a fixed distance (`draw`). */
  lane: number
}

/** One graph node, on the chart bar its marker sits on -- once, however many graphs it is
 * in (an 8h signal can root the 8h graphs and step in the 1D one). */
interface GraphDot {
  interval: MtfInterval
  price: number
  side: 'top' | 'bottom'
  /** Where some graph starts: drawn as a ring. */
  root: boolean
  /** A step on 5m or shorter -- an entry, as the server marks it: drawn as a star. */
  entry: boolean
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
  /** The timeframe the edge ARRIVES at -- its child's -- which is what its width and dash are
   * taken from (config.ts `graphLineStyle`): solid and full width into 3m or 5m, thinner and
   * more broken the higher the timeframe it reaches. */
  interval: MtfInterval
}

export interface Value {
  marks?: Marked[]
  dots?: GraphDot[]
  edges?: GraphEdge[]
}

/** Clearance between the candle's own high/low and the nearest mark. */
const LANE_INSET = 6
/** Space between one mark's room and the next one out on the same bar. A mark's room is
 * sized from its own arrow and text, so two cannot collide however the sizes are turned up. */
const LANE_GAP = 4

/** Space kept between a label and one on a neighbouring bar. */
const LABEL_SIDE_GAP = 2

function laneHeight(style: MtfTimeframeStyle): number {
  return style.arrowSize * 1.4 + (style.textSize > 0 ? style.textSize + 2 : 0) + LANE_GAP
}

/** The room one mark takes beside its candle, in pixels. */
export interface MarkRoom {
  /** Its bar's x. */
  x: number
  /** The candle edge it hangs from: the low's y for a mark below, the high's above. */
  edge: number
  above: boolean
  /** Half the wider of its arrow and its label, plus the gap kept beside it. */
  halfWidth: number
  /** Its arrow, label and the gap after them (`laneHeight`). */
  height: number
}

/**
 * Each mark's distance outward from its candle edge. On one bar the marks stack, shortest
 * timeframe nearest the candle; and a mark that would cross one already placed on a NEARBY bar
 * moves outward past it. A label is several bars wide on a short chart ("15m 0.58" spans five
 * or six 5m bars), so neighbours' labels at a similar height printed over each other.
 *
 * `rooms` come left to right, each bar's in stacking order, and a mark only ever moves outward,
 * so the nearest mark to a candle keeps its place and a cluster becomes a staircase. Exported for
 * its own test.
 */
export function placeMarks(rooms: readonly MarkRoom[]): number[] {
  const placed: Array<{ x: number; left: number; right: number; top: number; bottom: number }> = []
  const offsets: number[] = []
  let reach = 0
  for (const room of rooms) reach = Math.max(reach, room.halfWidth)
  let first = 0
  let barX = Number.NaN
  let below = LANE_INSET
  let above = LANE_INSET
  for (const room of rooms) {
    if (room.x !== barX) {
      barX = room.x
      below = above = LANE_INSET
    }
    // Nothing placed this far left can reach this mark.
    while (first < placed.length && placed[first].x + 2 * reach <= room.x) first++
    const left = room.x - room.halfWidth
    const right = room.x + room.halfWidth
    let offset = room.above ? above : below
    for (;;) {
      const top = room.above ? room.edge - offset - room.height : room.edge + offset
      const bottom = top + room.height
      let hit: (typeof placed)[number] | undefined
      for (let k = first; k < placed.length && !hit; k++) {
        const p = placed[k]
        if (left < p.right && right > p.left && top < p.bottom && bottom > p.top) hit = p
      }
      if (!hit) {
        placed.push({ x: room.x, left, right, top, bottom })
        break
      }
      // Just past it, outward -- always further than before, so this ends.
      offset = room.above ? room.edge - hit.top : hit.bottom - room.edge
    }
    offsets.push(offset)
    if (room.above) above = offset + room.height
    else below = offset + room.height
  }
  return offsets
}

/**
 * The placed marks and graphs, recomputed only when what they are computed FROM changes
 * (plugins/calc.ts): placement reads the bars' timestamps, never their prices, and the rows
 * come from the store, whose changes arrive as a new `extendData`. Rebuilding on every tick
 * cost the prod wall about 1.7 s of main thread a minute when the graph was built here
 * (2026-10-07). Exported for its own test.
 */
export const calc = timestampCalc((dataList: KLineData[], indicator: Indicator<Value, number, ExtendData>): Value[] => {
  const extend = indicator.extendData
  if (!extend) return dataList.map(() => ({}))
  return computeValues(dataList, extend)
})

/** Everything `calc` decides, from the bars and the pane's settings: the markers, the graphs and
 * the "hide signals outside the graph" filter. Exported for its own test -- it reads the store
 * and nothing else. */
export function computeValues(dataList: KLineData[], extend: ExtendData): Value[] {
  // No schedule, no placement: a wire date cannot be turned into an open without knowing how
  // the instrument dates its days.
  if (!extend.schedule || dataList.length === 0) return dataList.map(() => ({}))
  const store = peekStore<MtfGraphStore>(extend.seriesKeys?.graph)
  if (!store || typeof store.signals !== 'function') return dataList.map(() => ({}))
  const clock = gridOf(extend.schedule)
  const chartAbs = chartOpens(extend.chartInterval, dataList, clock)
  const lanes = new Map<string, number>((extend.intervals ?? []).map((interval, lane) => [interval, lane]))
  const graphOn = (extend.graphRoots?.length ?? 0) > 0
  const onlyGraph = graphOn && graphConfig(extend.config).onlyGraph
  const values: Value[] = dataList.map(() => ({}))
  for (const row of store.signals()) {
    const lane = lanes.get(row.interval)
    if (lane === undefined) continue
    // "Hide signals outside the graph": every arrow no graph took comes off the pane. Only with
    // a graph drawn -- with no root on there is nothing to judge by, and emptying the pane of
    // its markers would read as a broken overlay rather than as a filter.
    if (onlyGraph && !row.inGraph) continue
    const at = chartBarAt(row.knownAt, chartAbs, extend.chartInterval)
    if (at < 0) continue
    const value = values[at]
    value.marks = value.marks ?? []
    value.marks.push({
      interval: row.interval as MtfInterval,
      sourceDate: row.date,
      knownAt: row.knownAt,
      p: row.p,
      up: row.signal === 'long',
      lane
    })
  }
  // Stacked shortest timeframe nearest the candle: `draw` walks a bar's marks in this order.
  for (const value of values) value.marks?.sort((a, b) => a.lane - b.lane)
  if (graphOn) placeGraphs(values, store, extend, chartAbs)
  return values
}

/**
 * The server's graph nodes, filed on the chart bars their markers sit on.
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
function placeGraphs(values: Value[], store: MtfGraphStore, extend: ExtendData, chartAbs: number[]): void {
  const roots = new Set<string>(extend.graphRoots ?? [])
  const last = chartAbs.length - 1
  const msPerBar = last > 0 ? (chartAbs[last] - chartAbs[0]) / last : resolutionDurationMs(extend.chartInterval)
  /** Where a parent sits: its bar, or an extrapolated index left of the loaded bars. */
  const parentIndex = (knownAt: number): number | null => {
    if (knownAt < chartAbs[0]) return (knownAt - chartAbs[0]) / msPerBar
    const at = chartBarAt(knownAt, chartAbs, extend.chartInterval)
    return at < 0 ? null : at
  }
  for (const node of store.nodes()) {
    if (!roots.has(node.root)) continue
    const index = chartBarAt(node.knownAt, chartAbs, extend.chartInterval)
    if (index < 0) continue
    const value = values[index]
    const interval = node.interval as MtfInterval
    const isRoot = node.parent === null
    value.dots = value.dots ?? []
    const same = value.dots.find((d) => d.interval === interval && d.price === node.price && d.side === node.side)
    if (same) {
      same.root ||= isRoot
      same.entry ||= node.entry
    } else value.dots.push({ interval, price: node.price, side: node.side, root: isRoot, entry: node.entry })
    if (!node.parent) continue
    const fromIndex = parentIndex(node.parent.knownAt)
    if (fromIndex === null) continue
    value.edges = value.edges ?? []
    value.edges.push({ fromIndex, fromPrice: node.parent.price, toPrice: node.price, root: node.root as MtfInterval, interval })
  }
}

function shouldUpdate(prev: Indicator<Value, number, ExtendData>, cur: Indicator<Value, number, ExtendData>) {
  const a = prev.extendData
  const b = cur.extendData
  const dataChanged =
    a?.rev !== b?.rev ||
    a?.chartInterval !== b?.chartInterval ||
    JSON.stringify(a?.schedule) !== JSON.stringify(b?.schedule) ||
    JSON.stringify(a?.graphRoots) !== JSON.stringify(b?.graphRoots) ||
    JSON.stringify(a?.intervals) !== JSON.stringify(b?.intervals) ||
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

/** A five-pointed star centred on (`cx`, `cy`), point up, as a path for the caller to fill. */
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
  const graph = graphConfig(config)
  const width = graph.lineWidth
  if (!(width > 0)) return
  ctx.save()
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
        // Per edge, from the timeframe it arrives at. The dash is set every time, never left
        // to carry over -- from the edge before it, or from whatever the pane drew last (the
        // Levels lines are dotted), which `save` would preserve.
        const line = graphLineStyle(edge.interval, width)
        ctx.lineWidth = line.width
        ctx.setLineDash(line.dash)
        ctx.beginPath()
        ctx.moveTo(x(edge.fromIndex), y(edge.fromPrice))
        ctx.lineTo(x(i), y(edge.toPrice))
        ctx.stroke()
      }
    }
  }
  // The dots are drawn solid, whatever the last line set.
  ctx.setLineDash([])
  ctx.lineWidth = width
  for (let i = from; i <= Math.min(to, result.length - 1); i++) {
    const dots = result[i]?.dots
    if (!dots) continue
    for (const dot of dots) {
      const color = config.timeframes[dot.interval]?.color
      if (!color) continue
      const cx = x(i)
      const cy = y(dot.price)
      ctx.beginPath()
      if (dot.entry) {
        // A star where a path reaches 5m or below: the entry the graph exists to find. Several
        // times the step dot's size (user, 2026-10-01: "twice as big" as the first cut, which
        // was 2 * width + 4), outlined so a dark 5m or 3m fill still reads on a dark chart.
        star(ctx, cx, cy, 4 * width + 8)
        ctx.fillStyle = graph.starTimeframeColour === false ? (graph.starColor ?? color) : color
        ctx.fill()
        ctx.save()
        // Mitred, so the points stay points; the lines above are drawn with round joins.
        ctx.lineJoin = 'miter'
        ctx.strokeStyle = graph.starOutline ?? MTF_DEFAULTS.graph.starOutline
        ctx.stroke()
        ctx.restore()
      } else if (dot.root) {
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
      extendData: { seriesKeys: {}, rev: 0, chartInterval: '', config: MTF_DEFAULTS, graphRoots: [], intervals: [] },
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
        const zoneAbove = overlay.placement === 'zone'
        // Stacked per bar and per side, shortest timeframe nearest the candle: each mark sits
        // outside the ones this bar actually has, and outside any on a nearby bar its label would
        // cross (`placeMarks`). Not a fixed lane per enabled timeframe -- that reserved room for
        // every timeframe switched on, including the ones finer than the chart that never draw
        // on it, so a lone 2h mark on a 1h chart hung 30-140 px under the low and fell off the
        // bottom of the auto-sized axis (user, 2026-10-01). The price axis is sized from the
        // candles alone (no figures -- see the header), so the nearer a mark sits the likelier
        // it is on screen. `computeValues` sorts a bar's marks into lane order, so walking them
        // in order is the stacking order.
        //
        // The walk starts as far left of the screen as a label can reach, so a mark just off the
        // left edge both shows the part of its label that is on screen and still pushes the
        // marks beside it -- otherwise they would jump as it scrolled off.
        let widest = 0
        for (const style of Object.values(config.timeframes)) {
          if (style?.enabled) widest = Math.max(widest, style.arrowSize, style.textSize * 3)
        }
        const space = data.length > 1 ? Math.abs(xAxis.convertToPixel(1) - xAxis.convertToPixel(0)) : 0
        const lead = space > 0 ? Math.ceil(widest / space) : 0
        const placing: Array<{ mark: Marked; style: MtfTimeframeStyle; text: string; room: MarkRoom }> = []
        ctx.save()
        for (let i = Math.max(0, range.realFrom - lead); i <= Math.min(data.length - 1, range.realTo); i++) {
          const marks = indicator.result[i]?.marks
          if (!marks) continue
          const bar = data[i]
          const x = xAxis.convertToPixel(i)
          for (const mark of marks) {
            const style = config.timeframes[mark.interval]
            if (!style?.enabled) continue
            const text = mark.p === null ? mark.interval : `${mark.interval} ${mark.p.toFixed(2)}`
            ctx.font = `${style.textSize}px sans-serif`
            const textWidth = style.textSize > 0 ? ctx.measureText(text).width : 0
            // `'zone'` placement puts a long above the high and a short below the low; the
            // arrow still points the signal's way, so there it points away from the candle.
            const above = zoneAbove ? mark.up : !mark.up
            const room: MarkRoom = {
              x,
              edge: yAxis.convertToPixel(above ? bar.high : bar.low),
              above,
              halfWidth: Math.max(style.arrowSize, textWidth / 2) + LABEL_SIDE_GAP / 2,
              height: laneHeight(style)
            }
            placing.push({ mark, style, text, room })
          }
        }
        ctx.restore()
        const offsets = placeMarks(placing.map((p) => p.room))
        placing.forEach(({ mark, style, text, room }, k) => {
          const size = style.arrowSize
          const armLength = size * 1.4
          if (!room.above) {
            // Below the low: an up arrow's tip touches the lane, a down arrow's base does.
            const nearY = room.edge + offsets[k]
            const tipY = mark.up ? nearY : nearY + armLength
            arrow(ctx, room.x, tipY, size, style.color, mark.up)
            if (style.textSize > 0) label(ctx, room.x, nearY + armLength + 2, text, style.color, style.textSize, false)
          } else {
            const nearY = room.edge - offsets[k]
            const tipY = mark.up ? nearY - armLength : nearY
            arrow(ctx, room.x, tipY, size, style.color, mark.up)
            if (style.textSize > 0) label(ctx, room.x, nearY - armLength - 2, text, style.color, style.textSize, true)
          }
        })
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
