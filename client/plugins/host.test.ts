import { afterEach, describe, expect, test } from 'bun:test'
import type { IndicatorGroup } from '../../src'
import { installWindow } from './testing'

installWindow()
const { createPluginHost } = await import('./host')
const { peekStore, WindowStore } = await import('./store')
const { fakeChart, fakeIndicator, fakePane, flush } = await import('./testing')

import type { HostFacilities } from './host'
import type { BindContext, IndicatorPlugin, Page, PluginFacilities, Range, SourceSpec } from './types'

type Point = { date: number; v: number }

function facilities(): HostFacilities {
  return {
    api: { get: async () => ({}) as never, url: () => new URL('http://test/') },
    stream: {} as PluginFacilities['stream'],
    hasFeature: () => true,
    points: async () => ({ points: [], nextFrom: null }),
    periodToResolution: (p) => p.text,
    resolutionDurationMs: () => 3_600_000,
    symbolVendor: () => 'oanda',
    openSettingsPanel: () => ({ close() {} }) as never,
    requestPersist: () => {},
    maxValuesPerRequest: 3,
    signals: { catalogue: async () => [], points: async () => ({ points: [], nextFrom: null }) }
  }
}

/** A plugin whose one source serves `data`, paged at the host's cap. */
function pointsPlugin(data: Point[], opts: { subscribe?: SourceSpec<Point>['subscribe']; label?: string } = {}) {
  const fetches: Range[] = []
  const plugin: IndicatorPlugin = {
    id: 'pts',
    feature: null,
    register: (): IndicatorGroup[] => [{ label: 'pts', main: false, items: [{ name: 'PTS', label: 'pts' }] }],
    matches: (name) => name === 'PTS',
    bind: (ctx: BindContext) => ({
      sources: [
        {
          id: 'v',
          key: `pts|${ctx.ticker}|${ctx.interval}|${JSON.stringify(ctx.indicator.calcParams)}`,
          createStore: (k) => new WindowStore<Point, number>(k, (p) => p.v),
          fetch: async (range, limit): Promise<Page<Point>> => {
            fetches.push({ ...range })
            const pts = data.filter((p) => p.date >= range.from && p.date < range.to).slice(0, limit)
            const last = pts[pts.length - 1]
            return { points: pts, nextFrom: pts.length >= limit && last ? last.date + 1 : null }
          },
          subscribe: opts.subscribe
        }
      ],
      label: (state) => `${opts.label ?? 'PTS'} · ${state.sources[0]?.store.phase}`,
      yAxisGap: { top: 0.1, bottom: 0.05 }
    })
  }
  return { plugin, fetches }
}

const hosts: Array<{ teardown(): void }> = []
afterEach(() => {
  for (const h of hosts.splice(0)) h.teardown()
})

