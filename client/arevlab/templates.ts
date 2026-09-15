import { registerIndicator, type Indicator, type IndicatorFigure, type IndicatorTemplate, type KLineData } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import type { ArevGeneration, ArevPoint } from '../arev/api'
import { peekStore, type WindowStore } from '../plugins/store'
import type { RegistryStore } from '../tsregistry/store'
import { LAB_DEFAULTS, enabledGenerations, type LabConfig } from './config'
import { computeGeneration, figureKeys, labValues, sortedPoints, type GenerationResult, type LabMark, type LabValue } from './compute'
import type { LabBar } from './labels'

// ONE klinecharts template, in a sub-pane of its own, drawing the prediction line `p` of as
// many AREV generations as the pane's settings switch on -- each in its own colour, each with
// arrows from the rule its settings choose, and optionally that rule's lines.
//
// One template rather than one per generation for the same reason the AREV21 multi-timeframe
// overlay folded eight into one (client/mtf/templates.ts): klinecharts gives an indicator one
// settings entry point, which edits a flat numeric calcParams array, and a record of colours,
// enums and a dozen numbers per generation needs a panel of its own.
//
// Its figures are not declared here: which lines exist depends on the pane's settings, so the
// plugin sets them when it binds (`labFigures`), and a settings edit rebinds. klinecharts'
// override REPLACES figures (where it deep-merges styles and extendData), which is what makes
// that safe. Each figure styles itself from the live config in extendData rather than from the
// template's `styles`, because an array in `styles` is merged by index and the index of a
// generation's line moves as others are switched on and off.

export const LAB_TEMPLATE_NAME = 'LAB:arev'

export function isLabIndicator(name: string): boolean {
  return name === LAB_TEMPLATE_NAME
}

export interface ExtendData {
  /** Store key per source id: a generation's name, or BARS_SOURCE_ID. */
  seriesKeys: Record<string, string>
  rev: number
  config: LabConfig
}

/** The source id the bar store appears under in `seriesKeys`. */
export const BARS_SOURCE_ID = 'bars'

/** klinecharts types a figure's line style as `LineType[keyof LineType]`, which the string
 * union `LineType` cannot satisfy, so the two values are cast once here. */
const SOLID = 'solid' as never
const DASHED = 'dashed' as never

