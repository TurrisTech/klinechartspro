import { registerIndicator, type Indicator, type IndicatorTemplate, type KLineData } from 'klinecharts'
import { registerIndicatorSettings, type IndicatorGroup } from '../../src'
import type { SeriesDoc } from '../indicators/api'
import { peekStore } from '../plugins/store'
import { matches, readField, type MarkSpec, type RegistryIndicator, type RegistrySeries } from './api'
import { drawLabel, drawMark, type Fill } from './marks'
import type { BarValue, RegistryStore } from './store'

// ONE klinecharts template, built from a registry row. It computes nothing: `calc` reads
// the points the host fetched into the store and turns them into the figures the row
// declares, and `draw` puts the row's marks on top.
//
// This replaces four hand-written templates -- five AREV generations in one, krev01, the
// `S:` registry series and the crossover markers -- which between them held three
// definitions of a triangle, two copies of the AREV signal threshold and two of krev01's
// neighbour floor. A number that decides what is drawn now has one home, and it is the row.
//
// Three klinecharts facts the row has to be turned into, each of which cost a bug before:
//
//   * `draw`'s return value is assigned to `isCover`, and the declared figures render only
//     `if (!isCover)`. A pane with lines AND marks must return FALSE or its lines vanish;
//     a pure-marker indicator declares no figures and returns true. Both happen here, and
//     which one is decided by the row rather than by whoever wrote the template.
//   * `minValue`/`maxValue` WIDEN the y-axis, never narrow it. So `valueRange` reads as
//     "never zoom inside this", which is what makes a 0.52 on a probability pane look like
//     0.52 rather than like a decisive move.
//   * A value that is not a figure key does not enter the y-axis range. Marker values and
//     the raw bar ride on non-figure keys for exactly that reason: a +1/-1 crossover series
//     in the price pane's range would flatten the candles.

/** Figure keys are object keys in klinecharts' own structures, and a series key may be
 * two-part (`top.p`). Flattened so the two never have to agree about dots. */
export function figureKey(seriesKey: string): string {
  return seriesKey.replace(/\./g, '_')
}

export interface ExtendData {
  seriesKey: string
  rev: number
}

export type Value = Record<string, number | undefined> & {
  /** The bar's raw store value, for `draw` to evaluate predicates against. Deliberately not
   * a figure: it is not a number, and only figure keys widen the pane's y-axis. */
  __bar?: BarValue
}

/** The series that become figures, in declaration order -- klinecharts pairs figures with
 * `styles.lines` by index, so this order is the styles' order too. */
export function drawnSeries(entry: RegistryIndicator): RegistrySeries[] {
  return entry.series.filter(
    (s) => (s.role === 'value' || s.role === 'reference') && s.render !== 'none' && s.render !== 'marker'
  )
}

export function markSeries(entry: RegistryIndicator): RegistrySeries[] {
  return entry.series.filter((s) => (s.marks?.length ?? 0) > 0)
}

const DEFAULT_MARK_COLOR = '#787B86'

/** The colours a registry row's line cycles through when several single-line indicators
 * share a pane. A row states its own colour, which is right for a model's pane where every
 * line means something different -- but two moving averages differing only in their window
 * are the SAME row, so the row's colour would put both of them in the same orange. This is
 * the disambiguator, by order of appearance, and it mirrors `tsregistry.PALETTE`. */
export const PALETTE = ['#FF9600', '#9D65C9', '#2196F3', '#E11D74', '#26A69A', '#FFEB3B', '#8D6E63']

function fillOf(mark: MarkSpec, bar: BarValue | undefined): Fill {
  if (!mark.fill) return 'solid'
  const raw = readField(bar, mark.fill.field)
  if (raw == null) return mark.fill.default ?? 'solid'
  return mark.fill.map[String(raw)] ?? mark.fill.default ?? 'solid'
}

/** The value one bar contributes, before carry-forward: every drawn series' number, gated,
 * plus every reference's constant. Exported for the tests, which assert the gate and the
 * fold without a chart. */
export function barValues(entry: RegistryIndicator, bar: BarValue | undefined): Value {
  const value: Value = {}
  for (const s of entry.series) {
    if (s.role === 'reference') {
      if (s.constant != null) value[figureKey(s.key)] = s.constant
      continue
    }
    if (s.render === 'none') continue
    if (bar === undefined) continue
    // A gate is about calibration, not about drawing: krev01 serves a vote drawn from three
    // neighbours and must not draw it, because below a full window the share is not on the
    // scale the pane's axis claims.
    if (s.gate && !matches(s.gate, bar)) continue
    const raw = readField(bar, s.key)
    if (typeof raw === 'number' && Number.isFinite(raw)) value[figureKey(s.key)] = raw
  }
  if (bar !== undefined) value.__bar = bar
  return value
}

