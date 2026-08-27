import { registerIndicator, type Indicator, type IndicatorTemplate, type KLineData } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import { MTF_GENERATION, type MtfInterval } from './api'
import { MTF_DEFAULTS, enabledIntervals, type MtfConfig, type MtfTimeframeStyle } from './config'
import { shiftSignals, type ShiftedSignal } from './shift'
import { peekStore } from '../plugins/store'
import type { ArevStore } from '../arev/store'

// ONE klinecharts indicator template, on the price pane, drawing arev21's signals from as
// many timeframes as the user has switched on.
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

export const TEMPLATE_NAME = `MTF:${MTF_GENERATION}`

export function isMtfIndicator(name: string): boolean {
  return name === TEMPLATE_NAME
}

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
}

/** One placed signal, plus which timeframe placed it — the template draws several at once
 * now, so a marker has to carry its own provenance. */
interface Marked extends ShiftedSignal {
  interval: MtfInterval
  /** Position in the enabled set: the drawing lane, so timeframes never overlap. */
  lane: number
}

export interface Value {
  marks?: Marked[]
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
    const store = peekStore<ArevStore>(key)
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
  return dataList.map((bar) => {
    const marks = byBar.get(bar.timestamp)
    return marks ? { marks } : {}
  })
}

function shouldUpdate(prev: Indicator<Value, number, ExtendData>, cur: Indicator<Value, number, ExtendData>) {
  const a = prev.extendData
  const b = cur.extendData
  const dataChanged =
    a?.rev !== b?.rev ||
    a?.chartInterval !== b?.chartInterval ||
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

let registered = false

// Registers the one template and returns the picker group for
// ChartProOptions.indicatorGroups. Call only when the server advertises 'arev' — the same
// capability the AREV panes gate on, because this reads the same GET /arev/values.
export function registerMtfIndicators(): IndicatorGroup[] {
  if (!registered) {
    const template: IndicatorTemplate<Value, number, ExtendData> = {
      name: TEMPLATE_NAME,
      shortName: 'AREV21 MTF',
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
      extendData: { seriesKeys: {}, rev: 0, chartInterval: '', config: MTF_DEFAULTS },
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
        const intervals = enabledIntervals(config)
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
            if (mark.up) {
              // Below the low, pointing up into it.
              const tipY = yAxis.convertToPixel(bar.low) + offset
              arrow(ctx, x, tipY, size, style.color, true)
              if (style.textSize > 0) {
                label(ctx, x, tipY + size * 1.4 + 2, text, style.color, style.textSize, false)
              }
            } else {
              const tipY = yAxis.convertToPixel(bar.high) - offset
              arrow(ctx, x, tipY, size, style.color, false)
              if (style.textSize > 0) {
                label(ctx, x, tipY - size * 1.4 - 2, text, style.color, style.textSize, true)
              }
            }
          }
        }
        return true
      }
    }
    registerIndicator(template)
    registered = true
  }
  return [
    {
      label: 'AREV21 multi-timeframe · price pane',
      main: true,
      items: [
        {
          name: TEMPLATE_NAME,
          label: 'AREV21 MTF',
          description:
            'arev21 signals from several timeframes at once, each drawn one bar of its own timeframe forward. Timeframes, colours and sizes are on the gear.'
        }
      ]
    }
  ]
}
