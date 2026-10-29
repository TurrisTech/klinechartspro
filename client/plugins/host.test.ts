import { afterEach, describe, expect, test } from 'bun:test'
import type { IndicatorGroup } from '../../src'
import { installWindow } from './testing'

installWindow()
const { createPluginHost } = await import('./host')
const { peekStore, WindowStore } = await import('./store')
const { fakeChart, fakeFacilities, fakeIndicator, fakePane, flush } = await import('./testing')
const { paneConfig } = await import('./paneconfig')

import type { SettingsPanelOptions } from '../chartlayers/settings'
import type { BindContext, IndicatorPlugin, Page, Range, SourceNotify, SourceSpec, SourceStore } from './types'

type Point = { date: number; v: number }

const facilities = fakeFacilities

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

  test('bars replaced whole are covered at once; a page of history waits out the debounce', async () => {
    const data = Array.from({ length: 30 }, (_, i) => ({ date: i, v: i }))
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
    // A reload at a later cursor (a replay's long jump): both ends moved.
    fc.data = [20, 21, 22].map((timestamp) => ({ timestamp }))
    fc.fireRange()
    await flush()
    expect(fetches.slice(1)).toEqual([{ from: 20, to: 23 }])
    // A page of older bars: one end moved, as a pan's stream of them does.
    fc.data = [17, 18, 19, 20, 21, 22].map((timestamp) => ({ timestamp }))
    fc.fireRange()
    await flush()
    expect(fetches).toHaveLength(2)
    await new Promise((r) => setTimeout(r, 300))
    expect(fetches.slice(2)).toEqual([{ from: 17, to: 20 }])
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

  test('what a plugin follows on the chart is part of the binding: a change there rebinds', async () => {
    // PTS follows the params of an OTHER indicator on its chart, as TradeTalk entries follows
    // Heath levels. An edit of that one must rebind PTS, which is handed the new answer.
    const { plugin: base } = pointsPlugin([{ date: 1, v: 1 }])
    const followed: unknown[] = []
    const plugin: IndicatorPlugin = {
      ...base,
      follows: (_ind, indicators) => indicators.find((other) => other.name === 'OTHER')?.calcParams ?? null,
      bind: (ctx) => {
        followed.push(ctx.follows)
        return base.bind(ctx)
      }
    }
    const host = await createPluginHost({ plugins: [plugin], facilities: facilities() })
    hosts.push(host)
    const fc = fakeChart()
    fc.data = [{ timestamp: 1 }]
    fc.indicators = [fakeIndicator('PTS', 'i1', [5]), fakeIndicator('OTHER', 'o1', [1])]
    host.sync([fakePane('p1', fc.chart)])
    await flush()
    expect(followed).toEqual([[1]])
    await new Promise((r) => setTimeout(r, 600)) // a reconcile with nothing changed binds nothing
    expect(followed).toEqual([[1]])
    fc.indicators = [fakeIndicator('PTS', 'i1', [5]), fakeIndicator('OTHER', 'o1', [2])]
    await new Promise((r) => setTimeout(r, 600))
    expect(followed).toEqual([[1], [2]])
    fc.indicators = [fakeIndicator('PTS', 'i1', [5])]
    await new Promise((r) => setTimeout(r, 600))
    expect(followed).toEqual([[1], [2], null])
  })

  test('a settings rebind that keeps a source keeps its store reachable by key', async () => {
    // A settings edit (mtf, the AREV lab) rebinds onto the same keys. The store must survive
    // the hand-over under its key, or the template's peekStore finds nothing and the pane goes
    // blank.
    const { plugin: base, fetches } = pointsPlugin([{ date: 1, v: 1 }])
    const plugin: IndicatorPlugin = { ...base, paneConfigs: [SIZE_CONFIG('PTS')] }
    const host = await createPluginHost({ plugins: [plugin], facilities: facilities() })
    hosts.push(host)
    const fc = fakeChart()
    fc.data = [{ timestamp: 1 }]
    fc.indicators = [fakeIndicator('PTS', 'i1', [5])]
    host.sync([fakePane('p1', fc.chart)])
    await flush()
    const key = (fc.overrides[0] as { extendData: { seriesKey: string } }).extendData.seriesKey
    const store = peekStore(key)
    expect(store?.size).toBe(1)
    const applied = fc.overrides.length
    host.settingsModel('PTS')?.write('p1', 'size', 4)
    // Rebound at once (the new binding re-applies), onto the same store, with nothing refetched.
    expect(fc.overrides.length).toBeGreaterThan(applied)
    expect(peekStore(key)).toBe(store)
    await flush()
    expect(fetches.length).toBe(1)
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
    // A burst of live points is one re-apply -- one recalculation -- not one each.
    ;(notifyChanged as unknown as () => void)()
    ;(notifyChanged as unknown as () => void)()
    await flush()
    expect(fc.overrides.length).toBe(before + 1)
    host.sync([])
    expect(disposed).toBe(1)
  })

  test('two panes reading one store fetch what they share once, and both are re-applied', async () => {
    const data = Array.from({ length: 40 }, (_, i) => ({ date: i, v: i }))
    const fetches: Range[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const plugin: IndicatorPlugin = {
      id: 'shared',
      feature: null,
      register: () => [],
      matches: (name) => name === 'SH',
      bind: () => ({
        sources: [
          {
            id: 'v',
            key: 'shared|EURUSD|1h',
            createStore: (k) => new WindowStore<Point, number>(k, (p) => p.v),
            fetch: async (range): Promise<Page<Point>> => {
              fetches.push({ ...range })
              await gate
              return { points: data.filter((p) => p.date >= range.from && p.date < range.to), nextFrom: null }
            }
          }
        ],
        label: () => 'SH'
      })
    }
    const f = facilities()
    f.maxValuesPerRequest = 100
    const host = await createPluginHost({ plugins: [plugin], facilities: f })
    hosts.push(host)
    const a = fakeChart()
    const b = fakeChart()
    a.data = Array.from({ length: 20 }, (_, i) => ({ timestamp: i + 10 }))
    b.data = Array.from({ length: 20 }, (_, i) => ({ timestamp: i + 20 }))
    a.indicators = [fakeIndicator('SH', 'a')]
    b.indicators = [fakeIndicator('SH', 'b')]
    host.sync([fakePane('p1', a.chart), fakePane('p2', b.chart)])
    await flush()
    // The second pane asked only for what the first was not already fetching.
    expect(fetches).toEqual([
      { from: 10, to: 30 },
      { from: 30, to: 40 }
    ])
    release()
    await host.settled()
    const rev = (fc: typeof a) => (fc.indicators[0].extendData as { rev: number } | undefined)?.rev
    const key = (fc: typeof a) => (fc.indicators[0].extendData as { seriesKey: string }).seriesKey
    const store = peekStore<InstanceType<typeof WindowStore<Point, number>>>(key(a))
    expect(store?.size).toBe(30)
    // Both panes were handed the store's latest revision, whichever of them fetched it (a
    // binding's rev is its own sequence number folded with its stores' revs).
    expect((rev(a) as number) % 1_000_003).toBe(store?.rev as number)
    expect((rev(b) as number) % 1_000_003).toBe(store?.rev as number)
  })

  // A live cue says the producer has written something since the last read. A fetch already in
  // flight was asked before that write, so it cannot answer the cue -- yet its answer is filed as
  // covering the range, and a cue that merely waited for it was lost until the next one. On prod
  // the timeframes of one close arrive ~100 ms apart and a re-read takes 100-300 ms, so the
  // second timeframe's cue routinely lands inside the first one's read.
  test('a refetch asked while an older fetch is in flight reads again once that one lands', async () => {
    const data: Point[] = [1, 2, 3, 4, 5].map((d) => ({ date: d, v: d }))
    const fetches: Range[] = []
    let gate: Promise<void> = Promise.resolve()
    // The binding's notify, once it has subscribed.
    const cue = { refetch: (): void => {} }
    const plugin: IndicatorPlugin = {
      id: 'cue',
      feature: null,
      register: () => [],
      matches: (name) => name === 'CUE',
      bind: () => ({
        sources: [
          {
            id: 'v',
            key: 'cue|EURUSD|5m',
            createStore: (k) => new WindowStore<Point, number>(k, (p) => p.v),
            fetch: async (range): Promise<Page<Point>> => {
              fetches.push({ ...range })
              // Answered from what the producer had written when the request arrived.
              const answer = data.filter((p) => p.date >= range.from && p.date < range.to)
              await gate
              return { points: answer, nextFrom: null }
            },
            subscribe: (_store: SourceStore<Point>, n: SourceNotify) => {
              cue.refetch = () => n.refetch()
              return () => {}
            }
          }
        ],
        label: () => 'CUE'
      })
    }
    const f = facilities()
    f.maxValuesPerRequest = 100
    const host = await createPluginHost({ plugins: [plugin], facilities: f })
    hosts.push(host)
    const fc = fakeChart()
    fc.data = Array.from({ length: 9 }, (_, i) => ({ timestamp: i + 1 }))
    fc.indicators = [fakeIndicator('CUE', 'i1')]
    host.sync([fakePane('p1', fc.chart)])
    await host.settled()
    const key = (fc.indicators[0].extendData as { seriesKey: string }).seriesKey
    const store = peekStore<InstanceType<typeof WindowStore<Point, number>>>(key)
    expect(fetches).toEqual([{ from: 1, to: 10 }])

    let release: () => void = () => {}
    gate = new Promise<void>((resolve) => (release = resolve))
    // The first timeframe's cue: forget the tail, read it again -- in flight.
    store?.forgetAfter(6)
    cue.refetch()
    await flush()
    // The second timeframe is written, and its cue arrives while that read is still out.
    data.push({ date: 7, v: 70 })
    store?.forgetAfter(6)
    cue.refetch()
    await flush()
    release()
    await host.settled()

    expect(store?.values.get(7)).toBe(70)
    expect(fetches).toEqual([
      { from: 1, to: 10 },
      { from: 6, to: 10 },
      { from: 6, to: 10 }
    ])
  })

  test('a burst of refetches inside one read costs one more read, not one each', async () => {
    const fetches: Range[] = []
    let gate: Promise<void> = Promise.resolve()
    // The binding's notify, once it has subscribed.
    const cue = { refetch: (): void => {} }
    const plugin: IndicatorPlugin = {
      id: 'burst',
      feature: null,
      register: () => [],
      matches: (name) => name === 'BURST',
      bind: () => ({
        sources: [
          {
            id: 'v',
            key: 'burst|EURUSD|5m',
            createStore: (k) => new WindowStore<Point, number>(k, (p) => p.v),
            fetch: async (range): Promise<Page<Point>> => {
              fetches.push({ ...range })
              await gate
              return { points: [], nextFrom: null }
            },
            subscribe: (_store: SourceStore<Point>, n: SourceNotify) => {
              cue.refetch = () => n.refetch()
              return () => {}
            }
          }
        ],
        label: () => 'BURST'
      })
    }
    const host = await createPluginHost({ plugins: [plugin], facilities: facilities() })
    hosts.push(host)
    const fc = fakeChart()
    fc.data = Array.from({ length: 9 }, (_, i) => ({ timestamp: i + 1 }))
    fc.indicators = [fakeIndicator('BURST', 'i1')]
    host.sync([fakePane('p1', fc.chart)])
    await host.settled()
    const key = (fc.indicators[0].extendData as { seriesKey: string }).seriesKey
    const store = peekStore<InstanceType<typeof WindowStore<Point, number>>>(key)

    let release: () => void = () => {}
    gate = new Promise<void>((resolve) => (release = resolve))
    store?.forgetAfter(6)
    cue.refetch()
    await flush()
    // Four more timeframes close inside that read.
    for (let i = 0; i < 4; i++) {
      store?.forgetAfter(6)
      cue.refetch()
    }
    await flush()
    gate = Promise.resolve()
    release()
    await host.settled()
    expect(fetches.slice(1)).toEqual([
      { from: 6, to: 10 },
      { from: 6, to: 10 }
    ])
  })

  test('two panes on one store hearing one cue still read once', async () => {
    const fetches: Range[] = []
    let gate: Promise<void> = Promise.resolve()
    const notifies: Array<{ refetch(): void }> = []
    const plugin: IndicatorPlugin = {
      id: 'pair',
      feature: null,
      register: () => [],
      matches: (name) => name === 'PAIR',
      bind: () => ({
        sources: [
          {
            id: 'v',
            key: 'pair|EURUSD|1h',
            createStore: (k) => new WindowStore<Point, number>(k, (p) => p.v),
            fetch: async (range): Promise<Page<Point>> => {
              fetches.push({ ...range })
              await gate
              return { points: [], nextFrom: null }
            },
            subscribe: (_store: SourceStore<Point>, n: SourceNotify) => {
              notifies.push(n)
              return () => {}
            }
          }
        ],
        label: () => 'PAIR'
      })
    }
    const host = await createPluginHost({ plugins: [plugin], facilities: facilities() })
    hosts.push(host)
    const a = fakeChart()
    const b = fakeChart()
    a.data = b.data = Array.from({ length: 9 }, (_, i) => ({ timestamp: i + 1 }))
    a.indicators = [fakeIndicator('PAIR', 'a')]
    b.indicators = [fakeIndicator('PAIR', 'b')]
    host.sync([fakePane('p1', a.chart), fakePane('p2', b.chart)])
    await host.settled()
    const key = (a.indicators[0].extendData as { seriesKey: string }).seriesKey
    const store = peekStore<InstanceType<typeof WindowStore<Point, number>>>(key)
    const before = fetches.length

    let release: () => void = () => {}
    gate = new Promise<void>((resolve) => (release = resolve))
    // One stream message, both panes' listeners, in one task: the first one's read was sent
    // after the cue arrived, so the second one's waits for it.
    for (const n of notifies) {
      store?.forgetAfter(6)
      n.refetch()
    }
    await flush()
    release()
    await host.settled()
    expect(notifies.length).toBe(2)
    expect(fetches.slice(before)).toEqual([{ from: 6, to: 10 }])
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

  // The replay's read clock (services/asof.py) answers only what had CLOSED by the cursor,
  // so an answer taken at the cursor is missing the bar each source still has forming. The
  // host has to forget that much and no less, PER SOURCE, or that bar stays filed as
  // fetched-and-empty and draws as a permanent hole -- one per stop. It shows only when the
  // cursor stops off the source's own grid, which is every stop for a source coarser than
  // the finest armed signal: at 11:15 a 15m source is whole and a 1h one is a bar short.
  test('a step forgets each source through ITS OWN forming bar, not through the cursor', async () => {
    const HOUR = 3_600_000
    const NY = (day: number, hour: number, minute = 0) => Date.UTC(2024, 2, day, hour + 5, minute)
    // Every 1h bar of Wednesday's session, from the 17:00 open.
    const all: Point[] = Array.from({ length: 24 }, (_, i) => ({ date: NY(5, 17) + i * HOUR, v: i }))

    let clock = NY(6, 9)
    const plugin: IndicatorPlugin = {
      id: 'clamped',
      feature: null,
      register: () => [],
      matches: (name) => name === 'CLAMPED',
      bind: () => ({
        sources: [
          {
            id: 'v',
            key: 'clamped|1h',
            resolution: '1h',
            fetch: async (range): Promise<Page<Point>> => ({
              // The server's clamp: a point exists once its bar has closed.
              points: all.filter((p) => p.date >= range.from && p.date < range.to && p.date + HOUR <= clock),
              nextFrom: null
            })
          }
        ],
        label: () => 'CLAMPED'
      })
    }
    const host = await createPluginHost({ plugins: [plugin], facilities: facilities() })
    hosts.push(host)
    const fc = fakeChart()
    // The chart holds every closed bar plus the one forming at the cursor.
    const bars = (at: number) => all.filter((p) => p.date <= at).map((p) => ({ timestamp: p.date }))
    fc.data = bars(clock)
    fc.indicators = [fakeIndicator('CLAMPED', 'i1')]
    host.sync([fakePane('p1', fc.chart)])
    await flush()

    // Two replay stops, each on a 15m boundary and so mid-hour for this source.
    for (const stop of [NY(6, 11, 15), NY(6, 14, 30)]) {
      const before = clock
      clock = stop
      fc.data = bars(clock)
      host.invalidateFrom(before)
      await flush()
    }

    const store = peekStore<InstanceType<typeof WindowStore<Point, number>>>('clamped|1h')
    const held = [...(store?.values.keys() ?? [])].sort((a, b) => a - b)
    // 11:00 is the bar the first stop had forming: covered by that fetch, answered by
    // nothing, and never asked for again unless the invalidation reaches back to it.
    expect(held).toEqual(all.filter((p) => p.date + HOUR <= clock).map((p) => p.date))
    expect(held).toContain(NY(6, 11))
  })

  test('a source that declares no resolution is still forgotten from the cursor', async () => {
    const { plugin } = pointsPlugin([{ date: 10, v: 1 }])
    const host = await createPluginHost({ plugins: [plugin], facilities: facilities() })
    hosts.push(host)
    const fc = fakeChart()
    fc.data = [{ timestamp: 5 }, { timestamp: 10 }, { timestamp: 20 }]
    fc.indicators = [fakeIndicator('PTS', 'i1')]
    host.sync([fakePane('p1', fc.chart)])
    await flush()
    const store = peekStore<InstanceType<typeof WindowStore<Point, number>>>('pts|EURUSD|1h|[]')
    expect(store?.covers({ from: 5, to: 21 })).toBe(true)
    host.invalidateFrom(10)
    expect(store?.covers({ from: 5, to: 11 })).toBe(false)
    expect(store?.covers({ from: 5, to: 10 })).toBe(true)
  })

  test('extendData is replaced, never merged: what a plugin stops sending is gone', async () => {
    let roots = ['1D', '8h']
    const plugin: IndicatorPlugin = {
      id: 'roots',
      feature: null,
      paneConfigs: [SIZE_CONFIG('RT')],
      register: () => [],
      matches: (name) => name === 'RT',
      bind: () => ({ sources: [], label: () => 'RT', extendData: () => ({ roots }) })
    }
    const host = await createPluginHost({ plugins: [plugin], facilities: facilities() })
    hosts.push(host)
    const fc = fakeChart()
    fc.indicators = [fakeIndicator('RT', 'i1')]
    host.sync([fakePane('p1', fc.chart)])
    const current = () => (fc.indicators[0].extendData as { roots: string[] }).roots
    expect(current()).toEqual(['1D', '8h'])
    roots = ['8h']
    host.settingsModel('RT')?.write('p1', 'size', 2)
    expect(current()).toEqual(['8h'])
    roots = []
    host.settingsModel('RT')?.write('p1', 'size', 3)
    expect(current()).toEqual([])
  })

  test('validation is dispatched to the plugin that claims the name', async () => {
    const plugin: IndicatorPlugin = {
      id: 'cfg',
      feature: null,
      register: () => [],
      matches: (name) => name === 'CFG',
      bind: () => null,
      validateParams: async (request) => ({ ok: request.calcParams[0] !== 0, reason: 'zero' })
    }
    const host = await createPluginHost({ plugins: [plugin], facilities: facilities() })
    hosts.push(host)
    expect(host.validateParams).not.toBeNull()
    const check = await host.validateParams?.({ indicatorName: 'CFG', calcParams: [0], symbol: {} as never, period: {} as never })
    expect(check).toEqual({ ok: false, reason: 'zero' })
    expect(await host.validateParams?.({ indicatorName: 'MA', calcParams: [0], symbol: {} as never, period: {} as never })).toEqual({ ok: true })
  })
})

/** Per-pane settings of one number, stored under the pane's `sz` field. */
interface Size {
  size: number
}
function SIZE_CONFIG(template: string, fallback?: () => Size) {
  return paneConfig<Size>({
    templates: [template],
    doc: 'sz',
    title: 'Size',
    fields: [{ kind: 'number', key: 'size', label: 'Size', min: 1, max: 9, step: 1 }],
    defaults: { size: 1 },
    normalise: (config) => ({ size: Math.min(9, Math.max(1, Math.round(config.size))) }),
    toStored: (config) => (config.size === 1 ? undefined : { size: config.size }),
    fromStored: (stored) => {
      const size = (stored as Partial<Size> | undefined)?.size
      return typeof size === 'number' ? { size } : undefined
    },
    ...(fallback ? { fallback } : {})
  })
}

describe('per-pane settings', () => {
  /** A plugin with settings, recording the config every binding was made with. */
  function sized(feature: string | null = null) {
    const bound: Array<{ paneIndex: number; config: unknown }> = []
    const plugin: IndicatorPlugin = {
      id: 'sized',
      feature: feature as never,
      paneConfigs: [SIZE_CONFIG('SZ')],
      register: () => [],
      matches: (name) => name === 'SZ',
      bind: (ctx) => {
        bound.push({ paneIndex: ctx.paneIndex, config: ctx.config })
        return { sources: [], label: () => 'SZ' }
      }
    }
    return { plugin, bound }
  }

  test("a binding is handed its pane's config, and an edit rebinds that pane alone", async () => {
    const { plugin, bound } = sized()
    let persisted = 0
    const host = await createPluginHost({
      plugins: [plugin],
      facilities: facilities(),
      paneDocs: { 1: { sz: { size: 3 } } },
      requestPersist: () => {
        persisted++
      }
    })
    hosts.push(host)
    const charts = [fakeChart(), fakeChart()]
    for (const [i, c] of charts.entries()) c.indicators = [fakeIndicator('SZ', `i${i}`)]
    host.sync(charts.map((c, i) => fakePane(`p${i + 1}`, c.chart)))
    expect(bound).toEqual([
      { paneIndex: 0, config: { size: 1 } },
      { paneIndex: 1, config: { size: 3 } }
    ])
    host.settingsModel('SZ')?.write('p1', 'size', 12)
    expect(bound.at(-1)).toEqual({ paneIndex: 0, config: { size: 9 } })
    expect(bound).toHaveLength(3)
    expect(persisted).toBe(1)
    expect(host.paneDocs()).toEqual({ 0: { sz: { size: 9 } }, 1: { sz: { size: 3 } } })
  })

  test("the gear and the manager are the host's, addressed by wall pane, not pane index", async () => {
    const { plugin } = sized()
    const opened: SettingsPanelOptions<object>[] = []
    const host = await createPluginHost({
      plugins: [plugin],
      facilities: facilities(),
      paneDocs: { 0: { sz: { size: 2 } } },
      openSettingsPanel: (options) => {
        opened.push(options as unknown as SettingsPanelOptions<object>)
        return { close() {} }
      }
    })
    hosts.push(host)
    const dom = { getBoundingClientRect: () => ({ top: 10, left: 20 }) }
    const chart = (): ReturnType<typeof fakeChart> => {
      const c = fakeChart()
      ;(c.chart as unknown as { getDom: () => unknown }).getDom = () => dom
      return c
    }
    // The wall's second pane first: its id and its index disagree, which is the whole mapping.
    host.sync([fakePane('p2', chart().chart), fakePane('p1', chart().chart)])
    expect(host.ownsSettings('SZ')).toBe(true)
    expect(host.ownsSettings('MA')).toBe(false)
    expect(host.handleSettings({ indicatorName: 'MA', paneId: 'p1', chartPaneId: 'candle_pane', calcParams: [] })).toBe(false)
    expect(host.handleSettings({ indicatorName: 'SZ', paneId: 'p2', chartPaneId: 'candle_pane', calcParams: [] })).toBe(true)
    expect(opened[0].title).toBe('Size · EURUSD 1h')
    expect(opened[0].config).toEqual({ size: 2 })
    opened[0].onChange({ size: 5 })
    const model = host.settingsModel('SZ')
    expect(model?.read('p2')).toEqual({ size: 5 })
    expect(model?.read('p1')).toEqual({ size: 1 })
    expect(model?.read('p9')).toBeNull()
    model?.write('p1', 'size', 4)
    model?.write('p9', 'size', 5)
    expect(host.paneDocs()).toEqual({ 0: { sz: { size: 5 } }, 1: { sz: { size: 4 } } })
    expect(host.settingsModel('MA')).toBeNull()
  })

  test('panes changing places take their settings with them, and leave none behind', async () => {
    const { plugin, bound } = sized()
    const host = await createPluginHost({
      plugins: [plugin],
      facilities: facilities(),
      paneDocs: { 0: { sz: { size: 3 } }, 4: { sz: { size: 9 } } }
    })
    hosts.push(host)
    const c1 = fakeChart()
    const c2 = fakeChart()
    c1.indicators = [fakeIndicator('SZ', 'a')]
    c2.indicators = [fakeIndicator('SZ', 'b')]
    const p1 = fakePane('p1', c1.chart)
    const p2 = fakePane('p2', c2.chart)
    host.sync([p1, p2])
    bound.length = 0
    // What the wall reports when its second pane is moved first, before it reports the panes.
    host.reorderPanes([1, 0])
    host.sync([p2, p1])
    const model = host.settingsModel('SZ')
    expect(model?.read('p1')).toEqual({ size: 3 })
    expect(model?.read('p2')).toEqual({ size: 1 })
    // A position the move did not reach (a pane the layout hides) keeps what it had.
    expect(host.paneDocs()).toEqual({ 1: { sz: { size: 3 } }, 4: { sz: { size: 9 } } })
    // Both moved panes were rebound at their new positions, with the config that moved there.
    expect(bound).toContainEqual({ paneIndex: 1, config: { size: 3 } })
    expect(bound).toContainEqual({ paneIndex: 0, config: { size: 1 } })
  })

  test("a plugin this server does not mount keeps its panes' settings through a save", async () => {
    const { plugin } = sized('levels2')
    const host = await createPluginHost({
      plugins: [plugin],
      facilities: fakeFacilities({ hasFeature: () => false }),
      paneDocs: { 0: { sz: { size: 3 }, junk: { a: 1 } }, 2: { sz: 'not even an object' } }
    })
    hosts.push(host)
    expect(host.settingsModel('SZ')).toBeNull()
    // Carried verbatim -- this server cannot judge them -- and moved with their panes; a field
    // no plugin of this build declares is not carried at all.
    expect(host.paneDocs()).toEqual({ 0: { sz: { size: 3 } }, 2: { sz: 'not even an object' } })
    host.reorderPanes([2, 1, 0])
    expect(host.paneDocs()).toEqual({ 0: { sz: 'not even an object' }, 2: { sz: { size: 3 } } })
  })

  test('a pane never configured reads the fallback, and stores nothing', async () => {
    const plugin: IndicatorPlugin = {
      ...sized().plugin,
      paneConfigs: [SIZE_CONFIG('SZ', () => ({ size: 6 }))]
    }
    const host = await createPluginHost({ plugins: [plugin], facilities: facilities() })
    hosts.push(host)
    host.sync([fakePane('p1', fakeChart().chart)])
    expect(host.settingsModel('SZ')?.read('p1')).toEqual({ size: 6 })
    expect(host.paneDocs()).toEqual({})
  })
})

// A BAR REPLAY'S NEXT LANDING, WARMED ON THE SERVER (`warmAhead`). The host asks each source that
// offers it for the window it will read at the landing, over the bars the replay says the pane
// will hold then, and sends one read per store -- never a fetch into it, and never twice for one
// landing.
describe('warmAhead', () => {
  /** A plugin whose source is keyed by instrument only, so two panes on one share a store, and
   * which warms over the predicted bars to just past the landing. */
  function warmPlugin(opts: { fail?: () => boolean } = {}) {
    const fetches: Range[] = []
    const reads: Array<{ key: string; window: Range; at: number }> = []
    const plugin: IndicatorPlugin = {
      id: 'warm',
      feature: null,
      register: () => [],
      matches: (name) => name === 'WARM',
      bind: (ctx: BindContext) => {
        const key = `warm|${ctx.ticker}`
        return {
          sources: [
            {
              id: 'v',
              key,
              fetch: async (range): Promise<Page<Point>> => {
                fetches.push({ ...range })
                return { points: [], nextFrom: null }
              },
              warm: {
                window: (chartRange: Range, at: number) => ({ from: chartRange.from - 1, to: at + 1 }),
                read: async (window: Range, at: number) => {
                  reads.push({ key, window, at })
                  if (opts.fail?.()) throw new Error('503')
                }
              }
            }
          ],
          label: () => 'WARM'
        }
      }
    }
    return { plugin, fetches, reads }
  }

  async function wall(plugins: IndicatorPlugin[], panes: Array<{ id: string; ticker: string; data: number[]; template?: string }>) {
    const host = await createPluginHost({ plugins, facilities: facilities() })
    hosts.push(host)
    const made = panes.map((p) => {
      const fc = fakeChart()
      fc.data = p.data.map((timestamp) => ({ timestamp }))
      fc.indicators = [fakeIndicator(p.template ?? 'WARM', `${p.id}-i`)]
      return fakePane(p.id, fc.chart, p.ticker)
    })
    host.sync(made)
    await flush()
    return host
  }

  test("one read per store, over the union of its panes' windows, under the landing's clock -- nothing filed", async () => {
    const { plugin, fetches, reads } = warmPlugin()
    const host = await wall(
      [plugin],
      [
        { id: 'a', ticker: 'EURUSD', data: [10, 20] },
        { id: 'b', ticker: 'EURUSD', data: [30, 40] },
        { id: 'c', ticker: 'GBPUSD', data: [50, 60] }
      ]
    )
    const before = fetches.length
    // Where each pane will be at the landing: `a` reloads further on, `b` and `c` append.
    const landing: Record<string, Range> = { a: { from: 70, to: 101 }, b: { from: 30, to: 101 }, c: { from: 50, to: 101 } }
    const sent = await host.warmAhead(100, (pane) => landing[pane.id])
    expect(sent).toBe(2)
    expect(reads.sort((x, y) => x.key.localeCompare(y.key))).toEqual([
      { key: 'warm|EURUSD', window: { from: 29, to: 101 }, at: 100 },
      { key: 'warm|GBPUSD', window: { from: 49, to: 101 }, at: 100 }
    ])
    // The stores were not touched: the answer lies past the chart's clock.
    expect(fetches.length).toBe(before)
    expect(peekStore<InstanceType<typeof WindowStore<Point, number>>>('warm|EURUSD')?.size).toBe(0)
  })

  test('the same landing again sends nothing; more of a window, or another landing, sends again', async () => {
    const { plugin, reads } = warmPlugin()
    const host = await wall([plugin], [{ id: 'a', ticker: 'EURUSD', data: [10, 20] }])
    let range: Range = { from: 30, to: 101 }
    expect(await host.warmAhead(100, () => range)).toBe(1)
    // Every advance that stops short of the landing asks again: a duplicate each time.
    expect(await host.warmAhead(100, () => range)).toBe(0)
    expect(await host.warmAhead(100, () => ({ from: 40, to: 101 }))).toBe(0)
    // A pane reloaded further back reads more: that part is new to the server.
    range = { from: 20, to: 101 }
    expect(await host.warmAhead(100, () => range)).toBe(1)
    // The landing after it.
    expect(await host.warmAhead(200, () => ({ from: 150, to: 201 }))).toBe(1)
    expect(reads.map((r) => [r.at, r.window.from])).toEqual([
      [100, 29],
      [100, 19],
      [200, 149]
    ])
  })

  test('a source that offers no warm-up, and a pane with no landing, are left alone', async () => {
    const { plugin: warm, reads } = warmPlugin()
    const { plugin: plain, fetches } = pointsPlugin([])
    const host = await wall(
      [warm, plain],
      [
        { id: 'a', ticker: 'EURUSD', data: [10, 20] },
        { id: 'b', ticker: 'GBPUSD', data: [10, 20], template: 'PTS' }
      ]
    )
    const before = fetches.length
    expect(await host.warmAhead(100, (pane) => (pane.id === 'a' ? null : { from: 10, to: 101 }))).toBe(0)
    expect(reads).toEqual([])
    expect(fetches.length).toBe(before)
  })

  test('a failed warm-up is tried again at the next ask', async () => {
    let failing = true
    const { plugin, reads } = warmPlugin({ fail: () => failing })
    const host = await wall([plugin], [{ id: 'a', ticker: 'EURUSD', data: [10, 20] }])
    const realDebug = console.debug
    console.debug = () => {}
    try {
      expect(await host.warmAhead(100, () => ({ from: 30, to: 101 }))).toBe(1)
    } finally {
      console.debug = realDebug
    }
    failing = false
    expect(await host.warmAhead(100, () => ({ from: 30, to: 101 }))).toBe(1)
    expect(await host.warmAhead(100, () => ({ from: 30, to: 101 }))).toBe(0)
    expect(reads).toHaveLength(2)
  })
})
