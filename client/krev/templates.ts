import { registerIndicator, type Indicator, type IndicatorTemplate, type KLineData, type TooltipLegend } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import { KREV_GENERATION, type KrevPoint } from './api'
import { peekStore, type BarPoints } from './store'

// One klinecharts indicator template, on the PRICE pane: krev01's votes belong at the
// extremes they are about, not in a sub-pane. Like the AREV templates, `calc` computes
// nothing — it reads the points the controller fetched from `/krev/values`.
//
// What is drawn, and what is not. A triangle sits on an extreme the model leans on:
// pointing down from above a top's high, up from below a bottom's low — the direction the
// reversal argues for, red for a top (down) and green for a bottom (up). Two tiers: a
// full-size triangle with its `p` printed beside it where the server flagged a signal
// (P(holds) >= 0.5, off a full window), and a small faint one where p is at least LEAN_P —
// the model leaning without committing. Both carry the outcome as fill: solid once the
// extreme held, hollow once it failed, half-transparent while still in play. Anything
// below LEAN_P is not drawn at all.
//
// The lean tier exists because signals alone are invisible at chart scale: on EURUSD 1h
// there are 678 in sixteen years, one every ~155 bars, so a screen of 130 bars usually
// holds none and the template looked broken. At LEAN_P about 7% of candidates qualify —
// two or three per screen on 1h — which is enough to see the model working without
// burying the ones it singled out (about a third of all bars print a fresh extreme, so
// marking every candidate is not an option).
//
// The `p` label is drawn here rather than offered through `createTooltipDataSource`,
// because ChartPane.svelte's createIndicator wrapper replaces every template's tooltip
// source with its own icons-only one — a template's legends never reach the screen.
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

// The lower tier. Mirrors nothing on the server: a presentation choice, like the
// threshold lines AREV draws. 0.5 is the server's SIGNAL_P.
const LEAN_P = 0.35
const MIN_NEIGHBOURS = 50

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
  fill: 'solid' | 'hollow' | 'pending',
  alpha: number
): void {
  const dir = pointingDown ? 1 : -1
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x - size, y - dir * size * 1.4)
  ctx.lineTo(x + size, y - dir * size * 1.4)
  ctx.closePath()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = color
  if (fill !== 'hollow') {
    ctx.globalAlpha = alpha * (fill === 'pending' ? 0.45 : 1)
    ctx.fillStyle = color
    ctx.fill()
    ctx.globalAlpha = alpha
  }
  ctx.stroke()
  ctx.restore()
}

function label(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, above: boolean): void {
  ctx.save()
  ctx.font = '10px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = above ? 'bottom' : 'top'
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
  ctx.restore()
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
            if (!point || point.n < MIN_NEIGHBOURS || point.p < LEAN_P) continue
            const lean = !point.signal
            const fill = point.outcome === 'held' ? 'solid' : point.outcome === 'failed' ? 'hollow' : 'pending'
            const color = point.side === 'top' ? TOP_COLOR : BOTTOM_COLOR
            const top = point.side === 'top'
            const y = yAxis.convertToPixel(point.extreme) + (top ? -4 : 4)
            const s = lean ? size * 0.55 : size
            triangle(ctx, x, y, s, color, top, fill, lean ? 0.5 : 1)
            if (!lean) label(ctx, x, y + (top ? -s * 1.4 - 2 : s * 1.4 + 2), point.p.toFixed(2), color, top)
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
