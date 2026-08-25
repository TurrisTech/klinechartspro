import { registerIndicator, type Indicator, type IndicatorTemplate, type KLineData } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import { KREV_GENERATION, type KrevPoint, type KrevSide, krevSignal } from './api'

/** A bar's votes by side: a top and a bottom candidate can print on the same bar. */
export type BarPoints = Partial<Record<KrevSide, KrevPoint>>
import { peekStore, type WindowStore } from '../plugins/store'

// One klinecharts indicator template: krev01's votes as a SUB-PANE series. Like the AREV
// templates, `calc` computes nothing — it reads the points the controller fetched from
// `/krev/values`.
//
// There used to be a second template on the PRICE pane, drawing a triangle at every
// extreme the model leaned on. It is gone: two templates for one model meant two picker
// entries, two bindings and two ways to read the same numbers, and the price pane could
// only ever show WHERE a vote was, never the vote itself. What that template said and the
// pane could not — which votes the server flagged, and how each one turned out — is drawn
// here instead, so the whole indicator is one pane.
//
// What the pane draws. A vote exists only on a candidate bar — about a third of them — so
// a plain line of `p` would be mostly gaps. Each side's LATEST vote is carried forward
// instead (two step-lines: the model's current lean on tops, and on bottoms), against the
// two flat references SIGNAL_P and LEAN_P. Tops and bottoms are separate series for the
// same reason AREV19 and AREV20 are separate panes — seeing them side by side is the
// point.
//
// On top of those lines, `draw` marks the bar each vote was actually cast on, in the
// vocabulary the price-pane template used:
//
//   * shape  — a triangle where the server flagged a signal (p >= SIGNAL_P off a full
//              window), pointing the way the reversal argues (down for a top, up for a
//              bottom) and carrying its `p` as a label; a dot otherwise, full-size at or
//              above LEAN_P (the model leaning without committing) and small and faint
//              below it.
//   * colour — red for a top, green for a bottom, as the two step-lines are.
//   * fill   — solid once the extreme held, hollow once it failed, half-transparent while
//              the candidate is still in play.
//
// Those marks are drawn rather than declared as `circle` figures because a figure's style
// is per-figure, not per-point, and the outcome is exactly a per-point thing. `draw`
// therefore returns FALSE: the four declared lines still have to render, and klinecharts
// renders an indicator's figures only `if (!isCover)`, where `isCover` is what `draw`
// returned (klinechartspro #6 — the AREV panes drew their markers and none of their lines
// for exactly this reason).
//
// The `p` label is drawn here rather than offered through `createTooltipDataSource`,
// because ChartPane.svelte's createIndicator wrapper replaces every template's tooltip
// source with its own icons-only one — a template's own legends never reach the screen.
// The legend a viewer does see is the one klinecharts builds from the declared figures,
// which on a vote bar carries that vote's `p` as the carried-forward line's value.

export const TEMPLATE_NAME = `KREV:${KREV_GENERATION}:p`

export interface ExtendData {
  seriesKey: string
  rev: number
}

const TOP_COLOR = '#EF5350'
const BOTTOM_COLOR = '#26A69A'

// The lower tier. Mirrors nothing on the server: a presentation choice, like the
// threshold lines AREV draws. 0.5 is the server's SIGNAL_P.
const LEAN_P = 0.35
const MIN_NEIGHBOURS = 50

// Mirrors wdashboard-server's krev.SIGNAL_P.
const SIGNAL_P = 0.5

export function isKrevIndicator(name: string): boolean {
  return name === TEMPLATE_NAME
}

export interface Value {
  top?: number
  bottom?: number
  signal?: number
  lean?: number
  /** This bar's votes, for `draw`. Deliberately not a figure: it is not a number, and
   * only figure keys widen the pane's y-axis range. */
  points?: BarPoints
}

const LINES: Array<{ key: keyof Value; title: string; color: string; dashed?: boolean }> = [
  { key: 'top', title: 'top p: ', color: '#EF535099' },
  { key: 'bottom', title: 'bottom p: ', color: '#26A69A99' },
  { key: 'signal', title: 'signal: ', color: '#787B86', dashed: true },
  { key: 'lean', title: 'lean: ', color: '#787B86', dashed: true }
]

