import { registerIndicator, type Indicator, type IndicatorTemplate, type KLineData } from 'klinecharts'
import { registerIndicatorSettings, type IndicatorGroup } from '../../src'
import { resolveSeries, type IndicatorSpec, type SeriesDoc } from './api'
import { hasFeature } from '../capabilities'
import { symbolVendor } from '../symbols'
import type { SymbolInfo } from '../../src'
import { peekStore } from './store'

// One klinecharts indicator template per library indicator (per version): the chart draws
// it exactly like a built-in, but its `calc` reads values the controller (controller.ts)
// fetched from the server or received live, instead of computing anything -- the client
// never computes, never buckets, and never knows whether the series was ephemeral or
// persisted. Template names are `S:<name>@<version>` so several versions of one indicator
// coexist in the picker and in a persisted layout, and are addressed independently.

export const TEMPLATE_PREFIX = 'S:'

export interface ExtendData {
  seriesKey: string
  rev: number
}

export interface Value {
  value?: number
}

// The klinecharts settings dialog edits a flat numeric `calcParams` array. A template
// exposes its spec's scalar params in order, plus -- for a composed default input that is a
// single-`window` node (the cross's two SMAs) -- that window, so the common case ("cross of
// SMA 10 / SMA 20") is a two-number edit; anything richer is declared in the config UI.
export interface TemplateParam {
  label: string
  kind: 'param' | 'input-window'
  name: string // param name, or input index as a string
  default: number
  min: number
  isInt: boolean
}

export function templateName(spec: Pick<IndicatorSpec, 'name' | 'version'>): string {
  return `${TEMPLATE_PREFIX}${spec.name}@${spec.version}`
}

export function isServerIndicator(name: string): boolean {
  return name.startsWith(TEMPLATE_PREFIX)
}

export function parseTemplateName(name: string): { name: string; version: string } | null {
  if (!isServerIndicator(name)) return null
  const rest = name.slice(TEMPLATE_PREFIX.length)
  const at = rest.lastIndexOf('@')
  if (at < 0) return { name: rest, version: '' }
  return { name: rest.slice(0, at), version: rest.slice(at + 1) }
}

export function templateParams(spec: IndicatorSpec): TemplateParam[] {
  const out: TemplateParam[] = spec.params.map((p) => ({
    label: p.name.replace(/_/g, ' '),
    kind: 'param',
    name: p.name,
    default: p.default,
    min: p.min ?? 1,
    isInt: p.type === 'int'
  }))
  spec.defaultInputs.forEach((input, i) => {
    const params = (input as { params?: Record<string, number> }).params
    if (input && typeof input === 'object' && 'name' in input && params && typeof params.window === 'number') {
      const label = spec.inputLabels[i] ?? `input ${i + 1}`
      out.push({
        label: `${label} (${String((input as { name: string }).name)}) window`,
        kind: 'input-window',
        name: String(i),
        default: params.window,
        min: 1,
        isInt: true
      })
    }
  })
  return out
}

export function defaultCalcParams(spec: IndicatorSpec): number[] {
  return templateParams(spec).map((p) => p.default)
}

// The node document the server resolves for this template + calcParams.
export function seriesDocFor(spec: IndicatorSpec, calcParams: unknown[]): SeriesDoc {
  const tp = templateParams(spec)
  const params: Record<string, number> = {}
  const inputs = spec.defaultInputs.map((i) => JSON.parse(JSON.stringify(i)) as Record<string, unknown>)
  tp.forEach((p, i) => {
    const raw = calcParams[i]
    const num = typeof raw === 'number' && Number.isFinite(raw) ? raw : p.default
    const value = p.isInt ? Math.round(num) : num
    if (p.kind === 'param') params[p.name] = value
    else {
      const input = inputs[Number(p.name)] as { params?: Record<string, number> }
      input.params = { ...(input.params ?? {}), window: value }
    }
  })
  return { name: spec.name, version: spec.version, params, inputs }
}

export function paramsText(spec: IndicatorSpec, calcParams: unknown[]): string {
  const tp = templateParams(spec)
  return tp.map((p, i) => String(calcParams[i] ?? p.default)).join(', ')
}

export const LINE_COLORS = ['#FF9600', '#9D65C9', '#2196F3', '#E11D74', '#26A69A', '#FFEB3B', '#8D6E63']

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
    const v = store.values.get(d.timestamp)
    return v == null ? {} : { value: v }
  })
}

function shouldUpdate(prev: Indicator<Value, number, ExtendData>, cur: Indicator<Value, number, ExtendData>) {
  const paramsChanged = JSON.stringify(prev.calcParams) !== JSON.stringify(cur.calcParams)
  const dataChanged = prev.extendData?.seriesKey !== cur.extendData?.seriesKey || prev.extendData?.rev !== cur.extendData?.rev
  return { calc: paramsChanged || dataChanged, draw: true }
}

