import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

installWindow()
const { storeFor } = await import('../plugins/store')
const { storeFactory } = await import('./store')
const {
  barValues,
  buildTemplate,
  defaultCalcParams,
  drawnSeries,
  figureKey,
  markSeries,
  registerRegistryIndicators,
  resetRegisteredTemplates,
  seriesDocFor,
  templateParams
} = await import('./templates')
import type { Value } from './templates'
import type { RegistryIndicator, RegistrySeries } from './api'
import type { BarValue, RegistryPoint } from './store'

// What one registry row becomes on the chart. These are the rules that used to live as
// hand-written klinecharts templates, one per model, and the assertions are the behaviours
// those templates had -- so a row that reproduces AREV's pane reproduces it exactly.

/** `RegistryPoint` declares only `date` on purpose -- a row's fields are the registry's
 * business -- so a fixture literal is widened here rather than typed twice. */
const bar = (o: Record<string, unknown>) => o as unknown as BarValue
const row = (o: Record<string, unknown>) => o as unknown as RegistryPoint

const series = (over: Partial<RegistrySeries> & { key: string }): RegistrySeries => ({
  label: over.key,
  description: '',
  role: 'value',
  render: 'line',
  pane: null,
  color: '#123456',
  lineStyle: 'solid',
  lineWidth: 1,
  constant: null,
  marks: null,
  gate: null,
  visible: true,
  ...over
})

const entry = (over: Partial<RegistryIndicator> & { name: string }): RegistryIndicator => ({
  template: `TS:${over.name}`,
  title: over.name.toUpperCase(),
  description: '',
  tags: ['test'],
  pane: 'sub',
  source: { kind: 'table' },
  wire: { plugin: 'ts', variant: over.name },
  feature: null,
  params: [],
  inputs: [],
  inputLabels: [],
  dependsOn: [],
  valueRange: null,
  axisGap: null,
  precision: null,
  displayOrder: 100,
  enabled: true,
  series: [series({ key: 'value' })],
  ...over
})

/** An AREV-shaped row, as wtradingindicators declares it. */
const AREV = entry({
  name: 'arev21',
  template: 'AREV:arev21',
  title: 'AREV21',
  tags: ['arev', 'arev21'],
  valueRange: [0.425, 0.575],
  precision: 3,
  wire: { plugin: 'arev', variant: 'arev21' },
  series: [
    series({ key: 'p', label: 'P(up)', color: '#426EFF' }),
    series({ key: 'upper', label: 'long', role: 'reference', constant: 0.575, lineStyle: 'dashed', color: '#26A69A' }),
    series({ key: 'lower', label: 'short', role: 'reference', constant: 0.425, lineStyle: 'dashed', color: '#EF5350' }),
    series({ key: 'mid', label: 'even', role: 'reference', constant: 0.5, lineStyle: 'dashed', color: '#787B86' }),
    series({
      key: 'signal',
      label: 'signal',
      role: 'signal',
      render: 'marker',
      marks: [
        { id: 'long', when: { field: 'signal', eq: 'long' }, shape: 'arrow-up', color: '#26A69A', anchor: 'series:p' },
        { id: 'short', when: { field: 'signal', eq: 'short' }, shape: 'arrow-down', color: '#EF5350', anchor: 'series:p' }
      ]
    }),
    series({ key: 'n', label: 'samples', role: 'meta', render: 'none' })
  ]
})

/** A krev01-shaped row: folded by side, carried forward, gated on the neighbour count. */
const KREV = entry({
  name: 'krev01',
  template: 'KREV:krev01:p',
  tags: ['krev'],
  valueRange: [0, 0.5],
  series: [
    series({ key: 'top.p', label: 'top p', render: 'hold', gate: { field: 'top.n', gte: 50 }, color: '#EF535099' }),
    series({ key: 'bottom.p', label: 'bottom p', render: 'hold', gate: { field: 'bottom.n', gte: 50 }, color: '#26A69A99' }),
    series({ key: 'threshold', label: 'signal', role: 'reference', constant: 0.5 })
  ]
})

