import { afterEach, describe, expect, test } from 'bun:test'
import type { Chart, Indicator, OverlayCreate } from 'klinecharts'
import type { ChartProPane, IndicatorGroup } from '../../src'
import { fakeFacilities, fakePane, flush, installWindow } from '../plugins/testing'
import type { BindContext } from '../plugins/types'
import type { SettingsField } from './settings'
import type { ChartLayer } from './types'

// A chart layer as an indicator: drawn on a pane exactly while a binding of the layer's
// template lives there and the indicator is shown, with settings of its own per pane -- the
// view a binding attaches (controller.ts), and the plugin around it (plugin.ts) on the real
// plugin host, over a stand-in layer and chart so nothing is fetched.

installWindow()
const win = globalThis.window as unknown as Record<string, unknown>
win.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }

const { createLayerController } = await import('./controller')
const { createLayerPlugin } = await import('./plugin')
const { createPluginHost } = await import('../plugins/host')

const TEMPLATE = 'LAYER:test'
/** A view samples its pane every 200ms; a little over one period. */
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
    getIndicators: (filter?: { name?: string; id?: string }) =>
      state.indicators.filter(
        (indicator) => (!filter?.name || indicator.name === filter.name) && (!filter?.id || indicator.id === filter.id)
      ),
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
    unsubscribeAction: () => {},
    overrideIndicator: () => true,
    overrideYAxis: () => {}
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

/** One view, attached as a binding would attach it. */
function setup(config: Config = DEFAULTS, ticker = 'EURUSD') {
  const fetches: string[] = []
  const controller = createLayerController(testLayer(fetches), TEMPLATE)
  const chart = testChart()
  const pane: ChartProPane = fakePane('p1', chart.chart, ticker)
  let release = (): void => {}
  const attach = (next: Config = config): (() => void) => {
    release = controller.attach(pane, 'ind1', next)
    return release
  }
  cleanup.push(() => release())
  return { controller, chart, pane, fetches, attach }
}

function widths(chart: TestChart): number[] {
  return chart.overlays.map((overlay) => (overlay.styles as { line: { size: number } }).line.size)
}

describe('the view', () => {
  test('draws nothing while the indicator is hidden, and fetches nothing for it', async () => {
    const { chart, fetches, attach } = setup()
    chart.indicators.push(indicator(false))
    attach()
    await sleep(SAMPLE)
    expect(fetches).toEqual([])
    expect(chart.overlays).toEqual([])
  })

  test('draws at once; hiding it clears it; showing it reads again; releasing it clears it', async () => {
    const { chart, fetches, attach } = setup()
    chart.indicators.push(indicator())
    const release = attach()
    await flush()
    expect(fetches).toEqual(['EURUSD'])
    expect(chart.overlays.map((overlay) => overlay.groupId)).toEqual(['test'])

    chart.indicators[0] = indicator(false)
    await sleep(SAMPLE)
    expect(chart.overlays).toEqual([])

    // Back on: what it held was dropped when it went off, so this is a fresh read.
    chart.indicators[0] = indicator(true)
    await sleep(SAMPLE)
    expect(fetches).toEqual(['EURUSD', 'EURUSD'])
    expect(chart.overlays).toHaveLength(1)

    release()
    expect(chart.overlays).toEqual([])
  })

  test('the binding that replaces another starts from what the pane holds', async () => {
    const { chart, fetches, attach } = setup()
    chart.indicators.push(indicator())
    const first = attach()
    await flush()
    expect(widths(chart)).toEqual([1])

    // A style edit: the new view is attached before the old one is released, and repaints
    // from what the pane holds -- no request -- and the old one's release takes nothing with it.
    const second = attach({ ...DEFAULTS, width: 3 })
    first()
    await flush()
    expect(widths(chart)).toEqual([3])
    expect(fetches).toHaveLength(1)

    // A lever in the cache key reads again.
    attach({ ...DEFAULTS, intervals: { '1W': true, '1M': false } })
    second()
    await flush()
    expect(fetches).toHaveLength(2)
  })

  test('an instrument without coverage draws nothing, however the pane is set', async () => {
    const { chart, fetches, attach } = setup(DEFAULTS, 'NONE')
    chart.indicators.push(indicator())
    attach()
    await sleep(SAMPLE)
    expect(fetches).toEqual([])
    expect(chart.overlays).toEqual([])
  })

  test('a moved read clock forgets what every view holds and reads again', async () => {
    const { controller, chart, fetches, attach } = setup()
    chart.indicators.push(indicator())
    attach()
    await flush()
    controller.invalidate()
    await flush()
    expect(fetches).toEqual(['EURUSD', 'EURUSD'])
  })
})

