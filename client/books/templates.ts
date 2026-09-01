import { registerIndicator, type Chart, type Indicator, type IndicatorTemplate, type KLineData } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import { peekStore, type WindowStore } from '../plugins/store'
import {
  DEFAULT_FLOW_RANGE_PCT,
  GRID_MS,
  intradayMs,
  type BookKind,
  type BookNearPoint,
  type BookProfilePoint,
  type BookTotalsPoint
} from './api'

// The BOOK templates: four ways of looking at OANDA's 20-minute order/position books.
//
//   BOOK:depth:<kind>      price pane — every snapshot drawn AS a book: a two-sided
//                          horizontal profile at its own instant, spanning the bars its
//                          20 minutes cover (100 candles on a 10m chart show 50 books).
//   BOOK:view:<kind>       sub-pane — the one book active at the hovered candle, drawn
//                          large: longs up, shorts down, a marker at the snapshot price.
//                          Follows the crosshair; shows the newest visible book when the
//                          pointer is elsewhere.
//   BOOK:sentiment:<kind>  sub-pane — percent of client positions (or orders) long,
//                          against the 50% line. The classic contrarian gauge on the
//                          position book.
//   BOOK:flow              sub-pane — the order book split at the snapshot price within
//                          ±N% (the calcParam): buy limits below / sell limits above
//                          (solid), buy stops above / sell stops below (dashed).
//
// Like every app-registered template, `calc` computes no model: it reads the points the
// plugin host fetched. The depth overlay places each snapshot ONCE, anchored to `ts` (the
// snapshot's own instant), never forward-filled; the sub-panes forward-fill, because
// "the book active at this bar" is a state, and the server deduplicates repeats.
//
// The depth and view templates declare no figures (the marker-template rule: a bucket's
// percent must not enter the price pane's y-axis) and their `draw` returns TRUE; the
// sentiment and flow panes declare lines and return FALSE (klinecharts renders declared
// figures only `if (!isCover)` — klinechartspro #6).

export const TEMPLATE_PREFIX = 'BOOK:'

export type BookDisplay = 'depth' | 'view' | 'sentiment' | 'flow'

const LONG = '#26A69A'
const SHORT = '#EF5350'
const LONG_FILL = 'rgba(38, 166, 154, 0.45)'
const SHORT_FILL = 'rgba(239, 83, 80, 0.45)'
const MUTED = '#787B86'
const MID_LINE = '#787B86'
const PCT_LINE = '#426EFF'

export function templateName(display: BookDisplay, kind?: BookKind): string {
  return display === 'flow' ? `${TEMPLATE_PREFIX}flow` : `${TEMPLATE_PREFIX}${display}:${kind}`
}

export function parseTemplateName(name: string): { display: BookDisplay; kind: BookKind } | null {
  if (!name.startsWith(TEMPLATE_PREFIX)) return null
  const rest = name.slice(TEMPLATE_PREFIX.length)
  if (rest === 'flow') return { display: 'flow', kind: 'order' }
  const [display, kind] = rest.split(':')
  if ((display === 'depth' || display === 'view' || display === 'sentiment') && (kind === 'order' || kind === 'position')) {
    return { display, kind }
  }
  return null
}

/** Crosshair position per chart, written by the view template's source subscription
 * (plugin.ts) and read by its `draw`: null means "not over a candle". */
export const hoverIndex = new WeakMap<object, number | null>()

export interface ExtendData {
  seriesKey: string
  rev: number
  /** The chart's own interval — half of the `ts`-to-x placement; klinecharts hands a
   * template bars and nothing about the period they were sampled at. */
  chartInterval: string
}

// -- sentiment --------------------------------------------------------------------------

export interface SentimentValue {
  pctLong?: number
  mid?: number
}

/** What one bar shows: the share of the book's counts that are long, in percent. */
export function sentimentValue(point: BookTotalsPoint | undefined): SentimentValue {
  if (!point) return {}
  const total = point.long + point.short
  if (!(total > 0)) return {}
  return { pctLong: (point.long / total) * 100, mid: 50 }
}