describe('which series become figures', () => {
  test('values and references are drawn; meta, markers and none are not', () => {
    expect(drawnSeries(AREV).map((s) => s.key)).toEqual(['p', 'upper', 'lower', 'mid'])
    expect(markSeries(AREV).map((s) => s.key)).toEqual(['signal'])
  })

  test('a two-part key is flattened, because a figure key is an object key', () => {
    expect(figureKey('top.p')).toBe('top_p')
    expect(figureKey('p')).toBe('p')
  })
})

describe('what one bar contributes', () => {
  test('references are on every bar, including one with no data at all', () => {
    // The pane falls back to its thresholds when the visible range holds no points, instead
    // of klinecharts' own [0, 10].
    const value = barValues(AREV, undefined)
    expect(value.upper).toBeCloseTo(0.575)
    expect(value.mid).toBeCloseTo(0.5)
    expect(value.p).toBeUndefined()
    expect(value.__bar).toBeUndefined()
  })

  test('a value is read off the point and the raw bar is stashed for draw', () => {
    const point = bar({ date: 1, p: 0.61, n: 200, signal: 'long' })
    const value = barValues(AREV, point)
    expect(value.p).toBe(0.61)
    expect(value.__bar).toBe(point)
    // `n` is meta: served, never drawn, and never in the y-axis range.
    expect(value.n).toBeUndefined()
  })

  test('a gate drops the value rather than drawing an uncalibrated one', () => {
    const folded = bar({ top: { date: 1, p: 0.7, n: 3 }, bottom: { date: 1, p: 0.62, n: 80 } })
    const value = barValues(KREV, folded)
    expect(value.top_p).toBeUndefined()
    expect(value.bottom_p).toBe(0.62)
  })

  test('a two-part key reads through the fold', () => {
    const value = barValues(KREV, bar({ top: { date: 1, p: 0.7, n: 80 } }))
    expect(value.top_p).toBe(0.7)
    expect(value.bottom_p).toBeUndefined()
  })

  test('a non-numeric or missing field is simply absent, never NaN', () => {
    const value = barValues(AREV, bar({ date: 1, p: null, signal: 'long' }))
    expect(value.p).toBeUndefined()
    expect('p' in value).toBe(false)
  })
})

describe('the template a row builds', () => {
  test('figures and line styles are in the same order, which klinecharts pairs by index', () => {
    const t = buildTemplate(AREV)
    expect((t.figures ?? []).map((f) => f.key)).toEqual(['p', 'upper', 'lower', 'mid'])
    expect(t.styles?.lines?.map((l) => l.color)).toEqual([
      '#426EFF',
      '#26A69A',
      '#EF5350',
      '#787B86'
    ])
    expect(t.styles?.lines?.map((l) => l.style)).toEqual(['solid', 'dashed', 'dashed', 'dashed'])
  })

  test('the value range is carried, and the pane and precision come from the row', () => {
    const t = buildTemplate(AREV)
    expect(t.minValue).toBeCloseTo(0.425)
    expect(t.maxValue).toBeCloseTo(0.575)
    expect(t.series).toBe('normal')
    expect(t.precision).toBe(3)
    expect(t.shortName).toBe('AREV21')
    expect(t.name).toBe('AREV:arev21')
  })

  test('a price-pane row draws in the price series and formats like price', () => {
    const t = buildTemplate(entry({ name: 'sma', pane: 'main', template: 'S:sma@v0.0.1' }))
    expect(t.series).toBe('price')
    expect(t.precision).toBe(5)
  })

  test('a marker-only row declares no figures and does not pin the pane it borrows', () => {
    // A crossover's -1/0/+1 in the price pane's y-axis range would flatten the candles.
    const cross = entry({
      name: 'cross_over_under',
      pane: 'main',
      valueRange: [-1, 1],
      series: [
        series({
          key: 'value',
          render: 'marker',
          marks: [
            { when: { field: 'value', gt: 0 }, shape: 'arrow-up', anchor: 'bar:low' },
            { when: { field: 'value', lt: 0 }, shape: 'arrow-down', anchor: 'bar:high' }
          ]
        })
      ]
    })
    const t = buildTemplate(cross)
    expect(t.figures).toEqual([])
    expect(t.minValue).toBeNull()
    expect(t.maxValue).toBeNull()
    expect(t.styles).toBeNull()
  })

  test('a row with no marks has no draw callback at all', () => {
    expect(buildTemplate(entry({ name: 'plain' })).draw).toBeNull()
  })

  test('hold carries the last value forward over bars that have none', () => {
    // A vote exists only on a candidate bar, so a plain line would be mostly gaps.
    const key = 'krev-test-key'
    const store = storeFor(key, storeFactory('side'))
    store.ingest(
      [
        row({ date: 1000, p: 0.44, n: 80, side: 'top' }),
        row({ date: 3000, p: 0.48, n: 80, side: 'top' })
      ],
      { from: 0, to: 10_000 }
    )
    const t = buildTemplate(KREV)
    const bars = [1000, 2000, 3000, 4000].map((timestamp) => ({ timestamp }) as never)
    const values = t.calc(bars, { extendData: { seriesKey: key, rev: 1 }, calcParams: [] } as never) as Value[]
    expect(values.map((v) => v.top_p)).toEqual([0.44, 0.44, 0.48, 0.48])
    // The reference is on every bar whether or not a vote is.
    expect(values.every((v) => v.threshold === 0.5)).toBe(true)
  })

  test('calc with no store yields empty values rather than throwing', () => {
    const t = buildTemplate(AREV)
    const values = t.calc([{ timestamp: 1 }] as never, { extendData: { seriesKey: 'absent', rev: 0 } } as never)
    expect(values).toEqual([{}] as never)
  })
})

