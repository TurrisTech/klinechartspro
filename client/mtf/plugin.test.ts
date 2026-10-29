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

  test('a replay standing on the last bar\'s close reads that instant too; a live chart does not', async () => {
    const { setReadClock } = await import('../config')
    const { spec } = bound(2, '1h')
    const t = Date.parse('2026-10-05T13:00Z')
    const range = { from: t, to: t + 2 * 3_600_000 + 1 }
    const close = t + 3 * 3_600_000
    try {
      // On the close: what became knowable at it is knowable now (drawn in the next bar's slot).
      setReadClock(close)
      expect(spec?.sources[0].window?.(range)?.to).toBe(close + 1)
      // Inside the bar, it is still forming: its close is not knowable yet.
      setReadClock(close - 60_000)
      expect(spec?.sources[0].window?.(range)?.to).toBe(close)
      // Live: the last bar is forming.
      setReadClock(null)
      expect(spec?.sources[0].window?.(range)?.to).toBe(close)
    } finally {
      setReadClock(null)
    }
  })

  test("live, Friday's last close is read once it has passed; a close the next bar opens at is not", async () => {
    const { closeKnown } = await import('./plugin')
    const { FX_GRID } = await import('../replay/timeframes')
    const H = 3_600_000
    const { spec } = bound(2, '1h')
    // Friday 2026-10-02 16:00 New York (20:00Z): the week's last hour, closing 17:00 (21:00Z).
    const friday = Date.parse('2026-10-02T20:00Z')
    const close = friday + H
    expect(spec?.sources[0].window?.({ from: friday - 5 * H, to: friday + 1 })?.to).toBe(close + 1)
    expect(closeKnown(FX_GRID, '1h', friday, close, close - 60_000)).toBe(false)
    expect(closeKnown(FX_GRID, '1h', friday, close, close)).toBe(true)
    // Thursday's 16:00: the next bar opens at 17:00 and carries it.
    const thursday = friday - 24 * H
    expect(spec?.sources[0].window?.({ from: thursday - 5 * H, to: thursday + 1 })?.to).toBe(thursday + H)
    expect(closeKnown(FX_GRID, '1h', thursday, thursday + H, thursday + 2 * H)).toBe(false)
  })

  test("a replay's next landing is warmed under the clock the landing sets, for the server alone", async () => {
    const { setReadClock } = await import('../config')
    const { spec } = bound(2, '1h')
    const source = spec?.sources[0]
    if (!source?.warm) throw new Error('no warm-up')
    const H = 3_600_000
    const t = Date.parse('2026-10-05T13:00Z')
    // The bars the pane will hold at the landing: 13:00Z .. 15:00Z, the press landing on 15:00's close.
    const landing = { from: t, to: t + 2 * H + 1 }
    const at = t + 3 * H
    const requests: Array<{ url: URL; init?: RequestInit }> = []
    globalThis.fetch = (async (url: URL, init?: RequestInit) => {
      requests.push({ url: new URL(String(url)), init })
      return new Response(JSON.stringify({ s: 'no_data', nextFrom: null, computedThrough: null }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      // The replay stands two hours earlier: under ITS clock the last close is not knowable, under
      // the landing's it is -- and the landing's is the one the press's read will be under.
      setReadClock(at - 2 * H)
      expect(source.window?.(landing)?.to).toBe(at)
      const window = source.warm.window(landing, at)
      expect(window).toEqual({ from: t - 4 * 86_400_000, to: at + 1 })
      await source.warm.read(window as { from: number; to: number }, at)
    } finally {
      setReadClock(null)
    }
    expect(requests).toHaveLength(1)
    const q = requests[0].url.searchParams
    expect(requests[0].url.pathname.endsWith('/mtf/graph')).toBe(true)
    // The pane's own configuration, so the server builds what the press will ask it for...
    expect([q.get('source'), q.get('timeframes'), q.get('roots'), q.get('maxStep')]).toEqual([MTF_OVERLAYS[2].source, '1h,2h,4h,8h,1D', '1D', '8'])
    // ...under the landing's clock, not the page's; one signal back, since the server builds and
    // keeps the whole window whatever the limit; and past the HTTP cache, whose revalidation the
    // server would answer with a 304 before building anything.
    expect([q.get('from'), q.get('to'), q.get('asof'), q.get('limit')]).toEqual([String(t - 4 * 86_400_000), String(at + 1), String(at), '1'])
    expect(requests[0].init?.cache).toBe('no-store')
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