describe('createPluginHost', () => {
  test('registers only plugins whose feature is advertised, and collects their groups', async () => {
    const f = facilities()
    f.hasFeature = (feature) => feature === 'arev'
    const on: IndicatorPlugin = { id: 'on', feature: 'arev', register: () => [{ label: 'on', main: false, items: [] }], matches: () => false, bind: () => null }
    const off: IndicatorPlugin = { id: 'off', feature: 'krev', register: () => [{ label: 'off', main: false, items: [] }], matches: () => false, bind: () => null }
    const host = await createPluginHost({ plugins: [on, off], facilities: f })
    hosts.push(host)
    expect(host.plugins.map((p) => p.id)).toEqual(['on'])
    expect(host.groups.map((g) => g.label)).toEqual(['on'])
    expect(host.validateParams).toBeNull()
  })

  test('a plugin that fails to register is skipped, not fatal', async () => {
    const bad: IndicatorPlugin = {
      id: 'bad',
      feature: null,
      register: () => {
        throw new Error('no catalogue')
      },
      matches: () => false,
      bind: () => null
    }
    const { plugin } = pointsPlugin([])
    const host = await createPluginHost({ plugins: [bad, plugin], facilities: facilities() })
    hosts.push(host)
    expect(host.plugins.map((p) => p.id)).toEqual(['pts'])
  })

  test('binds a claimed indicator, fetches the chart range in pages, and applies extendData', async () => {
    const data = [1, 2, 3, 4, 5].map((d) => ({ date: d, v: d * 10 }))
    const { plugin, fetches } = pointsPlugin(data)
    const host = await createPluginHost({ plugins: [plugin], facilities: facilities() })
    hosts.push(host)
    const fc = fakeChart()
    fc.data = [1, 2, 3, 4, 5].map((timestamp) => ({ timestamp }))
    fc.indicators = [fakeIndicator('PTS', 'i1'), fakeIndicator('MA', 'i2')]
    host.sync([fakePane('p1', fc.chart)])
    await flush()
    await flush()
    // Two pages at a cap of 3: [1,6) -> 1,2,3 then continue from 4.
    expect(fetches).toEqual([
      { from: 1, to: 6 },
      { from: 4, to: 6 }
    ])
    const last = fc.overrides[fc.overrides.length - 1] as { extendData: { seriesKey: string; rev: number }; shortName: string; id: string }
    expect(last.id).toBe('i1')
    expect(last.shortName).toBe('PTS · ready')
    const store = peekStore<InstanceType<typeof WindowStore<Point, number>>>(last.extendData.seriesKey)
    expect(store).toBeDefined()
    expect([...(store?.values.entries() ?? [])]).toEqual([
      [1, 10],
      [2, 20],
      [3, 30],
      [4, 40],
      [5, 50]
    ])
    expect(fc.yAxisOverrides).toEqual([{ paneId: 'candle_pane', gap: { top: 0.1, bottom: 0.05 } }])
    // The unclaimed MA was never touched.
    expect(fc.overrides.every((o) => o.id === 'i1')).toBe(true)
  })

  test('a range change fetches only what the store is missing', async () => {
    const data = Array.from({ length: 20 }, (_, i) => ({ date: i, v: i }))
    const { plugin, fetches } = pointsPlugin(data)
    const f = facilities()
    f.maxValuesPerRequest = 100
    const host = await createPluginHost({ plugins: [plugin], facilities: f })
    hosts.push(host)
    const fc = fakeChart()
    fc.data = [5, 6, 7].map((timestamp) => ({ timestamp }))
    fc.indicators = [fakeIndicator('PTS', 'i1')]
    host.sync([fakePane('p1', fc.chart)])
    await flush()
    expect(fetches).toEqual([{ from: 5, to: 8 }])
    fc.data = [3, 4, 5, 6, 7, 8, 9].map((timestamp) => ({ timestamp }))
    fc.fireRange()
    await new Promise((r) => setTimeout(r, 300))
    expect(fetches.slice(1)).toEqual([
      { from: 3, to: 5 },
      { from: 8, to: 10 }
    ])
  })

  test('two panes reading one source share a store, dropped with the last of them', async () => {
    const { plugin } = pointsPlugin([{ date: 1, v: 1 }])
    const host = await createPluginHost({ plugins: [plugin], facilities: facilities() })
    hosts.push(host)
    const a = fakeChart()
    const b = fakeChart()
    for (const fc of [a, b]) {
      fc.data = [{ timestamp: 1 }]
      fc.indicators = [fakeIndicator('PTS', 'i1')]
    }
    host.sync([fakePane('p1', a.chart), fakePane('p2', b.chart)])
    await flush()
    const key = (a.overrides[0] as { extendData: { seriesKey: string } }).extendData.seriesKey
    expect((b.overrides[0] as { extendData: { seriesKey: string } }).extendData.seriesKey).toBe(key)
    host.sync([fakePane('p1', a.chart)])
    expect(peekStore(key)).toBeDefined()
    host.sync([])
    expect(peekStore(key)).toBeUndefined()
  })

  test('changed params rebind; a removed indicator releases its store', async () => {
    const { plugin, fetches } = pointsPlugin([{ date: 1, v: 1 }])
    const host = await createPluginHost({ plugins: [plugin], facilities: facilities() })
    hosts.push(host)
    const fc = fakeChart()
    fc.data = [{ timestamp: 1 }]
    fc.indicators = [fakeIndicator('PTS', 'i1', [5])]
    const pane = fakePane('p1', fc.chart)
    host.sync([pane])
    await flush()
    const first = (fc.overrides[0] as { extendData: { seriesKey: string } }).extendData.seriesKey
    fc.indicators = [fakeIndicator('PTS', 'i1', [9])]
    await new Promise((r) => setTimeout(r, 600)) // the reconcile poll
    const keys = new Set(fc.overrides.map((o) => (o as { extendData: { seriesKey: string } }).extendData.seriesKey))
    expect(keys.size).toBe(2)
    expect(peekStore(first)).toBeUndefined()
    expect(fetches.length).toBe(2)
    fc.indicators = []
    await new Promise((r) => setTimeout(r, 600))
    expect([...keys].every((k) => peekStore(k) === undefined)).toBe(true)
  })

  test('subscribe runs at bind and its disposer at release; notify.changed re-applies', async () => {
    let disposed = 0
    let notifyChanged: (() => void) | null = null
    const { plugin } = pointsPlugin([], {
      subscribe: (store, notify) => {
        notifyChanged = () => {
          store.setPhase('ready')
          ;(store as InstanceType<typeof WindowStore<Point, number>>).set({ date: 7, v: 70 })
          notify.changed()
        }
        return () => {
          disposed++
        }
      }
    })
    const host = await createPluginHost({ plugins: [plugin], facilities: facilities() })
    hosts.push(host)
    const fc = fakeChart()
    fc.data = [{ timestamp: 1 }]
    fc.indicators = [fakeIndicator('PTS', 'i1')]
    host.sync([fakePane('p1', fc.chart)])
    await flush()
    const before = fc.overrides.length
    ;(notifyChanged as unknown as () => void)()
    expect(fc.overrides.length).toBe(before + 1)
    host.sync([])
    expect(disposed).toBe(1)
  })

  test('a replaying page records the phase and retries', async () => {
    let calls = 0
    const plugin: IndicatorPlugin = {
      id: 'slow',
      feature: null,
      register: () => [],
      matches: (name) => name === 'SLOW',
      bind: () => ({
        sources: [
          {
            id: 'v',
            key: 'slow',
            fetch: async (): Promise<Page<Point>> => {
              calls++
              if (calls === 1) return { points: [], nextFrom: null, status: { phase: 'replaying', progress: 0.5, retryAfterMs: 1 } }
              return { points: [{ date: 1, v: 1 }], nextFrom: null }
            }
          }
        ],
        label: (state) => `SLOW · ${state.sources[0]?.store.phase}`
      })
    }
    const host = await createPluginHost({ plugins: [plugin], facilities: facilities() })
    hosts.push(host)
    const fc = fakeChart()
    fc.data = [{ timestamp: 1 }]
    fc.indicators = [fakeIndicator('SLOW', 'i1')]
    host.sync([fakePane('p1', fc.chart)])
    await flush()
    expect(fc.overrides.some((o) => o.shortName === 'SLOW · replaying')).toBe(true)
    await new Promise((r) => setTimeout(r, 700))
    expect(calls).toBe(2)
    expect(fc.overrides[fc.overrides.length - 1]?.shortName).toBe('SLOW · ready')
  })

  test('settings, validation and pane state are dispatched to the plugin that claims the name', async () => {
    const state: Record<number, unknown> = {}
    const plugin: IndicatorPlugin = {
      id: 'cfg',
      feature: null,
      register: () => [],
      matches: (name) => name === 'CFG',
      bind: () => null,
      handleSettings: (request) => request.paneId === 'p1',
      validateParams: async (request) => ({ ok: request.calcParams[0] !== 0, reason: 'zero' }),
      paneState: {
        hydrate: (initial) => Object.assign(state, initial),
        snapshot: () => ({ ...state })
      }
    }
    const host = await createPluginHost({ plugins: [plugin], facilities: facilities(), paneState: { cfg: { 0: { a: 1 } } } })
    hosts.push(host)
    expect(host.handleSettings({ indicatorName: 'CFG', paneId: 'p1', chartPaneId: 'candle_pane', calcParams: [] })).toBe(true)
    expect(host.handleSettings({ indicatorName: 'MA', paneId: 'p1', chartPaneId: 'candle_pane', calcParams: [] })).toBe(false)
    expect(host.validateParams).not.toBeNull()
    const check = await host.validateParams?.({ indicatorName: 'CFG', calcParams: [0], symbol: {} as never, period: {} as never })
    expect(check).toEqual({ ok: false, reason: 'zero' })
    expect(await host.validateParams?.({ indicatorName: 'MA', calcParams: [0], symbol: {} as never, period: {} as never })).toEqual({ ok: true })
    expect(host.paneState()).toEqual({ cfg: { 0: { a: 1 } } })
  })
})