function sentimentCalc(dataList: KLineData[], indicator: Indicator<SentimentValue, number, ExtendData>): SentimentValue[] {
  const store = peekStore<WindowStore<BookTotalsPoint>>(indicator.extendData?.seriesKey)
  if (!store) return dataList.map(() => ({}))
  let last: BookTotalsPoint | undefined
  return dataList.map((d) => {
    const point = store.values.get(d.timestamp)
    if (point) last = point
    return sentimentValue(last)
  })
}

// -- flow -------------------------------------------------------------------------------

export interface FlowValue {
  limitBuy?: number
  limitSell?: number
  stopBuy?: number
  stopSell?: number
}

export function flowValue(point: BookNearPoint | undefined): FlowValue {
  if (!point) return {}
  return {
    limitBuy: point.longBelow,
    limitSell: point.shortAbove,
    stopBuy: point.longAbove,
    stopSell: point.shortBelow
  }
}

function flowCalc(dataList: KLineData[], indicator: Indicator<FlowValue, number, ExtendData>): FlowValue[] {
  const store = peekStore<WindowStore<BookNearPoint>>(indicator.extendData?.seriesKey)
  if (!store) return dataList.map(() => ({}))
  let last: BookNearPoint | undefined
  return dataList.map((d) => {
    const point = store.values.get(d.timestamp)
    if (point) last = point
    return flowValue(last)
  })
}

// -- profiles (depth overlay + hover view) ----------------------------------------------

export interface ProfileValue {
  snap?: BookProfilePoint
}

function profileCalc(forwardFill: boolean) {
  return (dataList: KLineData[], indicator: Indicator<ProfileValue, number, ExtendData>): ProfileValue[] => {
    const store = peekStore<WindowStore<BookProfilePoint>>(indicator.extendData?.seriesKey)
    if (!store) return dataList.map(() => ({}))
    let last: BookProfilePoint | undefined
    return dataList.map((d) => {
      const point = store.values.get(d.timestamp)
      if (point) last = point
      const snap = forwardFill ? last : point
      return snap ? { snap } : {}
    })
  }
}

function shouldUpdate<D>(prev: Indicator<D, number, ExtendData>, cur: Indicator<D, number, ExtendData>) {
  const a = prev.extendData
  const b = cur.extendData
  const dataChanged = a?.seriesKey !== b?.seriesKey || a?.rev !== b?.rev || a?.chartInterval !== b?.chartInterval
  return { calc: dataChanged, draw: true }
}

function formatTs(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')}Z`
}

/** The length scale for profile bars: the 95th percentile of the nonzero bucket values,
 * with bars clamped at full length above it. A book's mass sits in a handful of dominant
 * buckets (round numbers, catch-alls), and a linear scale off the raw maximum drew
 * everything else as a hairline. */
export function robustScale(values: number[]): number {
  const nonzero = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (nonzero.length === 0) return 0
  return nonzero[Math.min(nonzero.length - 1, Math.floor(nonzero.length * 0.95))]
}

/** Bar length as a fraction of the lane: square-root against the robust scale, clamped.
 * The square root keeps the long tail of small buckets visible beside the dominant ones
 * without letting an outlier flatten everything (linear did exactly that). */
export function barLength(value: number, scale: number): number {
  if (!(value > 0) || !(scale > 0)) return 0
  return Math.sqrt(Math.min(1, value / scale))
}

/** The depth overlay: each snapshot as a two-sided profile — shorts left of the slot's
 * midline, longs right — spanning the bars its 20 minutes cover, anchored at `ts`. */
