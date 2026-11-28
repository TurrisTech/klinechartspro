import { afterEach, describe, expect, test } from 'bun:test'
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
const { rank85Strategy } = await import('./model')
const { FakeData, NOW, D, withRules } = await import('./testdata')
const { FX_DAY, FX_GRID } = await import('../time/timeframes')
const { peekStore } = await import('../plugins/store')
const { builtinPlugins } = await import('../builtins')
const { createLevelsIndicators } = await import('../levels/indicator')
const { LabSession } = await import('./session')

import type { ChartProPane, Period, SymbolInfo } from '../../src'
import type { Chart } from 'klinecharts'
import type { IndicatorPlugin } from '../plugins/types'
import type { SettingsField } from '../plugins/settings/settings'
import type { Strategy } from './model'
import type { StrategyPersistence } from './store'

const hosts: Array<{ teardown(): void }> = []
const stores: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const h of hosts.splice(0)) h.teardown()
  for (const s of stores.splice(0)) s.dispose()
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
  withRules(strategy, ['4h', '1h'], ['3m', '5m', '15m', '1h', '4h'])
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

// THE LAB PAGE HOLDS ONE STORE. The page edits its strategies through LabSession over a store,
// and its chart mounts the built-in plugins, this overlay among them (page.ts `mountLabChart`).
// Until 2026-11-28 the page made a store of its own while the overlay read the shared one: two
// stores reading the saved set, and every Save the page made was announced on the channel the
// other one listens on -- in the same page -- which read /preferences again before the debounced
// write had gone out, and so held the set as it stood BEFORE the save. The page hands its store
// to the built-ins now.

/** One stored set, as every tab of this browser sees it, written at once (as localStorage is);
 * each read of it is counted, by the store that made it. */
function storedSet() {
  const kept: Record<string, unknown> = {}
  const reads: string[] = []
  const persistence = (reader: string): StrategyPersistence => ({
    load: async () => {
      reads.push(reader)
      return structuredClone(kept)
    },
    save: (key, value) => {
      kept[key] = structuredClone(value)
    },
    remove: (key) => {
      delete kept[key]
    }
  })
  return { persistence, reads }
}

async function loadedStore(persistence: StrategyPersistence) {
  const store = new StrategyStore(persistence)
  stores.push(store)
  await store.load()
  return store
}

/** What a channel message takes to arrive, and the reload it starts to finish. */
const delivered = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

function named(name: string): Strategy {
  const s = rank85Strategy(NOW)
  s.name = name
  return s
}

/** The Lab page's chart as page.ts mounts it: the built-ins, given the page's store; the Lab's
 * overlay registered on a host. `offered` is what its gear lists -- the saved strategies it reads. */
async function labPageChart(store: InstanceType<typeof StrategyStore>) {
  let asked = 0
  const plugins = builtinPlugins(createLevelsIndicators().plugin, {
    strategies: async () => {
      asked++
      return store
    }
  })
  const lab = plugins.find((p) => p.id === 'lab') as IndicatorPlugin
  const host = await createPluginHost({ plugins: [lab], facilities: fakeFacilities() })
  hosts.push(host)
  const offered = (): string[] => {
    const field = host.settingsModel(LAB_TEMPLATE)?.fields[0] as Extract<SettingsField, { kind: 'select' }>
    return field.options.slice(1).map((o) => o.label)
  }
  return { offered, asked: () => asked }
}

