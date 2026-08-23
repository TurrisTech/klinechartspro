import { registerIndicator, type Indicator, type IndicatorTemplate, type KLineData } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import { MTF_GENERATION, MTF_INTERVALS, isMtfInterval, type MtfInterval } from './api'
import { shiftSignals, type ShiftedSignal } from './shift'
import { peekStore } from './store'

// One klinecharts indicator template per SOURCE timeframe, all on the PRICE pane. A
// higher-timeframe vote is context for the candles in front of you, so it belongs on
// them; a sub-pane would ask the reader to map a mark back onto a price themselves.
//
// Why a template per timeframe rather than one template with a timeframe setting: the
// picker is already a list of checkboxes, so ticking `AREV21 4h` and `AREV21 1D` IS the
// multi-select, it persists with the saved layout for free, and each timeframe gets its
// own legend row and its own drawing lane. The alternative would have been the params
// dialog, which edits a flat NUMERIC array (src/config/indicators.ts) and would have
// rendered the choice as `AREV21 (0, 1, 0, 1)`.
//
// Like every other app-registered template here (arev/templates.ts, indicators/
// templates.ts), `calc` computes no model: it reads the votes and the bar grid the
// controller fetched, and does the one piece of real work this overlay owns -- placing
// each vote one source bar forward, on the chart bar at which it became knowable (see
// shift.ts, which is where the reasoning lives).
//
// Declares no figures, on the marker-template rule: a vote's `p` must not enter the
// price pane's y-axis range, or a probability near 0.5 would rescale the candles into a
// hairline. With nothing declared to suppress, `draw` returns TRUE -- the opposite of
// the AREV sub-panes, which declare four lines and must return false or klinecharts
// renders none of them (`if (!isCover)`; klinechartspro #6 was that bug).

export const TEMPLATE_PREFIX = `MTF:${MTF_GENERATION}:`

export function templateName(interval: MtfInterval): string {
  return `${TEMPLATE_PREFIX}${interval}`
}

export function isMtfIndicator(name: string): boolean {
  return name.startsWith(TEMPLATE_PREFIX)
}

export function parseTemplateName(name: string): MtfInterval | null {
  if (!isMtfIndicator(name)) return null
  const rest = name.slice(TEMPLATE_PREFIX.length)
  return isMtfInterval(rest) ? rest : null
}

export interface ExtendData {
  seriesKey: string
  rev: number
  /** The chart's own interval. `calc` cannot ask the chart for it -- klinecharts hands a
   * template bars and nothing about the period they were sampled at -- and it is half of
   * every clock conversion the shift makes, so the controller supplies it. */
  chartInterval: string
  /** Which horizontal band this timeframe draws in, so two ticked timeframes never
   * overlap. Assigned by the controller across the templates actually on this pane
   * (0, 1, 2, ...) rather than from the timeframe's index in MTF_INTERVALS: ticking 3m
   * and 1D alone should put them in the first two lanes, not the first and the eighth. */
  lane: number
}

export interface Value {
  signals?: ShiftedSignal[]
}

const UP_COLOR = '#26A69A'
const DOWN_COLOR = '#EF5350'

/** Vertical room one timeframe's markers occupy: the arrow, its label, and a gap. */
const LANE_HEIGHT = 22
/** Clearance between the candle's own high/low and the first lane's arrow tip. */
const LANE_INSET = 6

function calc(dataList: KLineData[], indicator: Indicator<Value, number, ExtendData>): Value[] {
  const extend = indicator.extendData
  const store = extend?.seriesKey ? peekStore(extend.seriesKey) : undefined
  const sourceInterval = parseTemplateName(indicator.name)
  if (!store || !extend || !sourceInterval) return dataList.map(() => ({}))
  const placed = shiftSignals({
    sourceInterval,
    chartInterval: extend.chartInterval,
    points: store.values.values(),
    grid: store.grid(),
    chartBars: dataList
  })
  return dataList.map((bar) => {
    const signals = placed.get(bar.timestamp)
    return signals ? { signals } : {}
  })
}

