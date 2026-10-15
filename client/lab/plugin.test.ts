import { afterEach, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// A saved strategy on a dashboard pane, through the real plugin host: the pane's indicator is
// bound, the strategy runs over the pane's loaded span on its instrument, the run is published
// under the source key the template reads, and the legend says what it found.
installWindow()
const { createPluginHost } = await import('../plugins/host')
const { fakeChart, fakeFacilities, fakeIndicator, flush } = await import('../plugins/testing')
const { createLabPlugin, RunStore } = await import('./plugin')
const { LAB_TEMPLATE, publishedRun } = await import('./overlay')
const { StrategyStore } = await import('./store')
const { rank85Strategy, defaultStep } = await import('./model')
const { FakeData, NOW, D } = await import('./testdata')
const { FX_DAY, FX_GRID } = await import('../replay/timeframes')
const { peekStore } = await import('../plugins/store')

import type { ChartProPane, Period, SymbolInfo } from '../../src'
import type { Chart } from 'klinecharts'

const hosts: Array<{ teardown(): void }> = []
afterEach(() => {
  for (const h of hosts.splice(0)) h.teardown()
})

function pane(chart: Chart): ChartProPane {
  // An FX instrument WITH its schedule: the plugin places nothing without one.
  const symbol = { ticker: 'EURUSD', exchange: 'oanda', pricePrecision: 5, timezone: 'America/New_York', dayGeometry: FX_DAY } as unknown as SymbolInfo
  const period: Period = { multiplier: 1, timespan: 'hour', text: '1h' }
  return {
    id: 'p1',
    getChart: () => chart,
    getSymbol: () => symbol,
    setSymbol: () => {},
    getPeriod: () => period,
    setPeriod: () => {},
    getDatafeed: () => null as never,
    seekTo: () => {},
    isActive: () => true
  }
}

test('a pane carrying LAB:strategy runs the latest saved strategy over its span', async () => {
  const store = new StrategyStore({ load: async () => ({}), save: () => {}, remove: () => {} })
  await store.load()
  const strategy = rank85Strategy(NOW)
  strategy.name = 'Rank 85, 1h + 4h roots'
  strategy.sources[0].timeframes = ['3m', '5m', '15m', '1h', '4h']
  strategy.graph.roots = ['4h', '1h']
  strategy.graph.step = defaultStep(8)
  store.save(strategy, NOW)

  const plugin = createLabPlugin({ store: async () => store, data: new FakeData(), now: () => NOW })
  const host = await createPluginHost({ plugins: [plugin], facilities: fakeFacilities({ periodToResolution: (p) => p.text }) })
  hosts.push(host)
  expect(host.groups.map((g) => g.items.map((i) => i.name))).toEqual([[LAB_TEMPLATE]])

  const fc = fakeChart()
  // Ten days of 1h bars, by their wire dates (the chart's own timestamps).
  const bars: Array<{ timestamp: number }> = []
  for (let open = FX_GRID.start('1h', NOW - 10 * D); open < NOW; open = FX_GRID.nextStart('1h', open)) bars.push({ timestamp: FX_GRID.toWire('1h', open) })
  fc.data = bars
  fc.indicators = [fakeIndicator(LAB_TEMPLATE, 'i1')]
  host.sync([pane(fc.chart)])
  // A run reads and computes asynchronously: wait for the legend to say what it found.
  for (let waited = 0; waited < 30_000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    const shown = fc.overrides.at(-1) as { shortName?: string } | undefined
    if (shown?.shortName?.includes('entries') || shown?.shortName?.includes('error')) break
  }
  const last = fc.overrides.at(-1) as { extendData: { runKey: string; seriesKey: string; chartInterval: string }; shortName: string }
  expect(last.shortName).toMatch(/^Strategy · Rank 85, 1h \+ 4h roots · \d+ entries$/)
  expect(last.extendData.runKey).toBe(last.extendData.seriesKey)
  expect(last.extendData.chartInterval).toBe('1h')
  const run = publishedRun(last.extendData.runKey)
  expect(run?.strategy.id).toBe(strategy.id)
  expect(run?.graphs.length).toBeGreaterThan(0)
  // The run covers the pane's loaded span, from its first bar.
  const held = peekStore<InstanceType<typeof RunStore>>(last.extendData.seriesKey)
  expect(held?.span?.from).toBe(FX_GRID.fromWire('1h', bars[0].timestamp))
  store.dispose()
}, 40_000)

test('with nothing saved, the legend says where to make one', async () => {
  const store = new StrategyStore({ load: async () => ({}), save: () => {}, remove: () => {} })
  await store.load()
  const host = await createPluginHost({ plugins: [createLabPlugin({ store: async () => store, data: new FakeData() })], facilities: fakeFacilities() })
  hosts.push(host)
  const fc = fakeChart()
  fc.data = [{ timestamp: NOW - D }]
  fc.indicators = [fakeIndicator(LAB_TEMPLATE, 'i1')]
  host.sync([pane(fc.chart)])
  await flush()
  await flush()
  const last = fc.overrides.at(-1) as { shortName: string }
  expect(last.shortName).toBe('Strategy · none saved yet: open the Strategy Lab')
  store.dispose()
})