function calc(dataList: KLineData[], indicator: Indicator<Value, number, ExtendData>): Value[] {
  const key = indicator.extendData?.seriesKey
  const store = peekStore<WindowStore<KrevPoint, BarPoints>>(key)
  if (!store) return dataList.map(() => ({}))
  let top: number | undefined
  let bottom: number | undefined
  return dataList.map((d) => {
    const bar = store.values.get(d.timestamp)
    const value: Value = { signal: SIGNAL_P, lean: LEAN_P }
    if (bar?.top && bar.top.n >= MIN_NEIGHBOURS) top = bar.top.p
    if (bar?.bottom && bar.bottom.n >= MIN_NEIGHBOURS) bottom = bar.bottom.p
    if (bar) value.points = bar
    if (top != null) value.top = top
    if (bottom != null) value.bottom = bottom
    return value
  })
}

function shouldUpdate(prev: Indicator<Value, number, ExtendData>, cur: Indicator<Value, number, ExtendData>) {
  const dataChanged =
    prev.extendData?.seriesKey !== cur.extendData?.seriesKey || prev.extendData?.rev !== cur.extendData?.rev
  return { calc: dataChanged, draw: true }
}

type Fill = 'solid' | 'hollow' | 'pending'

function fillOf(point: KrevPoint): Fill {
  return point.outcome === 'held' ? 'solid' : point.outcome === 'failed' ? 'hollow' : 'pending'
}

function paint(ctx: CanvasRenderingContext2D, color: string, fill: Fill, alpha: number): void {
  ctx.lineWidth = 1.5
  ctx.strokeStyle = color
  if (fill !== 'hollow') {
    ctx.globalAlpha = alpha * (fill === 'pending' ? 0.45 : 1)
    ctx.fillStyle = color
    ctx.fill()
    ctx.globalAlpha = alpha
  }
  ctx.stroke()
}

function triangle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  pointingDown: boolean,
  fill: Fill,
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
  paint(ctx, color, fill, alpha)
  ctx.restore()
}

function dot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  fill: Fill,
  alpha: number
): void {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  paint(ctx, color, fill, alpha)
  ctx.restore()
}

// Beside the marker, not above it: `p` is what the pane's y-axis already measures, so a
// signal sits near the top of a pane whose axis stops at SIGNAL_P, where a label above
// would land in the legend row. To the right it stays clear of both the legend and the
// marker's own body, and signals are rare enough (one per ~155 bars on EURUSD 1h) that two
// labels never crowd each other.
function label(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string): void {
  ctx.save()
  ctx.font = '10px sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
  ctx.restore()
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
      series: 'normal',
      figures: LINES.map((f) => ({ key: f.key, title: f.title, type: 'line' })),
      // Never zoom inside the two reference lines; p rarely exceeds 0.6, so the axis
      // widens past 0.5 only when a vote actually does.
      minValue: 0,
      maxValue: SIGNAL_P,
      styles: {
        lines: LINES.map((f) => ({
          color: f.color,
          size: 1,
          style: f.dashed ? 'dashed' : 'solid',
          smooth: false,
          dashedValue: [2, 2]
        }))
      },
      shouldUpdate,
      calc,
      regenerateFigures: null,
      createTooltipDataSource: null,
      draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
        const data = chart.getDataList()
        const range = chart.getVisibleRange()
        const size = Math.max(4, Math.min(9, chart.getBarSpace().bar * 0.45))
        for (let i = Math.max(0, range.realFrom); i <= Math.min(data.length - 1, range.realTo); i++) {
          const bar = indicator.result[i]?.points
          if (bar == null) continue
          const x = xAxis.convertToPixel(i)
          for (const point of [bar.top, bar.bottom]) {
            if (!point || point.n < MIN_NEIGHBOURS) continue
            const top = point.side === 'top'
            const color = top ? TOP_COLOR : BOTTOM_COLOR
            const y = yAxis.convertToPixel(point.p)
            const fill = fillOf(point)
            if (krevSignal(point)) {
              triangle(ctx, x, y, size, color, top, fill, 1)
              label(ctx, x + size + 3, y, point.p.toFixed(2), color)
            } else {
              const lean = point.p >= LEAN_P
              dot(ctx, x, y, lean ? size * 0.4 : size * 0.28, color, fill, lean ? 0.9 : 0.5)
            }
          }
        }
        // The four declared lines must still render -- see the note at the top.
        return false
      }
    }
    registerIndicator(template)
    registered = true
  }
  return [
    {
      label: 'KREV research',
      main: false,
      items: [
        {
          name: TEMPLATE_NAME,
          label: KREV_GENERATION.toUpperCase(),
          description:
            'k-NN reversal: P(this fresh extreme holds) per side, latest vote carried forward, a mark per vote with its outcome'
        }
      ]
    }
  ]
}