describe('the Lab page holds one store', () => {
  test("the chart's overlay reads the page's store, so the saved set is read once", async () => {
    const { persistence, reads } = storedSet()
    const page = await loadedStore(persistence('page'))
    page.save(named('A'), NOW)
    const chart = await labPageChart(page)
    expect(chart.asked()).toBe(1)
    expect(chart.offered()).toEqual(['A'])
    expect(reads).toEqual(['page'])
  })

  test('a Save on the page is the overlay’s at once, and nothing on the page reads the set again', async () => {
    const { persistence, reads } = storedSet()
    const page = await loadedStore(persistence('page'))
    const chart = await labPageChart(page)
    const session = new LabSession({ store: page, data: new FakeData(), newData: () => new FakeData(), catalogue: null, clock: () => NOW }, { requested: null, remembered: null })
    session.rename('Mine')
    session.touch()
    session.save()
    await delivered()
    expect(chart.offered()).toEqual(['Mine'])
    // The page's store saved it and holds it: no store of this page heard its own save.
    expect(reads).toEqual(['page'])
  })

  test('a save in another tab is read once, and the open draft is not disturbed by it', async () => {
    const { persistence, reads } = storedSet()
    const page = await loadedStore(persistence('page'))
    const a = named('A')
    page.save(a, NOW - D)
    const chart = await labPageChart(page)
    const session = new LabSession({ store: page, data: new FakeData(), newData: () => new FakeData(), catalogue: null, clock: () => NOW }, { requested: null, remembered: null })
    const draft = session.current
    session.rename('A, being edited')
    session.touch()

    // Another tab of this browser saves the same strategy under another name.
    const other = await loadedStore(persistence('other tab'))
    other.save({ ...structuredClone(a), name: 'A, saved elsewhere' }, NOW)
    await delivered()
    expect(reads).toEqual(['page', 'other tab', 'page'])
    expect(chart.offered()).toEqual(['A, saved elsewhere'])
    // The editor's draft is the same object, edit and all, and differs from what is saved now.
    expect(session.current).toBe(draft)
    expect(draft.name).toBe('A, being edited')
    expect(session.unsaved(a.id)).toBe(true)

    // Saved here, the draft is what was saved -- a copy, so editing on changes nothing the
    // overlay reads.
    session.save()
    session.rename('A, edited after Save')
    expect(chart.offered()).toEqual(['A, being edited'])
    expect(page.get(a.id)?.name).toBe('A, being edited')
  })

  test('a Save on this page re-runs a pane showing that strategy at once, on the version saved', async () => {
    const { persistence } = storedSet()
    const page = await loadedStore(persistence('page'))
    const strategy = rank85Strategy(NOW)
    strategy.name = 'Before'
    withRules(strategy, ['4h', '1h'], ['3m', '5m', '15m', '1h', '4h'])
    page.save(strategy, NOW)
    const session = new LabSession({ store: page, data: new FakeData(), newData: () => new FakeData(), catalogue: null, clock: () => NOW }, { requested: null, remembered: null })

    const host = await createPluginHost({ plugins: [createLabPlugin({ store: async () => page, data: new FakeData(), now: () => NOW })], facilities: fakeFacilities({ periodToResolution: (p) => p.text }) })
    hosts.push(host)
    const fc = fakeChart()
    const bars: Array<{ timestamp: number }> = []
    for (let open = FX_GRID.start('1h', NOW - 10 * D); open < NOW; open = FX_GRID.nextStart('1h', open)) bars.push({ timestamp: FX_GRID.toWire('1h', open) })
    fc.data = bars
    fc.indicators = [fakeIndicator(LAB_TEMPLATE, 'i1')]
    host.sync([pane(fc.chart)])
    const legend = (): string => (fc.overrides.at(-1) as { shortName?: string } | undefined)?.shortName ?? ''
    const until = async (text: string): Promise<void> => {
      for (let waited = 0; waited < 10_000 && !legend().includes(text); waited += 20) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await until('entries')
    expect(legend()).toMatch(/^Strategy · Before · \d+ entries$/)
    const runKey = (fc.overrides.at(-1) as { extendData: { runKey: string } }).extendData.runKey

    session.rename('After')
    session.save()
    await until('After')
    expect(legend()).toMatch(/^Strategy · After · \d+ entries$/)
    expect(publishedRun(runKey)?.strategy.name).toBe('After')
  }, 40_000)
})
