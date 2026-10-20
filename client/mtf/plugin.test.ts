import { afterEach, describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// What each multi-timeframe overlay asks the server for: one read of `GET /mtf/graph` per
// binding, naming the overlay's own signal family and params, the timeframes the pane draws, the
// roots among them and the largest step -- into a store of its own class and key, which nothing
// else on the wall can share (until 2026-10-20 the overlay read each timeframe into a registry
// store, and sharing one with a sub-pane that fetched no bar grid dropped every vote in a window
// the sub-pane loaded first).
installWindow()
const { createMtfPlugin, GRAPH_SOURCE } = await import('./plugin')
const { MTF_OVERLAYS } = await import('./overlays')
const { MTF_DEFAULTS } = await import('./config')
const { MtfGraphStore } = await import('./store')
const { storedSource } = await import('../tsregistry/plugin')
import type { PluginFacilities } from '../plugins/types'
import type { RegistryIndicator } from '../tsregistry/api'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const facilities = {
  hasFeature: () => true,
  resolutionDurationMs: () => 3_600_000,
  stream: { subscribePlugin: () => {}, unsubscribePlugin: () => {} }
} as unknown as PluginFacilities

function bound(index: number, interval = '1h') {
  const overlay = MTF_OVERLAYS[index]
  const plugin = createMtfPlugin(overlay, { catalogue: async () => ({ plugins: [], serverTime: 0 }), registry: async () => [] })
  plugin.register(facilities)
  const config = structuredClone(MTF_DEFAULTS)
  config.timeframes['5m'].enabled = true
  const spec = plugin.bind({
    vendor: 'oanda',
    ticker: 'EURUSD',
    interval,
    paneIndex: 0,
    symbol: { ticker: 'EURUSD', timezone: 'America/New_York', dayGeometry: { openOffset: -7, closeOffset: 17, everyDayTrades: false } },
    config
  } as never)
  return { overlay, spec }
}

describe('each overlay', () => {
  for (const [index, overlay] of MTF_OVERLAYS.entries()) {
    test(`${overlay.templateName}: one read, of its own family, into a store no sub-pane shares`, async () => {
      const { spec } = bound(index, '5m')
      expect(spec?.sources.map((s) => s.id)).toEqual([GRAPH_SOURCE])
      const source = spec?.sources[0]
      if (!source?.createStore) throw new Error('no source')
      expect(source.createStore(source.key)).toBeInstanceOf(MtfGraphStore)
      // No registry series key looks like this one, at any interval or params.
      const entry = { name: 'arev21', wire: { plugin: 'arev', variant: 'arev21' }, source: { fold_by: null }, params: [] } as unknown as RegistryIndicator
      const ctx = { vendor: 'oanda', ticker: 'EURUSD', interval: '5m' } as never
      expect(source.key).not.toBe(storedSource(facilities, entry, ctx).key)
      expect(source.key.startsWith('mtf|')).toBe(true)

      const urls: URL[] = []
      globalThis.fetch = (async (url: URL) => {
        urls.push(new URL(String(url)))
        return new Response(JSON.stringify({ s: 'no_data', nextFrom: null, computedThrough: null }), { status: 200 })
      }) as unknown as typeof fetch
      const page = await source.fetch({ from: 1_000, to: 2_000 }, 500)
      expect(page).toEqual({ points: [], nextFrom: null, arrays: { nodes: [] } })
      const q = urls[0].searchParams
      expect(urls[0].pathname.endsWith('/mtf/graph')).toBe(true)
      expect(q.get('source')).toBe(overlay.source)
      expect(q.get('params')).toBe(overlay.params ? JSON.stringify(overlay.params) : null)
      expect(q.get('timeframes')).toBe('5m,1h,2h,4h,8h,1D')
      // Only the overlay that offers a graph asks for one.
      expect(q.get('roots')).toBe(overlay.graph ? '1D' : '')
      expect(q.get('maxStep')).toBe('8')
      expect([q.get('from'), q.get('to'), q.get('limit')]).toEqual(['1000', '2000', '500'])
    })
  }

  test('the window is the chart\'s loaded bars as instants, from the gap before the first', () => {
    const { spec } = bound(2, '1h')
    const t = Date.parse('2026-10-05T13:00Z')
    // Hourly bars 13:00Z .. 15:00Z: from four days before the first open to the last one's close.
    expect(spec?.sources[0].window?.({ from: t, to: t + 2 * 3_600_000 + 1 })).toEqual({ from: t - 4 * 86_400_000, to: t + 3 * 3_600_000 })
  })

  test('nothing drawn, nothing read', () => {
    const { spec } = bound(2, '1D')
    // Only 1D is not finer than a daily chart; with it off nothing is drawable.
    expect(spec?.sources.length).toBe(1)
    const plugin = createMtfPlugin(MTF_OVERLAYS[2])
    plugin.register(facilities)
    const config = structuredClone(MTF_DEFAULTS)
    for (const key of Object.keys(config.timeframes)) config.timeframes[key as keyof typeof config.timeframes].enabled = false
    const none = plugin.bind({ vendor: 'oanda', ticker: 'EURUSD', interval: '1h', paneIndex: 0, symbol: { ticker: 'EURUSD', timezone: 'America/New_York', dayGeometry: { openOffset: -7, closeOffset: 17, everyDayTrades: false } }, config } as never)
    expect(none?.sources).toEqual([])
  })
})