function makeCalc(entry: RegistryIndicator) {
  const held = entry.series.filter((s) => s.render === 'hold').map((s) => figureKey(s.key))
  return (dataList: KLineData[], indicator: Indicator<Value, number, ExtendData>): Value[] => {
    const store = peekStore<RegistryStore>(indicator.extendData?.seriesKey)
    if (!store) return dataList.map(() => ({}))
    // `hold` carries the last value forward over bars that have none. A vote exists only on
    // a candidate bar -- about a third of them for krev01 -- so a plain line would be mostly
    // gaps, and the model's current lean is what a reader is actually looking at.
    const carried: Record<string, number | undefined> = {}
    return dataList.map((d) => {
      const value = barValues(entry, store.values.get(d.timestamp))
      for (const key of held) {
        if (value[key] != null) carried[key] = value[key]
        else if (carried[key] != null) value[key] = carried[key]
      }
      return value
    })
  }
}

function shouldUpdate(prev: Indicator<Value, number, ExtendData>, cur: Indicator<Value, number, ExtendData>) {
  const paramsChanged = JSON.stringify(prev.calcParams) !== JSON.stringify(cur.calcParams)
  const dataChanged =
    prev.extendData?.seriesKey !== cur.extendData?.seriesKey || prev.extendData?.rev !== cur.extendData?.rev
  return { calc: paramsChanged || dataChanged, draw: true }
}

function makeDraw(entry: RegistryIndicator) {
  const marked = markSeries(entry)
  const hasFigures = drawnSeries(entry).length > 0
  if (marked.length === 0) return null
  return ({ ctx, chart, indicator, xAxis, yAxis }: Parameters<NonNullable<IndicatorTemplate<Value, number, ExtendData>['draw']>>[0]) => {
    const data = chart.getDataList()
    const range = chart.getVisibleRange()
    const base = Math.max(3, Math.min(9, chart.getBarSpace().bar * 0.45))
    for (let i = Math.max(0, range.realFrom); i <= Math.min(data.length - 1, range.realTo); i++) {
      const value = indicator.result[i]
      if (value == null) continue
      const bar = value.__bar
      if (bar == null) continue
      const x = xAxis.convertToPixel(i)
      for (const series of marked) {
        for (const mark of series.marks ?? []) {
          if (!matches(mark.when, bar)) continue
          const anchor = mark.anchor ?? 'bar:close'
          let y: number | null = null
          if (anchor.startsWith('series:')) {
            const at = value[figureKey(anchor.slice('series:'.length))]
            if (at != null) y = yAxis.convertToPixel(at)
          } else {
            const candle = data[i]
            const price =
              anchor === 'bar:low' ? candle.low : anchor === 'bar:high' ? candle.high : candle.close
            // Clear of the candle, on the side the anchor names.
            y = yAxis.convertToPixel(price) + (anchor === 'bar:low' ? 4 : anchor === 'bar:high' ? -4 : 0)
          }
          if (y == null) continue
          const color = mark.color ?? series.color ?? DEFAULT_MARK_COLOR
          const size = base * (mark.size ?? 1)
          drawMark(ctx, mark, x, y, size, fillOf(mark, bar), color)
          if (mark.labelField) {
            const raw = readField(bar, mark.labelField)
            if (typeof raw === 'number') drawLabel(ctx, x + size + 3, y, raw.toFixed(2), color)
          }
          break // first match wins: the marks are an ordered rule, not a set
        }
      }
    }
    // FALSE keeps the declared figures rendering (klinecharts assigns this to `isCover` and
    // skips them when it is true). TRUE only where the row declares none.
    return !hasFigures
  }
}

// -- params ------------------------------------------------------------------------------

/** The klinecharts settings dialog edits a flat numeric `calcParams` array. A row's scalar
 * params come first, in order, then -- for a default input that is a single-`window` node
 * (the crossover's two SMAs) -- that window, so "cross of SMA 10 / SMA 20" stays a
 * two-number edit. Anything richer belongs in the config UI, not in this dialog. */
export interface TemplateParam {
  label: string
  kind: 'param' | 'input-window'
  name: string
  default: number
  min: number
  isInt: boolean
}

