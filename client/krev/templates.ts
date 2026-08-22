import { registerIndicator, type Indicator, type IndicatorTemplate, type KLineData, type TooltipLegend } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import { KREV_GENERATION, type KrevPoint } from './api'
import { peekStore, type BarPoints } from './store'

// One klinecharts indicator template, on the PRICE pane: krev01's votes belong at the
// extremes they are about, not in a sub-pane. Like the AREV templates, `calc` computes
// nothing — it reads the points the controller fetched from `/krev/values`.
//
// What is drawn, and what is not. A triangle sits on every extreme the server flagged as
// a signal (P(holds) at or above its threshold, off a full window): pointing down from
// above a top's high, up from below a bottom's low — the direction the reversal argues
// for, red for a top (down) and green for a bottom (up). Its fill is the outcome: solid
// once the extreme held, hollow once it failed, half-transparent while still in play.
// Candidates below the threshold are NOT drawn — about a third of all bars print a fresh
// extreme, and marking every one would bury the ones the model singled out — but every
// candidate on the crosshair bar, flagged or not, is in the tooltip with its p and outcome.
//
// Declares no figures (the marker-template rule from indicators/templates.ts): a price
// must not enter the pane's y-axis range through this template, and with nothing to
// suppress `draw` returns true.

export const TEMPLATE_NAME = `KREV:${KREV_GENERATION}`

export interface ExtendData {
  seriesKey: string
  rev: number
}

export type Value = BarPoints

const TOP_COLOR = '#EF5350'
const BOTTOM_COLOR = '#26A69A'

export function isKrevIndicator(name: string): boolean {
  return name === TEMPLATE_NAME
}

function triangle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  pointingDown: boolean,
  fill: 'solid' | 'hollow' | 'pending'
): void {
  const dir = pointingDown ? 1 : -1
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x - size, y - dir * size * 1.4)
  ctx.lineTo(x + size, y - dir * size * 1.4)
  ctx.closePath()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = color
  if (fill === 'hollow') {
    ctx.stroke()
    return
  }
  ctx.globalAlpha = fill === 'pending' ? 0.45 : 1
  ctx.fillStyle = color
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.stroke()
}

function calc(dataList: KLineData[], indicator: Indicator<Value, number, ExtendData>): Value[] {
  const key = indicator.extendData?.seriesKey
  const store = key ? peekStore(key) : undefined
  if (!store) return dataList.map(() => ({}))
  return dataList.map((d) => store.values.get(d.timestamp) ?? {})
}

function shouldUpdate(prev: Indicator<Value, number, ExtendData>, cur: Indicator<Value, number, ExtendData>) {
  const dataChanged =
    prev.extendData?.seriesKey !== cur.extendData?.seriesKey || prev.extendData?.rev !== cur.extendData?.rev
  return { calc: dataChanged, draw: true }
}

function describe(point: KrevPoint): string {
  const outcome = point.outcome ?? 'pending'
  const excursion = point.excursion == null ? '' : ` · ${point.excursion.toFixed(2)} ATR`
  return `p ${point.p.toFixed(3)} · n ${point.n} · ${outcome}${excursion}${point.signal ? ' · signal' : ''}`
}

let registered = false

// Registers the template once and returns the picker group for ChartProOptions.indicatorGroups.
// Call only when the server advertises 'krev'.
export function registerKrevIndicators(): IndicatorGroup[] {
  if (!registered) {
    const template: IndicatorTemplate<Value, number, ExtendData> = {
      name: TEMPLATE_NAME,
      shortName: KREV_GENERATION.toUpperCase(),
      precision: 3,
      calcParams: [],
      shouldOhlc: false,
      shouldFormatBigNumber: false,
      visible: true,
      zLevel: 0,
      extendData: { seriesKey: '', rev: 0 },
      series: 'price',
      figures: [],
      minValue: null,
      maxValue: null,
      styles: null,
      shouldUpdate,
      calc,
      regenerateFigures: null,
      createTooltipDataSource: ({ indicator, crosshair }) => {
        const legends: TooltipLegend[] = []
        const i = crosshair.dataIndex
        const bar = i == null ? undefined : indicator.result[i]
        if (bar?.top) legends.push({ title: { text: 'top: ', color: TOP_COLOR }, value: describe(bar.top) })
        if (bar?.bottom) legends.push({ title: { text: 'bottom: ', color: BOTTOM_COLOR }, value: describe(bar.bottom) })
        return { name: KREV_GENERATION.toUpperCase(), calcParamsText: '', features: [], legends }
      },
      draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
        const data = chart.getDataList()
        const range = chart.getVisibleRange()
        const size = Math.max(4, Math.min(9, chart.getBarSpace().bar * 0.45))
        for (let i = Math.max(0, range.realFrom); i <= Math.min(data.length - 1, range.realTo); i++) {
          const bar = indicator.result[i]
          if (bar == null) continue
          const x = xAxis.convertToPixel(i)
          for (const point of [bar.top, bar.bottom]) {
            if (!point?.signal) continue
            const fill = point.outcome === 'held' ? 'solid' : point.outcome === 'failed' ? 'hollow' : 'pending'
            if (point.side === 'top') {
              triangle(ctx, x, yAxis.convertToPixel(point.extreme) - 4, size, TOP_COLOR, true, fill)
            } else {
              triangle(ctx, x, yAxis.convertToPixel(point.extreme) + 4, size, BOTTOM_COLOR, false, fill)
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
      label: 'KREV research',
      main: true,
      items: [
        {
          name: TEMPLATE_NAME,
          label: KREV_GENERATION.toUpperCase(),
          description: 'k-NN reversal: does this fresh extreme hold? Signals on the price pane, outcome by fill'
        }
      ]
    }
  ]
}