function drawDepth({ ctx, chart, indicator, xAxis, yAxis }: {
  ctx: CanvasRenderingContext2D
  chart: Chart
  indicator: Indicator<ProfileValue, number, ExtendData>
  xAxis: { convertToPixel: (v: number) => number }
  yAxis: { convertToPixel: (v: number) => number }
}): boolean {
  const data = chart.getDataList()
  const range = chart.getVisibleRange()
  const barSpace = chart.getBarSpace().bar
  const ivMs = intradayMs(indicator.extendData?.chartInterval ?? '')
  const perSnapshot = ivMs !== null && ivMs < GRID_MS
  const slotPx = perSnapshot ? (GRID_MS / (ivMs as number)) * barSpace : barSpace
  const visible: Array<{ i: number; snap: BookProfilePoint }> = []
  const pcts: number[] = []
  for (let i = Math.max(0, range.realFrom); i <= Math.min(data.length - 1, range.realTo); i++) {
    const snap = indicator.result[i]?.snap
    if (!snap) continue
    visible.push({ i, snap })
    for (const [, l, s] of snap.buckets) {
      if (l > 0) pcts.push(l)
      if (s > 0) pcts.push(s)
    }
  }
  const scale = robustScale(pcts)
  if (!(scale > 0)) return true
  for (const { i, snap } of visible) {
    const bar = data[i]
    let left: number
    if (perSnapshot) {
      // Anchor at the snapshot's own instant: the point rides the bar it became
      // knowable on, which on a 1m chart is a few bars after the instant itself.
      const offsetBars = (snap.ts - bar.timestamp) / (ivMs as number)
      left = xAxis.convertToPixel(i) + (offsetBars - 0.5) * barSpace
    } else {
      left = xAxis.convertToPixel(i) - barSpace / 2
    }
    const half = Math.max(2, slotPx / 2 - 1)
    const mid = left + slotPx / 2
    for (const [p, l, s] of snap.buckets) {
      const yTop = yAxis.convertToPixel(p + snap.width)
      const yBot = yAxis.convertToPixel(p)
      const y = Math.min(yTop, yBot)
      const h = Math.max(1, Math.abs(yBot - yTop) - 0.5)
      // Linear length AND value-weighted opacity, deliberately not the square root the
      // viewer uses: across fifty stacked books the long tail must fade to a faint
      // texture so the concentrations read as liquidity walls through time.
      const lf = Math.min(1, l / scale)
      const sf = Math.min(1, s / scale)
      if (lf * half >= 0.75) {
        ctx.globalAlpha = 0.08 + 0.55 * lf * lf
        ctx.fillStyle = LONG
        ctx.fillRect(mid, y, lf * half, h)
      }
      if (sf * half >= 0.75) {
        ctx.globalAlpha = 0.08 + 0.55 * sf * sf
        ctx.fillStyle = SHORT
        const len = sf * half
        ctx.fillRect(mid - len, y, len, h)
      }
      ctx.globalAlpha = 1
    }
    if (snap.price > 0) {
      const yPrice = yAxis.convertToPixel(snap.price)
      ctx.strokeStyle = 'rgba(120, 123, 134, 0.9)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(left, yPrice)
      ctx.lineTo(left + slotPx - 1, yPrice)
      ctx.stroke()
    }
  }
  return true
}

/** The hover viewer: one book, large — longs up, shorts down, a dashed marker at the
 * snapshot price. Reads the crosshair from `hoverIndex`; without one it shows the newest
 * visible book, so the pane is never idle. */
