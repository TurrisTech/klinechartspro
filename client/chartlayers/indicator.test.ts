import { afterEach, describe, expect, test } from 'bun:test'
import type { Chart, Indicator, OverlayCreate } from 'klinecharts'
import type { ChartProPane, IndicatorGroup } from '../../src'
import { fakePane, installWindow } from '../plugins/testing'
import type { BindContext, PluginFacilities } from '../plugins/types'
import type { SettingsField } from './settings'
import type { ChartLayer } from './types'

// A chart layer as an indicator: drawn on a pane exactly while that pane carries the layer's
// template, visible, with settings of its own per pane -- the controller (controller.ts) and
// the plugin around it (plugin.ts), over a stand-in layer and chart so nothing is fetched.

installWindow()
const win = globalThis.window as unknown as Record<string, unknown>
win.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }

const { createLayerController } = await import('./controller')
const { createLayerPlugin } = await import('./plugin')

const TEMPLATE = 'LAYER:test'
/** The controller samples its panes every 200ms; a little over one period. */
const SAMPLE = 260

interface Config {
  intervals: Record<string, boolean>
  width: number
}

const DEFAULTS: Config = { intervals: { '1W': true, '1M': true }, width: 1 }
const FIELDS: SettingsField[] = [
  { kind: 'switch', key: 'intervals.1W', label: '1W' },
  { kind: 'switch', key: 'intervals.1M', label: '1M' },
  { kind: 'number', key: 'width', label: 'Width', min: 0.5, max: 8, step: 0.5 }
]

function testLayer(fetches: string[]): ChartLayer<{ price: number }, Config> {
  return {
    id: 'test',
    label: 'Test',
    defaults: DEFAULTS,
    fields: FIELDS,
    available: (symbol) => symbol.ticker !== 'NONE',
    cacheKey: (ctx, config) => `${ctx.symbol.ticker}|${JSON.stringify(config.intervals)}`,
    datumKey: (datum) => String(datum.price),
    fetch: async (ctx) => {
      fetches.push(ctx.symbol.ticker)
      return [{ price: 1.1 }]
    },
    toOverlays: (data, _ctx, config) =>
      data.map((datum) => ({
        name: 'horizontalStraightLine',
        points: [{ value: datum.price }],
        styles: { line: { size: config.width } }
      }))
  }
}

interface TestChart {
  chart: Chart
  indicators: Indicator[]
  /** Every overlay currently on the chart. */
  overlays: OverlayCreate[]
}

function testChart(): TestChart {
  const bars = Array.from({ length: 50 }, (_, i) => ({
    timestamp: 1_000_000 + i * 3_600_000,
    open: 1.1,
    high: 1.12,
    low: 1.08,
    close: 1.1
  }))
  const state: TestChart = { chart: null as unknown as Chart, indicators: [], overlays: [] }
  state.chart = {
    getIndicators: (filter?: { name?: string }) =>
      state.indicators.filter((indicator) => !filter?.name || indicator.name === filter.name),
    getDataList: () => bars,
    getVisibleRange: () => ({ from: 0, to: bars.length, realFrom: 0, realTo: bars.length - 1 }),
    getYAxes: () => [{ getRange: () => ({ from: 1.0, to: 1.2 }) }],
    createOverlay: (list: OverlayCreate[]) => {
      state.overlays.push(...list)
      return list.map(() => 'id')
    },
    removeOverlay: (filter: { groupId?: string }) => {
      state.overlays = state.overlays.filter((overlay) => overlay.groupId !== filter.groupId)
    },
    subscribeAction: () => {},
    unsubscribeAction: () => {}
  } as unknown as Chart
  return state
}

function indicator(visible = true): Indicator {
  return { id: 'ind1', name: TEMPLATE, paneId: 'candle_pane', calcParams: [], visible } as unknown as Indicator
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup) fn()
  cleanup = []
})

function setup(panes = 1) {
  const fetches: string[] = []
  const controller = createLayerController(testLayer(fetches), TEMPLATE)
  const charts = Array.from({ length: panes }, () => testChart())
  const wall: ChartProPane[] = charts.map((c, i) => fakePane(`p${i + 1}`, c.chart))
  controller.sync(wall)
  cleanup.push(() => controller.sync([]))
  return { controller, charts, wall, fetches }
}