describe('the plugin', () => {
  function plugin(features: string[] = []) {
    const fetches: string[] = []
    const controller = createLayerController(testLayer(fetches), TEMPLATE)
    const gated = createLayerController({ ...testLayer([]), id: 'gated', label: 'Gated' }, 'LAYER:gated')
    const p = createLayerPlugin({
      id: 'levels',
      group: 'Levels',
      layers: [
        { controller, description: 'test layer' },
        { controller: gated, description: 'gated layer', feature: 'levels2' }
      ]
    })
    return { p, controller, gated, fetches, features }
  }

  async function onHost(features: string[] = [], paneDocs: Record<number, Record<string, unknown>> = {}) {
    const parts = plugin(features)
    let persisted = 0
    const host = await createPluginHost({
      plugins: [parts.p],
      facilities: fakeFacilities({ hasFeature: (feature) => features.includes(feature) }),
      paneDocs,
      requestPersist: () => {
        persisted++
      }
    })
    const charts = [testChart(), testChart(), testChart()]
    const wall = charts.map((c, i) => fakePane(`p${i + 1}`, c.chart))
    cleanup.push(() => host.teardown())
    return { ...parts, host, charts, wall, persisted: () => persisted }
  }

  test("one 'Levels' group on the price pane, every layer in it", async () => {
    const groups = (await plugin().p.register(fakeFacilities())) as IndicatorGroup[]
    expect(groups).toEqual([
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

  test('claims its templates; the host owns their gear and their settings', async () => {
    const { p, host } = await onHost()
    expect(p.matches(TEMPLATE)).toBe(true)
    expect(p.matches('MA')).toBe(false)
    expect(host.ownsSettings(TEMPLATE)).toBe(true)
    expect(host.settingsModel(TEMPLATE)?.fields).toBe(FIELDS)
    expect(host.settingsModel('MA')).toBeNull()
  })

  test('draws only on the panes carrying it, and an inline edit restyles that pane alone', async () => {
    const { host, charts, wall, fetches, persisted } = await onHost()
    charts[1].indicators.push(indicator())
    host.sync(wall)
    await flush()
    expect(fetches).toHaveLength(1)
    expect(charts[0].overlays).toEqual([])
    expect(widths(charts[1])).toEqual([1])

    const model = host.settingsModel(TEMPLATE)
    model?.write('p2', 'width', 4)
    await flush()
    expect(widths(charts[1])).toEqual([4])
    expect(fetches).toHaveLength(1)
    expect(persisted()).toBe(1)
    expect(model?.read('p1')).toMatchObject({ width: 1 })
    // Normalised on the way in: the field's own bounds.
    model?.write('p2', 'width', 100)
    expect(model?.read('p2')).toMatchObject({ width: 8 })
  })

  test('the wall document carries every layer by pane, then by layer id', async () => {
    const { host, wall } = await onHost()
    host.sync(wall)
    host.settingsModel(TEMPLATE)?.write('p1', 'width', 2)
    host.settingsModel('LAYER:gated')?.write('p1', 'intervals.1M', false)
    host.settingsModel('LAYER:gated')?.write('p3', 'width', 5)
    const docs = host.paneDocs()
    expect(docs).toEqual({ 0: { ly: { test: { width: 2 }, gated: { 'intervals.1M': false } } }, 2: { ly: { gated: { width: 5 } } } })

    const other = await onHost([], JSON.parse(JSON.stringify(docs)))
    other.host.sync(other.wall)
    expect(other.host.settingsModel(TEMPLATE)?.read('p1')).toMatchObject({ width: 2 })
    expect(other.host.settingsModel('LAYER:gated')?.read('p1')).toMatchObject({ intervals: { '1M': false } })
    expect(other.host.settingsModel('LAYER:gated')?.read('p3')).toMatchObject({ width: 5 })
    expect(other.host.settingsModel(TEMPLATE)?.read('p2')).toEqual(DEFAULTS)
  })

  test('the legend names the timeframes drawn, or why nothing is', () => {
    const { p } = plugin()
    void p.register(fakeFacilities({ hasFeature: () => false }))
    const ctx = (ticker: string, config: Config = DEFAULTS): BindContext =>
      ({
        paneIndex: 0,
        indicator: { name: TEMPLATE },
        symbol: { ticker, pricePrecision: 5 },
        vendor: 'oanda',
        ticker,
        config
      }) as unknown as BindContext
    const label = (ticker: string, config?: Config) => p.bind(ctx(ticker, config))?.label({ sources: [], chartInterval: '1h' })
    expect(label('EURUSD')).toBe('Test 1W 1M')
    expect(label('NONE')).toBe('Test · none for NONE')
    expect(label('EURUSD', { ...DEFAULTS, intervals: { '1W': false, '1M': false } })).toBe('Test · no timeframe chosen')
    expect(p.bind(ctx('EURUSD'))?.overrides).toEqual({ precision: 5 })
    expect(p.bind(ctx('EURUSD'))?.sources).toEqual([])
  })

  test('a layer whose feature the server does not advertise says so', async () => {
    const ctx = { paneIndex: 0, indicator: { name: 'LAYER:gated' }, symbol: { ticker: 'EURUSD' }, vendor: 'oanda', ticker: 'EURUSD', config: DEFAULTS }
    const label = async (features: string[]) => {
      const { p } = plugin(features)
      await p.register(fakeFacilities({ hasFeature: (feature) => features.includes(feature) }))
      return p.bind(ctx as unknown as BindContext)?.label({ sources: [], chartInterval: '1h' })
    }
    expect(await label([])).toBe('Gated · not served here')
    expect(await label(['levels2'])).toBe('Gated 1W 1M')
  })
})
