import { describe, expect, test } from 'bun:test'
import { flush, installWindow } from '../plugins/testing'

installWindow()
const { createMtfPlugin, mtfLiveWire } = await import('./plugin')
const { AREV21_MTF, AREV21_OUTLIER_RANK_85_MTF } = await import('./overlays')
const { createMtfGraphStore } = await import('./store')
const { FX_DAY } = await import('../replay/timeframes')
const { MTF_DEFAULTS } = await import('./config')
const FX_DAY_TZ = 'America/New_York'
import type { PluginCatalogue } from '../plugins/api'
import type { BindContext, PluginFacilities, SourceStore } from '../plugins/types'
import type { PluginPointListener } from '../stream'
import type { RegistryIndicator } from '../tsregistry/api'
import type { MtfSignalRow } from './api'

// The MTF overlay's live half: for each timeframe it draws, the binding listens on arev21's wire
// AT THAT TIMEFRAME, and a point there makes it re-read everything knowable from that bar's
// close on -- the server's answer for the tail. Until 2026-10-01 it subscribed nothing, so a vote
// written after the chart loaded never arrived (user: a 2h signal the rank sub-pane showed was
// missing from the MTF overlay until a reload).

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
  function harness(withSchedule = true) {
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
    // The schedule rides on the symbol, as client/symbols.ts resolves it; without one the overlay
    // declines to bind (it cannot place a vote without knowing how the market dates its days).
    const symbol = withSchedule ? { ticker: 'EURUSD', exchange: 'oanda', timezone: FX_DAY_TZ, dayGeometry: FX_DAY } : { ticker: 'EURUSD', exchange: 'oanda' }
    const ctx = { vendor: 'oanda', ticker: 'EURUSD', interval: '1h', paneIndex: 0, symbol, config: MTF_DEFAULTS } as unknown as BindContext
    const spec = plugin.bind(ctx)
    return { subs, spec }
  }

  test('an instrument with no market hours binds nothing, and says why', () => {
    const { spec } = harness(false)
    expect(spec?.sources).toEqual([])
    expect(spec?.label({} as never)).toContain('no market hours')
  })

  test("one source, subscribed at each timeframe it draws -- not at the chart's", async () => {
    const { subs, spec } = harness()
    const sources = spec?.sources ?? []
    expect(sources.map((s) => s.id)).toEqual(['graph'])
    // Everything that decides the answer is in the key: the family, its params, the
    // instrument, the timeframes drawn, the roots, the largest step.
    expect(sources[0].key).toBe('mtf|arev21_outlier:arev21_outlier_rank|{"bars":200,"q":0.85,"samples_only":0}|oanda:EURUSD|1h,2h,4h,8h,1D|1D|8')
    sources[0].subscribe?.(createMtfGraphStore('k') as never, { changed() {}, refetch() {} })
    await flush()
    expect(subs.map((s) => s.args[4])).toEqual(['1h', '2h', '4h', '8h', '1D'])
    expect(subs.every((s) => s.args[0] === 'arev' && s.args[1] === 'arev21')).toBe(true)
  })

  test("a point re-reads everything knowable from its bar's close, and is never filed", async () => {
    const { subs, spec } = harness()
    const source = spec?.sources[0]
    const store = createMtfGraphStore('k-live')
    const calls = { refetch: 0 }
    source?.subscribe?.(store as unknown as SourceStore<MtfSignalRow>, { changed() {}, refetch: () => calls.refetch++ })
    await flush()
    const t = (h: number) => Date.parse('2026-10-01T00:00Z') + h * 3_600_000
    const row = (knownAt: number): MtfSignalRow => ({ interval: '2h', date: knownAt - 2 * 3_600_000, knownAt, price: 1, signal: 'short', side: 'bottom', p: 0.4, inGraph: false })
    store.ingest([row(t(5)), row(t(12))], { from: t(0), to: t(200) })
    // A 2h bar that opened 07:00Z: it closed at 09:00Z, and anything from then on may change.
    const twoHour = subs.find((s) => s.args[4] === '2h')
    twoHour?.listener.onPoint({ date: t(7) } as never)
    expect(calls.refetch).toBe(1)
    expect(store.missing({ from: t(0), to: t(200) })).toEqual([{ from: t(9), to: t(200) }])
    expect(store.signals().map((r) => r.knownAt)).toEqual([t(5)])
  })
})
