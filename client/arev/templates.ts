import { registerIndicator, type Indicator, type IndicatorTemplate, type KLineData } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import { AREV_GENERATIONS, type ArevGeneration } from './api'
import { peekStore } from './store'

// One klinecharts indicator template per AREV model generation, drawn in its own sub-pane.
// Like the `S:` server-indicator templates (indicators/templates.ts), `calc` computes
// nothing: it reads the points the controller fetched from `/arev/values`.
//
// What the pane draws is the probability the k-NN vote implies — the share of comparable
// past legs that rose — against a flat threshold either side of a coin flip, plus an arrow
// on every bar the server flagged. It used to draw the raw vote sum with its running
// extrema and the 0.9x bands derived from them, and the reason it no longer does is that
// those bands could not work: an all-time extremum is an order statistic, so it ratchets
// out of reach while the series it gates stays exactly as wide. On EURUSD 1h the running
// maximum reached 88 in 2020 and never moved again, and the bands produced 123 signals in
// 2010, one in 2023 and none in 2024 or 2025. A probability needs no such reference, which
// is why the thresholds here are horizontal lines and stay where they are.
//
// There are no calcParams: the generation's k and momentum window are baked into the
// hand-run generation scripts, so a template names a generation, not a parameterisation.

export const TEMPLATE_PREFIX = 'AREV:'

// Mirrors wdashboard-server's arev.SIGNAL_CONFIDENCE. Drawn, not applied: whether a point
// is a signal is the server's call (`point.signal`), and this is only where the line goes.
const SIGNAL_CONFIDENCE = 0.075

const COIN_FLIP = 0.5

export interface ExtendData {
  seriesKey: string
  rev: number
}

export interface Value {
  p?: number
  upper?: number
  lower?: number
  mid?: number
  /** Not a figure — read by `draw` to place the arrows. */
  signal?: number
}

export function templateName(generation: ArevGeneration): string {
  return `${TEMPLATE_PREFIX}${generation}`
}

export function isArevIndicator(name: string): boolean {
  return name.startsWith(TEMPLATE_PREFIX)
}

export function parseTemplateName(name: string): ArevGeneration | null {
  if (!isArevIndicator(name)) return null
  const rest = name.slice(TEMPLATE_PREFIX.length)
  return (AREV_GENERATIONS as readonly string[]).includes(rest) ? (rest as ArevGeneration) : null
}

// Figure order and the styles.lines order below must agree: klinecharts pairs them by index.
const FIGURES: Array<{ key: keyof Value; title: string; color: string; dashed?: boolean }> = [
  { key: 'p', title: 'P(up): ', color: '#426EFF' },
  { key: 'upper', title: 'long: ', color: '#26A69A', dashed: true },
  { key: 'lower', title: 'short: ', color: '#EF5350', dashed: true },
  { key: 'mid', title: 'even: ', color: '#787B86', dashed: true }
]

function upArrow(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x - size, y + size * 1.4)
  ctx.lineTo(x + size, y + size * 1.4)
  ctx.closePath()
  ctx.fill()
}

function downArrow(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x - size, y - size * 1.4)
  ctx.lineTo(x + size, y - size * 1.4)
  ctx.closePath()
  ctx.fill()
}

function calc(dataList: KLineData[], indicator: Indicator<Value, number, ExtendData>): Value[] {
  const key = indicator.extendData?.seriesKey
  const store = key ? peekStore(key) : undefined
  if (!store) return dataList.map(() => ({}))
  return dataList.map((d) => {
    const point = store.values.get(d.timestamp)
    if (!point) return {}
    return {
      p: point.p,
      // Flat by construction. They are the same two numbers on the first bar of the
      // series and on the two hundred thousandth, which is the whole point.
      upper: COIN_FLIP + SIGNAL_CONFIDENCE,
      lower: COIN_FLIP - SIGNAL_CONFIDENCE,
      mid: COIN_FLIP,
      signal: point.signal ? point.p : undefined
    }
  })
}