function shouldUpdate(prev: Indicator<Value, number, ExtendData>, cur: Indicator<Value, number, ExtendData>) {
  const dataChanged =
    prev.extendData?.seriesKey !== cur.extendData?.seriesKey ||
    prev.extendData?.rev !== cur.extendData?.rev ||
    prev.extendData?.chartInterval !== cur.extendData?.chartInterval ||
    prev.extendData?.lane !== cur.extendData?.lane
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
  // `tipY` is the point of the arrow; the base is `size * 1.4` away, on the side the
  // arrow came from -- so an up arrow's body hangs BELOW its tip and a down arrow's above.
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

function label(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, above: boolean): void {
  ctx.save()
  ctx.font = '9px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = above ? 'bottom' : 'top'
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
  ctx.restore()
}

let registered = false

// Registers one template per source timeframe and returns the picker group for
// ChartProOptions.indicatorGroups. Call only when the server advertises 'arev' -- the
// same capability the AREV panes gate on, because this reads the same `/arev/values`.
export function registerMtfIndicators(): IndicatorGroup[] {
  const group: IndicatorGroup = {
    label: 'AREV21 multi-timeframe · price pane',
    main: true,
    items: []
  }
  for (const interval of MTF_INTERVALS) {
    const name = templateName(interval)
    if (!registered) {
      const template: IndicatorTemplate<Value, number, ExtendData> = {
        name,
        shortName: `A21 ${interval}`,
        precision: 3,
        calcParams: [],
        shouldOhlc: false,
        shouldFormatBigNumber: false,
        visible: true,
        zLevel: 0,
        extendData: { seriesKey: '', rev: 0, chartInterval: '', lane: 0 },
        series: 'price',
        figures: [],
        minValue: null,
        maxValue: null,
        styles: null,
        shouldUpdate,
        calc,
        regenerateFigures: null,
        // Never reaches the screen: ChartPane.svelte's createIndicator wrapper replaces
        // every template's tooltip source with its own icons-only one. The `p` a reader
        // wants is drawn on the canvas beside the arrow instead.
        createTooltipDataSource: null,
        draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
          const data = chart.getDataList()
          const range = chart.getVisibleRange()
          const lane = indicator.extendData?.lane ?? 0
          const size = Math.max(3, Math.min(7, chart.getBarSpace().bar * 0.35))
          const offset = LANE_INSET + lane * LANE_HEIGHT
          for (let i = Math.max(0, range.realFrom); i <= Math.min(data.length - 1, range.realTo); i++) {
            const signals = indicator.result[i]?.signals
            if (!signals) continue
            const bar = data[i]
            const x = xAxis.convertToPixel(i)
            // Source timeframes are never finer than the chart's (shift.ts refuses that
            // outright), so at most one source bar can close inside one chart bar and
            // this loop runs once. Kept a loop because the placement is a general
            // many-to-one map and a stack of two is a better failure than one drawn over
            // the other.
            signals.forEach((signal, depth) => {
              const color = signal.up ? UP_COLOR : DOWN_COLOR
              const stack = offset + depth * LANE_HEIGHT
              if (signal.up) {
                // Below the low, pointing up into it.
                const tipY = yAxis.convertToPixel(bar.low) + stack
                arrow(ctx, x, tipY, size, color, true)
                label(ctx, x, tipY + size * 1.4 + 2, `${parseTemplateName(indicator.name)} ${signal.p.toFixed(2)}`, color, false)
              } else {
                const tipY = yAxis.convertToPixel(bar.high) - stack
                arrow(ctx, x, tipY, size, color, false)
                label(ctx, x, tipY - size * 1.4 - 2, `${parseTemplateName(indicator.name)} ${signal.p.toFixed(2)}`, color, true)
              }
            })
          }
          return true
        }
      }
      registerIndicator(template)
    }
    group.items.push({
      name,
      label: `AREV21 ${interval}`,
      description: `arev21 signals from the ${interval} series, drawn one ${interval} bar after the bar they were cast on`
    })
  }
  registered = true
  return [group]
}
