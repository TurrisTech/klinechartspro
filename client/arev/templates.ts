import { registerIndicator, type Indicator, type IndicatorTemplate, type KLineData } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import { AREV_GENERATIONS, type ArevGeneration } from './api'
import { peekStore } from './store'

// One klinecharts indicator template per AREV model generation, drawn in its own sub-pane.
// Like the `S:` server-indicator templates (indicators/templates.ts), `calc` computes
// nothing: it reads the points the controller fetched from `/arev/values`. Unlike them, a
// template carries five figures — the k-NN prediction, its running extrema, and the 0.9x
// overbought/oversold bands the pine script draws (`arev30.pine`: prediction in blue, the
// extrema channel in gray, the thresholds in red/lime; `bin/arev19_chart.py` charts the
// same trio of prediction/max90/min90). The bands are derived here from max/min — the
// server serves what the model computed, not presentation.
//
// There are no calcParams: the generation's k and momentum window are baked into the
// hand-run generation scripts, so a template names a generation, not a parameterisation.

export const TEMPLATE_PREFIX = 'AREV:'

export interface ExtendData {
  seriesKey: string
  rev: number
}

export interface Value {
  prediction?: number
  max?: number
  min?: number
  max90?: number
  min90?: number
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
const FIGURES: Array<{ key: keyof Value; title: string; color: string }> = [
  { key: 'prediction', title: 'prediction: ', color: '#426EFF' },
  { key: 'max90', title: 'max90: ', color: '#EF5350' },
  { key: 'min90', title: 'min90: ', color: '#26A69A' },
  { key: 'max', title: 'max: ', color: '#787B86' },
  { key: 'min', title: 'min: ', color: '#787B86' }
]

function calc(dataList: KLineData[], indicator: Indicator<Value, number, ExtendData>): Value[] {
  const key = indicator.extendData?.seriesKey
  const store = key ? peekStore(key) : undefined
  if (!store) return dataList.map(() => ({}))
  return dataList.map((d) => {
    const p = store.values.get(d.timestamp)
    if (!p) return {}
    return {
      prediction: p.prediction,
      max: p.max,
      min: p.min,
      max90: p.max * 0.9,
      min90: p.min * 0.9
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
        precision: 1,
        calcParams: [],
        shouldOhlc: false,
        shouldFormatBigNumber: false,
        visible: true,
        zLevel: 0,
        extendData: { seriesKey: '', rev: 0 },
        series: 'normal',
        figures: FIGURES.map((f) => ({ key: f.key, title: f.title, type: 'line' })),
        minValue: null,
        maxValue: null,
        styles: {
          lines: FIGURES.map((f) => ({
            color: f.color,
            size: 1,
            style: 'solid',
            smooth: false,
            dashedValue: [2, 2]
          }))
        },
        shouldUpdate,
        calc,
        regenerateFigures: null,
        createTooltipDataSource: null,
        draw: null
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
