import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

installWindow()
const { ArevStore, arevStore, GRID_ARRAY } = await import('./store')
const { arevSource, arevSourceKey } = await import('./plugin')
import type { ArevPoint } from './api'
import type { PluginFacilities } from '../plugins/types'

// One key, one class, one row type. Two bindings read an arev21-series key -- the AREV
// sub-pane and the AREV21 MTF overlay -- and `storeFor` lets whichever binds FIRST decide
// the store class. These tests lock the two properties that makes safe: both sources name
// the same factory, and both write the same row, with the overlay's bar grid riding beside
// the points as an auxiliary array rather than as a second kind of value.

const point = (date: number, p = 0.6): ArevPoint => ({ date, p, n: 200, signal: null }) as ArevPoint

const window0 = { from: 0, to: 10_000 }

/** What the OVERLAY's fetch hands the host: votes as points, grid as an auxiliary array. */
const overlayPage = (dates: number[], grid: number[]) => ({
  points: dates.map((d) => point(d)),
  arrays: { [GRID_ARRAY]: grid.map((date) => ({ date })) }
})

describe('ArevStore', () => {
  test('a bar the overlay has only in its GRID keeps the sub-pane\'s vote', () => {
    // This is the bug, in one case. arev21 abstains on a bar whose window held no samples,
    // so the overlay's grid is denser than its votes: bar 2000 is in the grid and is not a
    // vote. It used to arrive as a value in its own right and overwrite whatever was filed
    // for that bar -- here, a real vote -- leaving the sub-pane drawing a gap on it.
    const s = arevStore('k')
    s.ingest([point(1000, 0.61), point(2000, 0.42)], window0)
    const page = overlayPage([1000], [1000, 2000, 3000])
    s.ingest(page.points, window0, page.arrays)
    expect(s.values.get(2000)?.p).toBe(0.42)
    expect(s.grid()).toEqual([1000, 2000, 3000])
  })

  test('every bar the overlay covers still holds an AREV point, never a foreign row', () => {
    // The general form: whatever order the two bindings write in, a stored value is an
    // ArevPoint. A bar carrying `{p: undefined}` is what the sub-pane drew a hole on.
    const s = arevStore('k')
    s.ingest([point(1000, 0.61), point(2000, 0.42)], window0)
    const page = overlayPage([1000, 2000], [1000, 2000, 3000])
    s.ingest(page.points, window0, page.arrays)
    for (const [date, v] of s.values) expect(typeof v?.p, `bar ${date}`).toBe('number')
    expect(s.size).toBe(2)
  })

  test('and not the other way round either: the sub-pane does not erase the grid', () => {
    const s = arevStore('k')
    const page = overlayPage([1000], [1000, 2000, 3000])
    s.ingest(page.points, window0, page.arrays)
    s.ingest([point(2000, 0.33)], window0)
    expect(s.grid()).toEqual([1000, 2000, 3000])
    expect(s.values.get(1000)?.p).toBe(0.6)
    expect(s.values.get(2000)?.p).toBe(0.33)
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

  test('it is a WindowStore, so the AREV template reads it exactly as before', () => {
    const s = arevStore('k')
    expect(s).toBeInstanceOf(ArevStore)
    s.ingest([point(1000)], window0)
    expect(s.covers({ from: 0, to: 10_000 })).toBe(true)
    expect(s.size).toBe(1)
  })
})

describe('the shared key', () => {
  test('the AREV source names the one factory', () => {
    const f = { points: async () => ({ points: [], nextFrom: null }) } as unknown as PluginFacilities
    const spec = arevSource(f, 'arev21', 'oanda', 'EURUSD', '4h')
    // Reference equality, not "some function": the point is that the overlay's spec names
    // THIS one, so the class cannot depend on which binding arrives first.
    expect(spec.createStore).toBe(arevStore)
    expect(spec.key).toBe(arevSourceKey('arev21', 'oanda', 'EURUSD', '4h'))
    expect(spec.resolution).toBe('4h')
  })
})

describe('the AREV sub-pane and the MTF overlay agree on the key they share', () => {
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
    const subPane = arevSource(facilities, 'arev21', 'oanda', 'EURUSD', '4h')

    expect(overlay).toBeDefined()
    expect(overlay?.key).toBe(subPane.key)
    // Reference equality on the factory is the whole invariant: `storeFor` runs `create`
    // only for an ABSENT key, so two different factories under one key means the class
    // depends on which pane mounted first.
    expect(overlay?.createStore).toBe(subPane.createStore)
    expect(overlay?.createStore).toBe(arevStore)
    // And on the resolution, or a replay step would forget two different amounts of the
    // one store (plugins/horizon.ts).
    expect(overlay?.resolution).toBe(subPane.resolution)
  })
})