function shouldUpdate(prev: Indicator<Value, number, ExtendData>, cur: Indicator<Value, number, ExtendData>) {
  const dataChanged =
    prev.extendData?.seriesKey !== cur.extendData?.seriesKey || prev.extendData?.rev !== cur.extendData?.rev
  return { calc: dataChanged, draw: true }
}

let registered = false

// Registers both generation templates once and returns the picker group for
// ChartProOptions.indicatorGroups. Call only when the server advertises 'arev'.
export function registerArevIndicators(): IndicatorGroup[] {
  const group: IndicatorGroup = { label: 'AREV research', main: false, items: [] }
  for (const generation of AREV_GENERATIONS) {
    const name = templateName(generation)
    if (!registered) {
      const template: IndicatorTemplate<Value, number, ExtendData> = {
        name,
        shortName: generation.toUpperCase(),
        // A probability, not a vote count: three decimals, where the raw sum wanted one.
        precision: 3,
        calcParams: [],
        shouldOhlc: false,
        shouldFormatBigNumber: false,
        visible: true,
        zLevel: 0,
        extendData: { seriesKey: '', rev: 0 },
        series: 'normal',
        figures: FIGURES.map((f) => ({ key: f.key, title: f.title, type: 'line' })),
        // Deliberately NOT pinned to [0, 1]. It was, so that the pane could not rescale to
        // whatever the visible window held and make a 0.52 look decisive -- but a vote over
        // 200 neighbours lives in a narrow band around a coin flip (EURUSD 1h: 99% of bars
        // between 0.325 and 0.670, sd 0.084), so a pinned unit axis spent two thirds of the
        // pane on empty space and drew the series as a flat line through the middle.
        //
        // The thresholds do that job better and cost nothing: klinecharts takes the y-range
        // as the min/max over every figure of the visible range, then WIDENS it by
        // minValue/maxValue -- it never narrows. Pinning them to the signal band therefore
        // says only "never zoom inside the two lines the reader judges against", so a 0.52
        // is always drawn as less than a third of the way to the long line and the window
        // that would have made it look decisive cannot be reached. It is also what the pane
        // falls back to when the visible range holds no predictions at all (`calc` returns
        // an empty value there, thresholds included), instead of klinecharts' own [0, 10].
        minValue: COIN_FLIP - SIGNAL_CONFIDENCE,
        maxValue: COIN_FLIP + SIGNAL_CONFIDENCE,
        styles: {
          lines: FIGURES.map((f) => ({
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
        // The server decides what a signal is; this only marks where they landed. They
        // sit on cross bars, which is the only kind of bar the model is fitted on.
        //
        // Returns FALSE, and that is load-bearing: klinecharts assigns this callback's
        // return to `isCover` and then renders the declared figures only `if (!isCover)`.
        // Returning true means "I have covered the drawing myself" and silently skips
        // every line in FIGURES -- which is what happened here: the arrows appeared and
        // P(up), the thresholds and the mid line did not. The marker templates in
        // client/indicators/templates.ts do return true, correctly, because they declare
        // `figures: []` and have nothing to suppress. This pane has four figures, so it
        // wants the default rendering *and* these arrows. Cost of the mix-up: the arrows
        // paint before the lines, so a line crosses over an arrow rather than under it.
        draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
          const data = chart.getDataList()
          const range = chart.getVisibleRange()
          const size = Math.max(3, Math.min(7, chart.getBarSpace().bar * 0.4))
          for (let i = Math.max(0, range.realFrom); i <= Math.min(data.length - 1, range.realTo); i++) {
            const p = indicator.result[i]?.signal
            if (p == null) continue
            const x = xAxis.convertToPixel(i)
            const y = yAxis.convertToPixel(p)
            if (p > COIN_FLIP) upArrow(ctx, x, y + 4, size, '#26A69A')
            else downArrow(ctx, x, y - 4, size, '#EF5350')
          }
          return false
        }
      }
      registerIndicator(template)
    }
    group.items.push({
      name,
      label: generation.toUpperCase(),
      description:
        generation === 'arev19'
          ? 'k-NN reversal prediction, single-pass generation (store-and-predict together)'
          : 'k-NN reversal prediction, split train/predict generation'
    })
  }
  registered = true
  return [group]
}