const registeredNames = new Set<string>()

// Registers every spec once and returns the picker groups for ChartProOptions.indicatorGroups.
export function registerServerIndicators(specs: IndicatorSpec[]): IndicatorGroup[] {
  const main: IndicatorGroup = { label: 'Server · price pane', main: true, items: [] }
  const sub: IndicatorGroup = { label: 'Server · sub-pane', main: false, items: [] }
  specs.forEach((spec, index) => {
    const name = templateName(spec)
    const isMarker = spec.render === 'marker'
    const color = LINE_COLORS[index % LINE_COLORS.length]
    if (!registeredNames.has(name)) {
      const template: IndicatorTemplate<Value, number, ExtendData> = {
        name,
        shortName: spec.title,
        precision: spec.pane === 'main' ? 5 : 2,
        calcParams: defaultCalcParams(spec),
        shouldOhlc: false,
        shouldFormatBigNumber: false,
        visible: true,
        zLevel: 0,
        extendData: { seriesKey: '', rev: 0 },
        series: spec.pane === 'main' ? 'price' : 'normal',
        // A marker indicator declares no figures: its -1/0/+1 values must not enter the price
        // pane's y-axis range (they would flatten the candles); `draw` paints them itself.
        figures: isMarker ? [] : [{ key: 'value', title: `${spec.title}: `, type: 'line' }],
        minValue: spec.valueRange && !isMarker ? spec.valueRange[0] : null,
        maxValue: spec.valueRange && !isMarker ? spec.valueRange[1] : null,
        styles: isMarker ? null : { lines: [{ color, size: 1, style: 'solid', smooth: false, dashedValue: [2, 2] }] },
        shouldUpdate,
        calc,
        regenerateFigures: null,
        createTooltipDataSource: null,
        draw: isMarker
          ? ({ ctx, chart, indicator, xAxis, yAxis }) => {
              const data = chart.getDataList()
              const range = chart.getVisibleRange()
              const size = Math.max(4, Math.min(9, chart.getBarSpace().bar * 0.45))
              for (let i = Math.max(0, range.realFrom); i <= Math.min(data.length - 1, range.realTo); i++) {
                const v = indicator.result[i]?.value
                if (v == null || v === 0) continue
                const x = xAxis.convertToPixel(i)
                if (v > 0) upArrow(ctx, x, yAxis.convertToPixel(data[i].low) + 4, size, '#26A69A')
                else downArrow(ctx, x, yAxis.convertToPixel(data[i].high) - 4, size, '#EF5350')
              }
              return true
            }
          : null
      }
      registerIndicator(template)
      registerIndicatorSettings(
        name,
        templateParams(spec).map((p) => ({ paramNameKey: p.label, precision: p.isInt ? 0 : 4, min: p.min, default: p.default }))
      )
      registeredNames.add(name)
    }
    const item = { name, label: `${spec.title} ${spec.version}`, description: spec.description }
    ;(spec.pane === 'main' ? main : sub).items.push(item)
  })
  return [main, sub].filter((g) => g.items.length > 0)
}

/** Build the params validator the chart's settings dialog asks, or `null` when this server
 * cannot answer.
 *
 * Keeps the server knowledge in the app: the library's dialog knows only a template name
 * and a flat `calcParams` array, so the mapping back to a node document -- which is exactly
 * `seriesDocFor` -- has to happen here. A built-in indicator (`MA`, `VOL`, anything without
 * the `S:` prefix) is computed by klinecharts itself and has nothing to ask about.
 */
export function createParamsValidator(
  specs: IndicatorSpec[]
): ((request: {
  indicatorName: string
  calcParams: unknown[]
  symbol: SymbolInfo
  period: { text: string }
}) => Promise<{ ok: boolean; reason?: string | null; hint?: string | null }>) | null {
  if (!hasFeature('indicators.resolve')) return null
  const byTemplate = new Map(specs.map((s) => [templateName(s), s]))
  return async (request) => {
    const spec = byTemplate.get(request.indicatorName)
    if (!spec) return { ok: true }
    const vendorSymbol = `${symbolVendor(request.symbol)}:${request.symbol.ticker}`
    const result = await resolveSeries(
      vendorSymbol,
      request.period.text,
      seriesDocFor(spec, request.calcParams)
    )
    if (!result) return { ok: true } // unanswerable: behave as if nobody were checking
    if (!result.servable) return { ok: false, reason: result.reason }
    // A servable series still has a cost worth showing: the lead-in scales with the
    // look-back, so "window 5000" quietly means reading thousands of extra bars per draw.
    const hint =
      result.mode === 'persisted'
        ? 'Served from the store.'
        : `Computed on demand; needs ${result.warmupBars.toLocaleString()} bars of warm-up.`
    return { ok: true, hint }
  }
}