export function templateParams(entry: RegistryIndicator): TemplateParam[] {
  const out: TemplateParam[] = entry.params.map((p) => ({
    label: p.name.replace(/_/g, ' '),
    kind: 'param' as const,
    name: p.name,
    default: p.default,
    min: p.min ?? 1,
    isInt: p.type === 'int'
  }))
  entry.inputs.forEach((input, i) => {
    const params = (input as { params?: Record<string, number> }).params
    if (input && typeof input === 'object' && 'name' in input && params && typeof params.window === 'number') {
      out.push({
        label: `${entry.inputLabels[i] ?? `input ${i + 1}`} (${String((input as { name: string }).name)}) window`,
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

export function defaultCalcParams(entry: RegistryIndicator): number[] {
  return templateParams(entry).map((p) => p.default)
}

/** The node document the server resolves for this row + calcParams (a `computed` entry). */
export function seriesDocFor(entry: RegistryIndicator, calcParams: unknown[]): SeriesDoc {
  const tp = templateParams(entry)
  const params: Record<string, number> = {}
  const inputs = entry.inputs.map((i) => JSON.parse(JSON.stringify(i)) as Record<string, unknown>)
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
  const version = entry.template.includes('@') ? entry.template.slice(entry.template.lastIndexOf('@') + 1) : undefined
  const name = entry.template.startsWith('S:')
    ? entry.template.slice(2, entry.template.lastIndexOf('@'))
    : entry.name
  return { name, version, params, inputs }
}

// -- registration ------------------------------------------------------------------------

const registered = new Set<string>()

export function buildTemplate(entry: RegistryIndicator): IndicatorTemplate<Value, number, ExtendData> {
  const figures = drawnSeries(entry)
  const main = entry.pane === 'main'
  const draw = makeDraw(entry)
  return {
    name: entry.template,
    shortName: entry.title,
    precision: entry.precision ?? (main ? 5 : 2),
    calcParams: defaultCalcParams(entry),
    shouldOhlc: false,
    shouldFormatBigNumber: false,
    visible: true,
    zLevel: 0,
    extendData: { seriesKey: '', rev: 0 },
    series: main ? 'price' : 'normal',
    figures: figures.map((s) => ({
      key: figureKey(s.key),
      title: `${s.label}: `,
      type: s.render === 'histogram' ? 'bar' : 'line'
    })),
    // Only where something is drawn on the axis: a pure-marker indicator has no figures, so
    // pinning its range would widen a pane it does not own (the price pane, by its -1..+1).
    minValue: entry.valueRange && figures.length > 0 ? entry.valueRange[0] : null,
    maxValue: entry.valueRange && figures.length > 0 ? entry.valueRange[1] : null,
    styles:
      figures.length > 0
        ? {
            lines: figures.map((s) => ({
              color: s.color ?? DEFAULT_MARK_COLOR,
              size: s.lineWidth,
              style: s.lineStyle,
              smooth: false,
              dashedValue: [2, 2]
            }))
          }
        : null,
    shouldUpdate,
    calc: makeCalc(entry),
    regenerateFigures: null,
    createTooltipDataSource: null,
    draw
  }
}

/** Register every entry once and return the picker groups.
 *
 * Grouped by an entry's FIRST tag, which is what a tag is for: arev21 and a future
 * arev21-mtf carry `arev21` and appear together however they are served. Within a tag the
 * price-pane and sub-pane entries are separate groups, because `IndicatorGroup.main` is a
 * property of the group and the picker puts the two in different lists. */
export function registerRegistryIndicators(entries: RegistryIndicator[]): IndicatorGroup[] {
  const groups = new Map<string, IndicatorGroup>()
  for (const entry of entries) {
    if (!registered.has(entry.template)) {
      registerIndicator(buildTemplate(entry))
      const params = templateParams(entry)
      if (params.length > 0) {
        registerIndicatorSettings(
          entry.template,
          params.map((p) => ({ paramNameKey: p.label, precision: p.isInt ? 0 : 4, min: p.min, default: p.default }))
        )
      }
      registered.add(entry.template)
    }
    const tag = entry.tags[0] ?? 'other'
    const key = `${tag}|${entry.pane}`
    let group = groups.get(key)
    if (!group) {
      group = { label: groupLabel(tag, entry.pane), main: entry.pane === 'main', items: [] }
      groups.set(key, group)
    }
    group.items.push({ name: entry.template, label: entry.title, description: entry.description })
  }
  return [...groups.values()]
}

const GROUP_LABELS: Record<string, string> = {
  library: 'Server',
  research: 'Research',
  arev: 'AREV research',
  krev: 'KREV research'
}

function groupLabel(tag: string, pane: 'main' | 'sub'): string {
  const base = GROUP_LABELS[tag] ?? tag.replace(/[-_]/g, ' ')
  // Only the general groups need the pane said out loud; a model's group has one pane.
  return base === 'Server' || base === 'Research' ? `${base} · ${pane === 'main' ? 'price pane' : 'sub-pane'}` : base
}

/** Test seam: template registration is process-global in klinecharts. */
export function resetRegisteredTemplates(): void {
  registered.clear()
}