describe('draw and the isCover trap', () => {
  const fakeDrawArgs = (bars: Array<Record<string, number>>, results: unknown[]) => {
    const painted: string[] = []
    const ctx = new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === 'save' || prop === 'restore' || prop === 'beginPath' || prop === 'closePath') return () => {}
          if (prop === 'fill') return () => painted.push('fill')
          if (prop === 'stroke') return () => painted.push('stroke')
          if (typeof prop === 'string') return () => {}
          return undefined
        },
        set: () => true
      }
    ) as CanvasRenderingContext2D
    return {
      painted,
      args: {
        ctx,
        chart: {
          getDataList: () => bars,
          getVisibleRange: () => ({ realFrom: 0, realTo: bars.length - 1 }),
          getBarSpace: () => ({ bar: 10 })
        },
        indicator: { result: results },
        xAxis: { convertToPixel: (i: number) => i * 10 },
        yAxis: { convertToPixel: (v: number) => 100 - v * 100 }
      } as never
    }
  }

  test('a row with figures AND marks returns false, so its lines still render', () => {
    // klinecharts assigns this return to `isCover` and renders the declared figures only
    // `if (!isCover)`. Returning true here is how the AREV pane once drew its arrows and
    // none of its four lines.
    const t = buildTemplate(AREV)
    const { args } = fakeDrawArgs([{ timestamp: 1 }], [barValues(AREV, bar({ date: 1, p: 0.6, signal: 'long' }))])
    expect(t.draw?.(args)).toBe(false)
  })

  test('a marker-only row returns true, because it has nothing to suppress', () => {
    const cross = entry({
      name: 'cross2',
      series: [
        series({
          key: 'value',
          render: 'marker',
          marks: [{ when: { field: 'value', gt: 0 }, shape: 'arrow-up', anchor: 'bar:low' }]
        })
      ]
    })
    const t = buildTemplate(cross)
    const { args } = fakeDrawArgs([{ timestamp: 1, low: 1, high: 2, close: 1.5 }], [barValues(cross, bar({ date: 1, value: 1 }))])
    expect(t.draw?.(args)).toBe(true)
  })

  test('only the labelled bars are marked, and the first matching mark wins', () => {
    const t = buildTemplate(AREV)
    const bars = [{ timestamp: 1 }, { timestamp: 2 }]
    const results = [
      barValues(AREV, bar({ date: 1, p: 0.62, signal: 'long' })),
      barValues(AREV, bar({ date: 2, p: 0.62, signal: null }))
    ]
    const { painted, args } = fakeDrawArgs(bars, results)
    t.draw?.(args)
    // One mark: fill + stroke for the labelled bar, nothing for the unlabelled one whose p
    // sits in exactly the same place.
    expect(painted).toEqual(['fill', 'stroke'])
  })
})

