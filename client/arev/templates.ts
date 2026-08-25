import { registerIndicator, type Indicator, type IndicatorTemplate, type KLineData } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import { downArrow, upArrow } from '../plugins/draw'
import { AREV_GENERATIONS, type ArevGeneration, type ArevPoint, type ArevSignal, arevSignal } from './api'
import { peekStore, type WindowStore } from '../plugins/store'

// One klinecharts indicator template per AREV model generation, drawn in its own sub-pane.
// Like the `S:` server-indicator templates (indicators/templates.ts), `calc` computes
// nothing: it reads the points the controller fetched from `/arev/values`.
//
// What the pane draws is the probability the k-NN vote implies — the share of comparable
// past samples that rose, which is P(the generation's own question: price up to the next
// sample for arev19/20/21, body midpoint higher 10 bars on for arev22) — against a flat
// threshold either side of a coin flip, plus an arrow on every bar the server LABELS:
// a green up arrow under a `long` point, a red down arrow over a `short` one. The label
// is the server's published signal (`ArevPoint.signal`, read through `arevSignal`) —
// confident, on a sample bar, off a full window — and it is the same event the AREV21
// MTF overlay draws and a replay's "next signal" jumps to, so the three agree. The pane
// used to compute its own arrows from consecutive points (a crossing of P(up) out of the
// band, coloured as a fade) and drew a nearly disjoint set in the opposite direction; the
// research measured the server's definition (60.4% with p > 0.5 → price rises), so that
// is the one arrow. It used to draw the raw vote sum with its running
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

// What distinguishes the generations, for the picker. arev19 and arev20 are the same
// model built two ways; arev21 is the same model asked of different bars and arev22 the
// same model asked a different question, which is why drawing either beside arev19 is
// the point of having it.
const DESCRIPTIONS: Record<ArevGeneration, string> = {
  arev19: 'k-NN reversal prediction, single-pass generation (store-and-predict together)',
  arev20: 'k-NN reversal prediction, split train/predict generation',
  arev21: 'arev19 sampled at fresh price extremes instead of WMA crosses',
  arev22: 'arev19 labelled by the body midpoint 10 bars ahead, sampled on a fixed stride'
}

// Mirrors wdashboard-server's arev.SIGNAL_CONFIDENCE. Both drawn and applied here: the
// two threshold lines sit at 0.5 +/- this, and the arrows mark where P(up) crosses them.
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
  /** Not a figure — read by `draw` to place the arrow: the server's label on this bar. */
  mark?: ArevSignal
}

/** The values one bar contributes: the lines, and the published label as the mark. */
export function barValue(point: ArevPoint | undefined): Value {
  if (!point) return {}
  const value: Value = { p: point.p, upper: COIN_FLIP + SIGNAL_CONFIDENCE, lower: COIN_FLIP - SIGNAL_CONFIDENCE, mid: COIN_FLIP }
  const mark = arevSignal(point)
  if (mark) value.mark = mark
  return value
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

function calc(dataList: KLineData[], indicator: Indicator<Value, number, ExtendData>): Value[] {
  const key = indicator.extendData?.seriesKey
  const store = peekStore<WindowStore<ArevPoint>>(key)
  if (!store) return dataList.map(() => ({}))
  // The thresholds are flat by construction: the same two numbers on the first bar of
  // the series and on the two hundred thousandth, which is the whole point. A bar with no
  // prediction (warm-up, abstention, outside the fetched range) breaks the line.
  return dataList.map((d) => barValue(store.values.get(d.timestamp)))
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
        // Draws the server's labels: `long` is a green up arrow under the point, `short`
        // a red down arrow over it -- the arrow's colour and direction are the side the
        // label argues for.
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
            const value = indicator.result[i]
            if (value == null) continue
            if (value.mark == null || value.p == null) continue
            const x = xAxis.convertToPixel(i)
            if (value.mark === 'long') upArrow(ctx, x, yAxis.convertToPixel(value.p) + 4, size, '#26A69A')
            else downArrow(ctx, x, yAxis.convertToPixel(value.p) - 4, size, '#EF5350')
          }
          return false
        }
      }
      registerIndicator(template)
    }
    group.items.push({
      name,
      label: generation.toUpperCase(),
      description: DESCRIPTIONS[generation]
    })
  }
  registered = true
  return [group]
}
