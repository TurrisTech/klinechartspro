import { describe, expect, test } from 'bun:test'
import { flush, installWindow } from '../plugins/testing'

installWindow()
const { storeFactory } = await import('./store')
const { liveWire, storedSubscribe } = await import('./plugin')
import type { PluginCatalogue } from '../plugins/api'
import type { PluginFacilities } from '../plugins/types'
import type { PluginPointListener } from '../stream'
import type { RegistryIndicator } from './api'
import type { RegistryPoint } from './store'

// The live half of a stored source: the research feed's frames, relayed by the server as
// `plugin_point`s (wdashboard-server services/framerelay.py). arev21 takes a pushed point as
// a value; arev21_outlier, which is computed per read, takes one as a cue to re-read its tail.

const entry = (name: string, plugin: string, dependsOn: string[] = []) =>
  ({ name, wire: { plugin, variant: name }, dependsOn }) as unknown as RegistryIndicator

const arev21 = entry('arev21', 'arev')
const outlier = entry('arev21_outlier_rank', 'arev21_outlier', ['arev21'])

const catalogue = (live: string[]): (() => Promise<PluginCatalogue>) => async () => ({
  plugins: ['arev', 'arev21_outlier'].map((id) => ({ id, live: live.includes(id) })) as never,
  serverTime: 0
})
const load = (live: string[]) => ({ catalogue: catalogue(live), registry: async () => [arev21, outlier] })
const withFeature = (on: boolean) => ({ hasFeature: () => on }) as unknown as PluginFacilities

const ctx = { vendor: 'oanda', ticker: 'EURUSD', interval: '1h' } as never
const row = (date: number, p = 0.6) => ({ date, p }) as unknown as RegistryPoint

describe('liveWire', () => {
  test('nothing without the plugins.live feature', async () => {
    expect(await liveWire(withFeature(false), arev21, load(['arev']))).toBeNull()
  })

  test("an entry whose own wire pushes is direct", async () => {
    expect(await liveWire(withFeature(true), arev21, load(['arev']))).toEqual({
      wire: { plugin: 'arev', variant: 'arev21' },
      direct: true
    })
  })

  test("an entry computed from a pushing dependency listens on the dependency's wire", async () => {
    expect(await liveWire(withFeature(true), outlier, load(['arev']))).toEqual({
      wire: { plugin: 'arev', variant: 'arev21' },
      direct: false
    })
  })

  test('nothing when no wire involved pushes', async () => {
    expect(await liveWire(withFeature(true), outlier, load([]))).toBeNull()
  })
})

function harness(direct: boolean) {
  const subs: Array<{ args: unknown[]; listener: PluginPointListener }> = []
  const unsubs: unknown[][] = []
  const f = {
    stream: {
      subscribePlugin: (...args: unknown[]) => subs.push({ args: args.slice(0, 5), listener: args[5] as PluginPointListener }),
      unsubscribePlugin: (...args: unknown[]) => unsubs.push(args.slice(0, 5))
    }
  } as unknown as PluginFacilities
  const store = storeFactory(null)(`k-${direct}`)
  const calls = { changed: 0, refetch: 0 }
  const notify = { changed: () => calls.changed++, refetch: () => calls.refetch++ }
  const wire = { wire: { plugin: 'arev', variant: 'arev21' }, direct }
  const dispose = storedSubscribe(f, direct ? arev21 : outlier, ctx, async () => wire)(store, notify)
  return { subs, unsubs, store, calls, dispose }
}

describe('storedSubscribe', () => {
  test('subscribes the resolved wire on the chart instrument and unsubscribes it', async () => {
    const h = harness(true)
    await flush()
    expect(h.subs.map((s) => s.args)).toEqual([['arev', 'arev21', 'oanda', 'EURUSD', '1h']])
    h.dispose()
    expect(h.unsubs).toEqual([['arev', 'arev21', 'oanda', 'EURUSD', '1h']])
  })

  test('a disposer that runs before the wire resolves never subscribes', async () => {
    const h = harness(true)
    h.dispose()
    await flush()
    expect(h.subs).toEqual([])
  })

  test('a direct point lands in the store without a read', async () => {
    const h = harness(true)
    await flush()
    h.store.ingest([row(1000)], { from: 0, to: 2000 })
    h.subs[0].listener.onPoint(row(2000, 0.4))
    expect((h.store.values.get(2000) as unknown as { p: number }).p).toBe(0.4)
    expect(h.calls).toEqual({ changed: 1, refetch: 0 })
    // The window the host fetched before the feed wrote bar 2000 stays covered.
    expect(h.store.missing({ from: 0, to: 2000 })).toEqual([])
  })

  test("a dependency's point re-reads this entry from the bar after the newest it holds", async () => {
    const h = harness(false)
    await flush()
    h.store.ingest([row(1000)], { from: 0, to: 3000 })
    h.subs[0].listener.onPoint(row(3000))
    expect(h.calls.refetch).toBe(1)
    expect(h.store.missing({ from: 0, to: 4000 })).toEqual([{ from: 1001, to: 4000 }])
    expect(h.store.values.has(1000)).toBe(true)
  })

  test('an ack re-reads the tail a reconnect may have missed, and does nothing on an empty store', async () => {
    const h = harness(true)
    await flush()
    h.subs[0].listener.onSubscribed?.()
    expect(h.calls.refetch).toBe(0)
    h.store.ingest([row(1000)], { from: 0, to: 5000 })
    h.subs[0].listener.onSubscribed?.()
    expect(h.calls.refetch).toBe(1)
    expect(h.store.missing({ from: 0, to: 5000 })).toEqual([{ from: 1001, to: 5000 }])
  })
})
