import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

installWindow()
const { RegistryStore, storeFactory, registrySourceKey, GRID_ARRAY } = await import('./store')
const { storedSource } = await import('./plugin')
import type { PluginFacilities } from '../plugins/types'
import type { RegistryIndicator } from './api'
import type { RegistryPoint } from './store'

// One key, one class, one row type. Two bindings read an arev21-series key -- the registry
// pane and the AREV21 MTF overlay -- and `storeFor` lets whichever binds FIRST decide the
// store class. These lock the three properties that make that safe: both sources name the
// same factory BY REFERENCE, both write the same row, and the overlay's bar grid rides
// beside the points as an auxiliary array rather than as a second kind of value.

interface Vote {
  date: number
  p: number
  n: number
  side?: string
}

const point = (date: number, p = 0.6): Vote => ({ date, p, n: 200 })
const window0 = { from: 0, to: 10_000 }

/** `RegistryPoint` declares only `date` on purpose -- a row's fields are the registry's
 * business -- so a fixture literal is widened here rather than typed twice. */
const row = (o: Record<string, unknown>) => o as unknown as RegistryPoint

/** What the OVERLAY's fetch hands the host: votes as points, grid as an auxiliary array. */
const overlayPage = (dates: number[], grid: number[]) => ({
  points: dates.map((d) => point(d)),
  arrays: { [GRID_ARRAY]: grid.map((date) => ({ date })) }
})

const arev21Entry = {
  name: 'arev21',
  template: 'AREV:arev21',
  title: 'AREV21',
  source: { kind: 'table', fold_by: null },
  wire: { plugin: 'arev', variant: 'arev21' }
} as unknown as RegistryIndicator

const ctx = (interval: string) =>
  ({ vendor: 'oanda', ticker: 'EURUSD', interval }) as never

describe('RegistryStore', () => {
  const arevStore = storeFactory(null)

  test("a bar the overlay has only in its GRID keeps the pane's vote", () => {
    // This is the bug, in one case. arev21 abstains on a bar whose window held no samples,
    // so the overlay's grid is denser than its votes: bar 2000 is in the grid and is not a
    // vote. It used to arrive as a value in its own right and overwrite whatever was filed
    // for that bar -- here, a real vote -- leaving the pane drawing a gap on it.
    const s = arevStore('k')
    s.ingest([point(1000, 0.61), point(2000, 0.42)], window0)
    const page = overlayPage([1000], [1000, 2000, 3000])
    s.ingest(page.points, window0, page.arrays)
    expect((s.values.get(2000) as Vote)?.p).toBe(0.42)
    expect(s.grid()).toEqual([1000, 2000, 3000])
  })

  test('every bar the overlay covers still holds a point, never a foreign row', () => {
    const s = arevStore('k')
    s.ingest([point(1000, 0.61), point(2000, 0.42)], window0)
    const page = overlayPage([1000, 2000], [1000, 2000, 3000])
    s.ingest(page.points, window0, page.arrays)
    for (const [date, v] of s.values) expect(typeof (v as Vote)?.p, `bar ${date}`).toBe('number')
    expect(s.size).toBe(2)
  })

  test('and not the other way round either: the pane does not erase the grid', () => {
    const s = arevStore('k')
    const page = overlayPage([1000], [1000, 2000, 3000])
    s.ingest(page.points, window0, page.arrays)
    s.ingest([point(2000, 0.33)], window0)
    expect(s.grid()).toEqual([1000, 2000, 3000])
    expect((s.values.get(2000) as Vote)?.p).toBe(0.33)
  })

  test('a page with no grid array leaves the grid alone rather than emptying it', () => {
    const s = arevStore('k')
    const page = overlayPage([], [1000, 2000])
    s.ingest(page.points, window0, page.arrays)
    s.ingest([], window0)
    s.ingest([], window0, {})
    expect(s.grid()).toEqual([1000, 2000])
  })

  test('the grid is deduplicated and sorted however the pages arrive', () => {
    const s = arevStore('k')
    const a = overlayPage([], [3000, 1000])
    const b = overlayPage([], [2000, 3000])
    s.ingest(a.points, window0, a.arrays)
    s.ingest(b.points, window0, b.arrays)
    expect(s.grid()).toEqual([1000, 2000, 3000])
  })

  test('forgetAfter drops the grid with the points, and keeps what was final', () => {
    const s = arevStore('k')
    const page = overlayPage([1000, 2000, 3000], [1000, 2000, 3000])
    s.ingest(page.points, window0, page.arrays)
    s.forgetAfter(2000)
    expect([...s.values.keys()]).toEqual([1000])
    expect(s.grid()).toEqual([1000])
    expect(s.missing(window0)).toEqual([{ from: 2000, to: 10_000 }])
  })

  test('it is a WindowStore, so a template reads it exactly as before', () => {
    const s = arevStore('k')
    expect(s).toBeInstanceOf(RegistryStore)
    s.ingest([point(1000)], window0)
    expect(s.covers({ from: 0, to: 10_000 })).toBe(true)
    expect(s.size).toBe(1)
  })
})