describe('the picker groups', () => {
  test('grouped by first tag, split by pane, labelled for a reader', () => {
    resetRegisteredTemplates()
    const groups = registerRegistryIndicators([
      entry({ name: 'sma', pane: 'main', tags: ['library', 'moving-average'], template: 'S:sma@v1' }),
      entry({ name: 'rsi', pane: 'sub', tags: ['library', 'rsi'], template: 'S:rsi@v1' }),
      AREV,
      entry({ name: 'arev19', template: 'AREV:arev19', tags: ['arev', 'arev19'] })
    ])
    const byLabel = Object.fromEntries(groups.map((g) => [g.label, g.items.map((i) => i.name)]))
    expect(byLabel['Server · price pane']).toEqual(['S:sma@v1'])
    expect(byLabel['Server · sub-pane']).toEqual(['S:rsi@v1'])
    // arev21 and arev19 share the tag, so they share a group however they are served.
    expect(byLabel['AREV research']).toEqual(['AREV:arev21', 'AREV:arev19'])
    expect(groups.find((g) => g.label === 'Server · price pane')?.main).toBe(true)
    expect(groups.find((g) => g.label === 'AREV research')?.main).toBe(false)
  })

  test('an item carries the row title and description, which is all the picker shows', () => {
    resetRegisteredTemplates()
    const [group] = registerRegistryIndicators([
      entry({ name: 'thing', title: 'A Thing', description: 'what it does', tags: ['research'] })
    ])
    expect(group.items[0]).toEqual({ name: 'TS:thing', label: 'A Thing', description: 'what it does' })
  })
})

describe('params, for a computed row', () => {
  const RSI = entry({
    name: 'rsi',
    template: 'S:rsi@v0.0.2',
    wire: { plugin: 'indicators' },
    params: [{ name: 'window', type: 'int', default: 14, min: 1, max: 100000, description: '' }],
    inputs: [{ column: 'close' }],
    inputLabels: ['source']
  })

  const CROSS = entry({
    name: 'cross_over_under',
    template: 'S:cross_over_under@v0.0.1',
    wire: { plugin: 'indicators' },
    params: [],
    inputs: [
      { name: 'sma', params: { window: 10 }, inputs: [{ column: 'close' }] },
      { name: 'sma', params: { window: 20 }, inputs: [{ column: 'close' }] }
    ],
    inputLabels: ['fast', 'slow']
  })

  test('scalar params come first, then a single-window input, so a cross is two numbers', () => {
    expect(templateParams(RSI).map((p) => p.name)).toEqual(['window'])
    expect(defaultCalcParams(RSI)).toEqual([14])
    expect(templateParams(CROSS).map((p) => [p.kind, p.default])).toEqual([
      ['input-window', 10],
      ['input-window', 20]
    ])
    expect(templateParams(CROSS)[0].label).toBe('fast (sma) window')
  })

  test('calcParams resolve back to the node document the server keys the series by', () => {
    expect(seriesDocFor(RSI, [21])).toEqual({
      name: 'rsi',
      version: 'v0.0.2',
      params: { window: 21 },
      inputs: [{ column: 'close' }]
    })
    const doc = seriesDocFor(CROSS, [5, 40])
    expect(doc.name).toBe('cross_over_under')
    expect(doc.inputs?.map((i) => (i as { params: { window: number } }).params.window)).toEqual([5, 40])
  })

  test('a missing or non-numeric calcParam falls back to the row default', () => {
    expect(seriesDocFor(RSI, []).params).toEqual({ window: 14 })
    expect(seriesDocFor(RSI, ['x']).params).toEqual({ window: 14 })
  })

  test('an int param is rounded, because the server refuses a fractional window', () => {
    expect(seriesDocFor(RSI, [21.6]).params).toEqual({ window: 22 })
  })
})