function widths(chart: TestChart): number[] {
  return chart.overlays.map((overlay) => (overlay.styles as { line: { size: number } }).line.size)
}

describe('the controller', () => {
  test('draws nothing on a pane without the indicator, and fetches nothing for it', async () => {
    const { charts, fetches } = setup()
    await sleep(SAMPLE)
    expect(fetches).toEqual([])
    expect(charts[0].overlays).toEqual([])
  })

  test('adding the indicator draws the layer; hiding it clears it; removing it clears it', async () => {
    const { charts, fetches } = setup()
    charts[0].indicators.push(indicator())
    await sleep(SAMPLE)
    expect(fetches).toEqual(['EURUSD'])
    expect(charts[0].overlays.map((overlay) => overlay.groupId)).toEqual(['test'])

    charts[0].indicators[0] = indicator(false)
    await sleep(SAMPLE)
    expect(charts[0].overlays).toEqual([])

    // Back on: what it held was dropped when it went off, so this is a fresh read.
    charts[0].indicators[0] = indicator(true)
    await sleep(SAMPLE)
    expect(fetches).toEqual(['EURUSD', 'EURUSD'])
    expect(charts[0].overlays).toHaveLength(1)

    charts[0].indicators.length = 0
    await sleep(SAMPLE)
    expect(charts[0].overlays).toEqual([])
  })

  test('only the panes carrying it, each with its own settings', async () => {
    const { controller, charts, fetches } = setup(2)
    charts[1].indicators.push(indicator())
    await sleep(SAMPLE)
    expect(fetches).toHaveLength(1)
    expect(charts[0].overlays).toEqual([])
    expect(widths(charts[1])).toEqual([1])

    // A style edit repaints from what the pane holds: no request.
    controller.setConfig(1, { ...DEFAULTS, width: 3 })
    expect(widths(charts[1])).toEqual([3])
    expect(fetches).toHaveLength(1)
    expect(controller.configFor(0).width).toBe(1)

    // A lever in the cache key reads again.
    controller.setConfig(1, { ...controller.configFor(1), intervals: { '1W': true, '1M': false } })
    await sleep(0)
    expect(fetches).toHaveLength(2)
  })

  test('a settings edit is normalised, and only what differs is snapshotted', () => {
    const { controller } = setup(2)
    controller.setConfig(0, { width: 100, intervals: { '1W': false } })
    expect(controller.configFor(0)).toEqual({ intervals: { '1W': false, '1M': true }, width: 8 })
    controller.setConfig(1, structuredClone(DEFAULTS))
    expect(controller.snapshot()).toEqual({ 0: { 'intervals.1W': false, width: 8 } })

    const fresh = createLayerController(testLayer([]), TEMPLATE)
    fresh.hydrate(controller.snapshot())
    expect(fresh.configFor(0)).toEqual(controller.configFor(0))
    expect(fresh.configFor(1)).toEqual(DEFAULTS)
  })

  test('an instrument without coverage draws nothing, however the pane is set', async () => {
    const fetches: string[] = []
    const controller = createLayerController(testLayer(fetches), TEMPLATE)
    const chart = testChart()
    chart.indicators.push(indicator())
    controller.sync([fakePane('p1', chart.chart, 'NONE')])
    cleanup.push(() => controller.sync([]))
    await sleep(SAMPLE)
    expect(fetches).toEqual([])
    expect(chart.overlays).toEqual([])
  })
})