function drawView(kind: BookKind) {
  return ({ ctx, chart, indicator, bounding }: {
    ctx: CanvasRenderingContext2D
    chart: Chart
    indicator: Indicator<ProfileValue, number, ExtendData>
    bounding: { width: number; height: number }
  }): boolean => {
    const data = chart.getDataList()
    const range = chart.getVisibleRange()
    const W = bounding.width
    const H = bounding.height
    const title = `${kind.toUpperCase()} BOOK`
    let idx = hoverIndex.get(chart)
    if (idx == null || idx < 0 || idx >= data.length) idx = Math.min(data.length - 1, range.realTo)
    const snap = idx >= 0 ? indicator.result[idx]?.snap : undefined
    ctx.save()
    ctx.font = '11px sans-serif'
    ctx.textBaseline = 'top'
    if (!snap) {
      ctx.fillStyle = MUTED
      ctx.fillText(`${title} · no snapshot here`, 8, 6)
      ctx.restore()
      return true
    }
    const buckets = snap.buckets
    const first = buckets[0]
    const last = buckets[buckets.length - 1]
    if (!first || !last) {
      ctx.restore()
      return true
    }
    const minP = first[0]
    const maxP = last[0] + snap.width
    const span = maxP - minP
    const padL = 8
    const padR = 8
    const top = 22
    const bottom = H - 16
    const midY = top + (bottom - top) / 2
    const pcts: number[] = []
    let maxPct = 0
    for (const [, l, s] of buckets) {
      if (l > 0) pcts.push(l)
      if (s > 0) pcts.push(s)
      maxPct = Math.max(maxPct, l, s)
    }
    const scale = robustScale(pcts)
    if (!(span > 0) || !(scale > 0)) {
      ctx.restore()
      return true
    }
    const plotW = W - padL - padR
    const colW = Math.max(1, (snap.width / span) * plotW - 0.5)
    const lane = midY - top - 1
    for (const [p, l, s] of buckets) {
      const x = padL + ((p - minP) / span) * plotW
      if (l > 0) {
        const h = Math.max(1, barLength(l, scale) * lane)
        ctx.fillStyle = LONG_FILL
        ctx.fillRect(x, midY - h, colW, h)
      }
      if (s > 0) {
        const h = Math.max(1, barLength(s, scale) * lane)
        ctx.fillStyle = SHORT_FILL
        ctx.fillRect(x, midY + 1, colW, h)
      }
    }
    ctx.strokeStyle = MUTED
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(padL, midY + 0.5)
    ctx.lineTo(padL + plotW, midY + 0.5)
    ctx.stroke()
    if (snap.price >= minP && snap.price <= maxP) {
      const xc = padL + ((snap.price - minP) / span) * plotW
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(xc, top)
      ctx.lineTo(xc, bottom)
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.fillStyle = MUTED
    ctx.fillText(`${title} · ${formatTs(snap.ts)} · ${snap.price || '—'} · peak ${maxPct.toFixed(2)}%`, 8, 6)
    ctx.textBaseline = 'bottom'
    ctx.textAlign = 'left'
    ctx.fillText(String(minP), padL, H - 2)
    ctx.textAlign = 'right'
    ctx.fillText(String(maxP.toFixed(5)), padL + plotW, H - 2)
    ctx.restore()
    return true
  }
}

let registered = false

// Registers every BOOK template once and returns the picker groups. Call only when the
// server advertises 'books'.
export function registerBooksIndicators(): IndicatorGroup[] {
  if (!registered) {
    for (const kind of ['order', 'position'] as const) {
      const depth: IndicatorTemplate<ProfileValue, number, ExtendData> = {
        name: templateName('depth', kind),
        shortName: `${kind.toUpperCase()} BOOK`,
        precision: 2,
        calcParams: [],
        shouldOhlc: false,
        shouldFormatBigNumber: false,
        visible: true,
        zLevel: 0,
        extendData: { seriesKey: '', rev: 0, chartInterval: '' },
        series: 'price',
        figures: [],
        minValue: null,
        maxValue: null,
        styles: null,
        shouldUpdate,
        calc: profileCalc(false),
        regenerateFigures: null,
        createTooltipDataSource: null,
        draw: drawDepth
      }
      registerIndicator(depth)
      const view: IndicatorTemplate<ProfileValue, number, ExtendData> = {
        name: templateName('view', kind),
        shortName: `${kind.toUpperCase()} BOOK VIEW`,
        precision: 2,
        calcParams: [],
        shouldOhlc: false,
        shouldFormatBigNumber: false,
        visible: true,
        zLevel: 0,
        extendData: { seriesKey: '', rev: 0, chartInterval: '' },
        series: 'normal',
        figures: [],
        // Pinned so the empty figure list cannot leave klinecharts' default [0, 10]
        // axis wandering; the pane is a free-form drawing.
        minValue: 0,
        maxValue: 1,
        styles: null,
        shouldUpdate,
        calc: profileCalc(true),
        regenerateFigures: null,
        createTooltipDataSource: null,
        draw: drawView(kind)
      }
      registerIndicator(view)
      const sentiment: IndicatorTemplate<SentimentValue, number, ExtendData> = {
        name: templateName('sentiment', kind),
        shortName: `${kind.toUpperCase()} LONG%`,
        precision: 1,
        calcParams: [],
        shouldOhlc: false,
        shouldFormatBigNumber: false,
        visible: true,
        zLevel: 0,
        extendData: { seriesKey: '', rev: 0, chartInterval: '' },
        series: 'normal',
        figures: [
          { key: 'pctLong', title: 'long%: ', type: 'line' },
          { key: 'mid', title: 'even: ', type: 'line' }
        ],
        // Never zoom inside 45..55: a 51% must not look decisive (the AREV pane's rule).
        minValue: 45,
        maxValue: 55,
        styles: {
          lines: [
            { color: PCT_LINE, size: 1, style: 'solid', smooth: false, dashedValue: [2, 2] },
            { color: MID_LINE, size: 1, style: 'dashed', smooth: false, dashedValue: [2, 2] }
          ]
        },
        shouldUpdate,
        calc: sentimentCalc,
        regenerateFigures: null,
        createTooltipDataSource: null,
        draw: null
      }
      registerIndicator(sentiment)
    }
    const flow: IndicatorTemplate<FlowValue, number, ExtendData> = {
      name: templateName('flow'),
      shortName: 'BOOK FLOW',
      precision: 2,
      // The near-range, percent of the snapshot price either side.
      calcParams: [DEFAULT_FLOW_RANGE_PCT],
      shouldOhlc: false,
      shouldFormatBigNumber: false,
      visible: true,
      zLevel: 0,
      extendData: { seriesKey: '', rev: 0, chartInterval: '' },
      series: 'normal',
      figures: [
        { key: 'limitBuy', title: 'buy limits: ', type: 'line' },
        { key: 'limitSell', title: 'sell limits: ', type: 'line' },
        { key: 'stopBuy', title: 'buy stops: ', type: 'line' },
        { key: 'stopSell', title: 'sell stops: ', type: 'line' }
      ],
      minValue: 0,
      maxValue: null,
      styles: {
        lines: [
          { color: LONG, size: 1, style: 'solid', smooth: false, dashedValue: [2, 2] },
          { color: SHORT, size: 1, style: 'solid', smooth: false, dashedValue: [2, 2] },
          { color: LONG, size: 1, style: 'dashed', smooth: false, dashedValue: [2, 2] },
          { color: SHORT, size: 1, style: 'dashed', smooth: false, dashedValue: [2, 2] }
        ]
      },
      shouldUpdate,
      calc: flowCalc,
      regenerateFigures: null,
      createTooltipDataSource: null,
      draw: null
    }
    registerIndicator(flow)
    registered = true
  }
  return [
    {
      label: 'OANDA books · price pane',
      main: true,
      items: [
        {
          name: templateName('depth', 'order'),
          label: 'Order book depth',
          description: 'Every 20-minute order book drawn at its own instant: sell orders left, buy orders right, a tick at the snapshot price.'
        },
        {
          name: templateName('depth', 'position'),
          label: 'Position book depth',
          description: 'Every 20-minute position book drawn at its own instant: shorts left, longs right.'
        }
      ]
    },
    {
      label: 'OANDA books',
      main: false,
      items: [
        {
          name: templateName('view', 'order'),
          label: 'Order book (hover)',
          description: 'The order book active at the hovered candle, drawn large: buys up, sells down, dashed line at the snapshot price.'
        },
        {
          name: templateName('view', 'position'),
          label: 'Position book (hover)',
          description: 'The position book active at the hovered candle: longs up, shorts down.'
        },
        {
          name: templateName('sentiment', 'position'),
          label: 'Position sentiment',
          description: 'Percent of open client positions that are long, against the 50% line.'
        },
        {
          name: templateName('sentiment', 'order'),
          label: 'Order sentiment',
          description: 'Percent of resting client orders that are long, against the 50% line.'
        },
        {
          name: templateName('flow'),
          label: 'Order flow near price',
          description: 'Resting orders within ±N% of price (the parameter), split at it: buy/sell limits solid, buy/sell stops dashed.'
        }
      ]
    }
  ]
}
