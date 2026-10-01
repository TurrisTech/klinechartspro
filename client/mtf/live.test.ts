import { describe, expect, test } from 'bun:test'
import { flush, installWindow } from '../plugins/testing'

installWindow()
const { createMtfPlugin, mtfLiveWire } = await import('./plugin')
const { AREV21_MTF, AREV21_OUTLIER_RANK_85_MTF } = await import('./overlays')
const { storeFactory } = await import('../tsregistry/store')
import type { PluginCatalogue } from '../plugins/api'
import type { BindContext, PluginFacilities, SourceStore } from '../plugins/types'
import type { PluginPointListener } from '../stream'
import type { RegistryIndicator } from '../tsregistry/api'
import type { RegistryPoint } from '../tsregistry/store'

// The MTF overlay's live half: each source timeframe listens on arev21's wire AT THAT
// TIMEFRAME and re-reads its tail -- votes and grid -- on every point. Until 2026-10-01 it
// subscribed nothing, so a vote written after the chart loaded never arrived (user: a 2h
// signal the rank sub-pane showed was missing from the MTF overlay until a reload).

const entry = (name: string, plugin: string, dependsOn: string[] = []) =>
  ({ name, wire: { plugin, variant: name }, dependsOn }) as unknown as RegistryIndicator
const registry = [entry('arev21', 'arev'), entry('arev21_outlier_rank', 'arev21_outlier', ['arev21'])]
const loaders = (live: string[]) => ({
  catalogue: async (): Promise<PluginCatalogue> => ({
    plugins: ['arev', 'arev21_outlier'].map((id) => ({ id, live: live.includes(id) })) as never,
    serverTime: 0
  }),
  registry: async () => registry
})
const withFeature = (on: boolean) => ({ hasFeature: () => on }) as unknown as PluginFacilities

describe('mtfLiveWire', () => {
  test("both overlays listen on arev21's wire, and only ever as a cue to re-read", async () => {
    for (const overlay of [AREV21_MTF, AREV21_OUTLIER_RANK_85_MTF]) {
      expect(await mtfLiveWire(withFeature(true), overlay, loaders(['arev']))).toEqual({
        wire: { plugin: 'arev', variant: 'arev21' },
        direct: false
      })
    }
  })

  test('nothing where nothing pushes', async () => {
    expect(await mtfLiveWire(withFeature(false), AREV21_OUTLIER_RANK_85_MTF, loaders(['arev']))).toBeNull()
    expect(await mtfLiveWire(withFeature(true), AREV21_OUTLIER_RANK_85_MTF, loaders([]))).toBeNull()
  })
})

describe('a bound overlay', () => {
  function harness() {
    const subs: Array<{ args: unknown[]; listener: PluginPointListener }> = []
    const f = {
      hasFeature: () => true,
      resolutionDurationMs: (code: string) => (({ '1D': 24, '8h': 8, '4h': 4, '2h': 2, '1h': 1 }) as Record<string, number>)[code] * 3_600_000,
      stream: {
        subscribePlugin: (...args: unknown[]) => subs.push({ args: args.slice(0, 5), listener: args[5] as PluginPointListener }),
        unsubscribePlugin: () => {}
      }
    } as unknown as PluginFacilities
    const plugin = createMtfPlugin(AREV21_OUTLIER_RANK_85_MTF, loaders(['arev']))
    plugin.register(f)
    const ctx = { vendor: 'oanda', ticker: 'EURUSD', interval: '1h', paneIndex: 0 } as unknown as BindContext
    const spec = plugin.bind(ctx)
    return { subs, spec }
  }

  test("each source timeframe subscribes at its OWN interval, not the chart's", async () => {
    const { subs, spec } = harness()
    const sources = spec?.sources ?? []
    expect(sources.map((s) => s.id)).toEqual(['1D', '8h', '4h', '2h', '1h'])
    for (const source of sources) source.subscribe?.(storeFactory(null)(`k-${source.id}`) as never, { changed() {}, refetch() {} })
    await flush()
    expect(subs.map((s) => s.args[4])).toEqual(['1D', '8h', '4h', '2h', '1h'])
    expect(subs.every((s) => s.args[0] === 'arev' && s.args[1] === 'arev21')).toBe(true)
  })

  test('a point re-reads the tail, grid included, and is never filed as a vote', async () => {
    const { subs, spec } = harness()
    const source = spec?.sources.find((s) => s.id === '2h')
    const store = storeFactory(null)('k-2h')
    const calls = { refetch: 0 }
    source?.subscribe?.(store as unknown as SourceStore<RegistryPoint>, { changed() {}, refetch: () => calls.refetch++ })
    await flush()
    const t = (h: number) => Date.parse('2026-10-01T00:00Z') + h * 3_600_000
    const grid = [t(3), t(5)].map((date) => ({ date, open: 1, close: 1 }))
    store.ingest([{ date: t(3), p: 0.5 }, { date: t(5), p: 0.47 }] as unknown as RegistryPoint[], { from: t(0), to: t(200) }, { grid })
    subs[0].listener.onPoint({ date: t(7), p: 0.41 } as never)
    expect(calls.refetch).toBe(1)
    expect(store.values.has(t(7))).toBe(false)
    // Everything after the newest bar held is fetched again -- the padded week past it was
    // filed as covered by the first read, which is what kept the new vote out.
    expect(store.missing({ from: t(0), to: t(200) })).toEqual([{ from: t(5) + 1, to: t(200) }])
    expect(store.grid()).toEqual([t(3), t(5)])
  })
})