describe('the plugin', () => {
  function plugin(features: string[] = []) {
    const controller = createLayerController(testLayer([]), TEMPLATE)
    const gated = createLayerController({ ...testLayer([]), id: 'gated', label: 'Gated' }, 'LAYER:gated')
    const persisted: number[] = []
    const reconciled: Array<string | undefined> = []
    const p = createLayerPlugin({
      id: 'levels',
      group: 'Levels',
      layers: [
        { controller, description: 'test layer' },
        { controller: gated, description: 'gated layer', feature: 'levels2' }
      ]
    })
    const groups = p.register({
      hasFeature: (feature: string) => features.includes(feature),
      requestPersist: () => persisted.push(1),
      requestReconcile: (paneId?: string) => reconciled.push(paneId)
    } as unknown as PluginFacilities) as IndicatorGroup[]
    return { p, controller, gated, groups, persisted, reconciled }
  }

  test("one 'Levels' group on the price pane, every layer in it", () => {
    expect(plugin().groups).toEqual([
      {
        label: 'Levels',
        main: true,
        items: [
          { name: TEMPLATE, label: 'Test', description: 'test layer' },
          { name: 'LAYER:gated', label: 'Gated', description: 'gated layer' }
        ]
      }
    ])
  })

  test('claims its templates, their gear and their settings', () => {
    const { p } = plugin()
    expect(p.matches(TEMPLATE)).toBe(true)
    expect(p.matches('MA')).toBe(false)
    expect(p.ownsSettings?.(TEMPLATE)).toBe(true)
    expect(p.settings?.(TEMPLATE)?.fields).toBe(FIELDS)
    expect(p.settings?.('MA')).toBeNull()
  })

  test('an inline edit writes one pane, persists, relabels it', () => {
    const { p, controller, persisted, reconciled } = plugin()
    const ctx = { paneIndex: 1, indicator: { name: TEMPLATE } } as unknown as BindContext
    const before = p.signature?.(ctx)
    p.settings?.(TEMPLATE)?.write(1, 'p2', 'width', 4)
    expect(controller.configFor(1).width).toBe(4)
    expect(controller.configFor(0).width).toBe(1)
    expect(persisted).toHaveLength(1)
    expect(reconciled).toEqual(['p2'])
    expect(p.signature?.(ctx)).not.toEqual(before)
  })

  test('the wall document carries every layer by pane, then by layer id', () => {
    const { p } = plugin()
    p.settings?.(TEMPLATE)?.write(0, 'p1', 'width', 2)
    p.settings?.('LAYER:gated')?.write(0, 'p1', 'intervals.1M', false)
    p.settings?.('LAYER:gated')?.write(2, 'p3', 'width', 5)
    const snapshot = p.paneState?.snapshot()
    expect(snapshot).toEqual({ 0: { test: { width: 2 }, gated: { 'intervals.1M': false } }, 2: { gated: { width: 5 } } })

    const other = plugin()
    other.p.paneState?.hydrate(JSON.parse(JSON.stringify(snapshot)))
    expect(other.controller.configFor(0).width).toBe(2)
    expect(other.gated.configFor(0).intervals['1M']).toBe(false)
    expect(other.gated.configFor(2).width).toBe(5)
  })

  test('the legend names the timeframes drawn, or why nothing is', () => {
    const { p, controller } = plugin()
    const ctx = (ticker: string): BindContext =>
      ({
        paneIndex: 0,
        indicator: { name: TEMPLATE },
        symbol: { ticker, pricePrecision: 5 },
        vendor: 'oanda',
        ticker
      }) as unknown as BindContext
    const label = (ticker: string) => p.bind(ctx(ticker))?.label({ sources: [], chartInterval: '1h' })
    expect(label('EURUSD')).toBe('Test 1W 1M')
    expect(label('NONE')).toBe('Test · none for NONE')
    controller.setConfig(0, { ...DEFAULTS, intervals: { '1W': false, '1M': false } })
    expect(label('EURUSD')).toBe('Test · no timeframe chosen')
    expect(p.bind(ctx('EURUSD'))?.overrides).toEqual({ precision: 5 })
    expect(p.bind(ctx('EURUSD'))?.sources).toEqual([])
  })

  test('a layer whose feature the server does not advertise says so', () => {
    const ctx = { paneIndex: 0, indicator: { name: 'LAYER:gated' }, symbol: { ticker: 'EURUSD' }, vendor: 'oanda', ticker: 'EURUSD' }
    const label = (features: string[]) =>
      plugin(features).p.bind(ctx as unknown as BindContext)?.label({ sources: [], chartInterval: '1h' })
    expect(label([])).toBe('Gated · not served here')
    expect(label(['levels2'])).toBe('Gated 1W 1M')
  })
})