/** A rule line is its generation's colour, dimmed so p stays the line that is read. */
function dimmed(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}99` : color
}

/** The figures one config draws: each enabled generation's p, titled so the legend names it,
 * and -- where asked for -- its rule's two thresholds and centre, untitled and dashed. */
export function labFigures(config: LabConfig): IndicatorFigure<LabValue>[] {
  const figures: IndicatorFigure<LabValue>[] = []
  for (const generation of enabledGenerations(config)) {
    const keys = figureKeys(generation)
    figures.push({
      key: keys.p,
      title: `${generation}: `,
      type: 'line',
      styles: ({ indicator }) => {
        const g = (indicator.extendData as ExtendData | undefined)?.config?.generations[generation]
        return g ? { color: g.color, size: g.lineWidth, style: SOLID } : null
      }
    })
    const settings = config.generations[generation]
    if (!settings.lines || settings.signals === 'none') continue
    for (const [key, dashed] of [
      [keys.hi, [4, 3]],
      [keys.lo, [4, 3]],
      [keys.centre, [1, 3]]
    ] as const) {
      figures.push({
        key,
        type: 'line',
        styles: ({ indicator }) => {
          const g = (indicator.extendData as ExtendData | undefined)?.config?.generations[generation]
          return g ? { color: dimmed(g.color), size: 1, style: DASHED, dashedValue: [...dashed] } : null
        }
      })
    }
  }
  return figures
}

// calc is the expensive half -- a rolling quantile over every loaded sample -- and klinecharts
// asks for it whenever shouldUpdate says so, so one generation's result is kept while neither
// its store nor its settings nor the bars changed. Bounded crudely: an entry per lab on the
// wall per generation, and a wall that has churned through more than this simply recomputes.
const MEMO_LIMIT = 64
const memo = new Map<string, { stamp: string; result: GenerationResult }>()

function calc(dataList: KLineData[], indicator: Indicator<LabValue, number, ExtendData>): LabValue[] {
  const extend = indicator.extendData
  if (!extend?.config) return dataList.map(() => ({}))
  const barStore = peekStore<WindowStore<LabBar>>(extend.seriesKeys[BARS_SOURCE_ID])
  let bars: LabBar[] | null = null
  const results: Partial<Record<ArevGeneration, GenerationResult>> = {}
  for (const generation of enabledGenerations(extend.config)) {
    const key = extend.seriesKeys[generation]
    const store = peekStore<RegistryStore<ArevPoint>>(key)
    if (!store) continue
    const settings = extend.config.generations[generation]
    const usesBars = settings.signals === 'prior'
    const stamp = JSON.stringify([store.rev, settings, usesBars ? (barStore?.rev ?? -1) : null])
    const memoKey = `${indicator.id}|${generation}`
    const held = memo.get(memoKey)
    if (held?.stamp === stamp) {
      results[generation] = held.result
      continue
    }
    if (usesBars && bars === null) bars = barStore ? [...barStore.values.values()].sort((a, b) => a.date - b.date) : []
    const result = computeGeneration(generation, settings, sortedPoints(store.values.values()), bars ?? [])
    if (memo.size >= MEMO_LIMIT && !memo.has(memoKey)) memo.clear()
    memo.set(memoKey, { stamp, result })
    results[generation] = result
  }
  return labValues(
    dataList.map((d) => d.timestamp),
    extend.config,
    results
  )
}

function shouldUpdate(prev: Indicator<LabValue, number, ExtendData>, cur: Indicator<LabValue, number, ExtendData>) {
  const a = prev.extendData
  const b = cur.extendData
  const changed =
    a?.rev !== b?.rev ||
    JSON.stringify(a?.seriesKeys) !== JSON.stringify(b?.seriesKeys) ||
    JSON.stringify(a?.config) !== JSON.stringify(b?.config)
  return { calc: changed, draw: true }
}

function arrow(ctx: CanvasRenderingContext2D, x: number, tipY: number, size: number, color: string, up: boolean): void {
  // The tip is the anchor and the body hangs away from it -- an up arrow points up at p from
  // below, a down arrow down at it from above -- so the arrow never covers the line it marks.
  const dir = up ? 1 : -1
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

let registered = false

export function registerLabIndicator(): IndicatorGroup[] {
  if (!registered) {
    const template: IndicatorTemplate<LabValue, number, ExtendData> = {
      name: LAB_TEMPLATE_NAME,
      shortName: 'AREV lab',
      precision: 3,
      // Must stay empty: klinecharts prints calcParams into the legend, and these settings
      // are not numbers (config.ts).
      calcParams: [],
      shouldOhlc: false,
      shouldFormatBigNumber: false,
      visible: true,
      zLevel: 0,
      extendData: { seriesKeys: {}, rev: 0, config: LAB_DEFAULTS },
      series: 'normal',
      figures: labFigures(LAB_DEFAULTS),
      // The published thresholds, as the AREV panes pin them: klinecharts only WIDENS a range
      // by these, so a generation that strays further is still drawn whole.
      minValue: 0.425,
      maxValue: 0.575,
      styles: null,
      shouldUpdate,
      calc,
      regenerateFigures: null,
      createTooltipDataSource: null,
      draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
        const config = indicator.extendData?.config
        const hasFigures = indicator.figures.length > 0
        if (!config) return !hasFigures
        const range = chart.getVisibleRange()
        const last = Math.min(indicator.result.length - 1, range.realTo)
        for (let i = Math.max(0, range.realFrom); i <= last; i++) {
          const marks = indicator.result[i]?.__marks as LabMark[] | undefined
          if (!marks) continue
          const x = xAxis.convertToPixel(i)
          for (const mark of marks) {
            const settings = config.generations[mark.generation]
            if (!settings?.enabled) continue
            const y = yAxis.convertToPixel(mark.p)
            const gap = 2
            if (mark.side === 1) arrow(ctx, x, y + gap, settings.arrowSize, settings.color, true)
            else arrow(ctx, x, y - gap, settings.arrowSize, settings.color, false)
          }
        }
        // FALSE keeps the figures rendering: klinecharts assigns this to `isCover`.
        return !hasFigures
      }
    }
    registerIndicator(template)
    registered = true
  }
  return [
    {
      label: 'AREV lab',
      main: false,
      items: [
        {
          name: LAB_TEMPLATE_NAME,
          label: 'AREV lab',
          description:
            'The prediction line of any AREV generation, several at once in their own colours, with the published signals or an adaptive rule (rank, median, prior) and its levers per generation. On the gear.'
        }
      ]
    }
  ]
}