describe('a folded source', () => {
  const fold = storeFactory('side')

  test('two rows on one bar are filed under their own side, not one over the other', () => {
    // krev01 prints a top and a bottom candidate on the same bar. Unfolded, the second row
    // would replace the first and the pane would draw one side.
    const s = fold('k')
    s.ingest(
      [
        row({ date: 1000, p: 0.7, n: 80, side: 'top' }),
        row({ date: 1000, p: 0.3, n: 60, side: 'bottom' })
      ],
      window0
    )
    const bar = s.values.get(1000) as Record<string, Vote>
    expect(bar.top.p).toBe(0.7)
    expect(bar.bottom.p).toBe(0.3)
  })

  test('a later page adds a side rather than replacing the bar', () => {
    const s = fold('k')
    s.ingest([row({ date: 1000, p: 0.7, n: 80, side: 'top' })], window0)
    s.ingest([row({ date: 1000, p: 0.3, n: 60, side: 'bottom' })], window0)
    const bar = s.values.get(1000) as Record<string, Vote>
    expect(Object.keys(bar).sort()).toEqual(['bottom', 'top'])
  })

  test('a row with no fold value does not overwrite a good fold', () => {
    const s = fold('k')
    s.ingest([row({ date: 1000, p: 0.7, n: 80, side: 'top' })], window0)
    s.ingest([row({ date: 1000, p: 0.1, n: 1 })], window0)
    expect((s.values.get(1000) as Record<string, Vote>).top.p).toBe(0.7)
  })
})

describe('the factory is memoised, which is what makes a shared key safe', () => {
  test('the same fold yields the identical function, a different one does not', () => {
    expect(storeFactory(null)).toBe(storeFactory(null))
    expect(storeFactory(null)).toBe(storeFactory(undefined))
    expect(storeFactory('side')).toBe(storeFactory('side'))
    expect(storeFactory('side')).not.toBe(storeFactory(null))
  })
})

describe('the registry pane and the MTF overlay agree on the key they share', () => {
  test('same key, same resolution, same factory -- so binding order cannot matter', async () => {
    const { createMtfPlugin } = await import('../mtf/plugin')
    const { fakeChart, fakeIndicator, fakePane } = await import('../plugins/testing')

    const facilities = {
      points: async () => ({ points: [], nextFrom: null }),
      resolutionDurationMs: () => 14_400_000,
      openSettingsPanel: () => ({ close() {} }),
      requestPersist: () => {},
      paneInfo: () => null,
      requestReconcile: () => {}
    } as unknown as PluginFacilities

    const plugin = createMtfPlugin()
    plugin.register(facilities)
    const fc = fakeChart()
    const spec = plugin.bind({
      chart: fc.chart,
      pane: fakePane('p1', fc.chart),
      paneIndex: 0,
      indicator: fakeIndicator('MTF:arev21', 'i1'),
      symbol: { ticker: 'EURUSD' } as never,
      vendor: 'oanda',
      ticker: 'EURUSD',
      interval: '1h',
      siblings: []
    })
    // 4h is on by default and is not finer than a 1h chart, so the overlay binds it.
    const overlay = spec?.sources.find((s) => s.id === '4h')
    const pane = storedSource(facilities, arev21Entry, ctx('4h'))

    expect(overlay).toBeDefined()
    expect(overlay?.key).toBe(pane.key)
    expect(pane.key).toBe(registrySourceKey('arev21', 'oanda', 'EURUSD', '4h'))
    // Reference equality on the factory is the whole invariant: `storeFor` runs `create`
    // only for an ABSENT key, so two different factories under one key means the class
    // depends on which pane mounted first.
    expect(overlay?.createStore).toBe(pane.createStore)
    expect(overlay?.createStore).toBe(storeFactory(null))
    // And on the resolution, or a replay step would forget two different amounts of the
    // one store (plugins/horizon.ts).
    expect(overlay?.resolution).toBe(pane.resolution)
  })

  test('the stored source asks the wire the registry gave it', () => {
    const seen: Array<Record<string, unknown>> = []
    const facilities = {
      points: async (request: Record<string, unknown>) => {
        seen.push(request)
        return { points: [], nextFrom: null }
      }
    } as unknown as PluginFacilities
    storedSource(facilities, arev21Entry, ctx('1h')).fetch({ from: 1, to: 2 }, 100)
    expect(seen[0].pluginId).toBe('arev')
    expect(seen[0].variant).toBe('arev21')
  })
})
