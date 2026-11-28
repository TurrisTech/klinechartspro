import { afterEach, describe, expect, test } from 'bun:test'
import type { IndicatorGroup } from '../src'
import { fakeChart, fakeFacilities, fakeIndicator, fakePane, flush, installWindow } from './plugins/testing'
import type { IndicatorPlugin, SourceStore } from './plugins/types'
import type { Page } from './paging'

installWindow()

// Every kind of source store the client has, held to the one status the host gives them all
// (plugins/store.ts `StoreStatus`): a page's problem reaches the store and the legend's warning
// whatever the store holds beside it, progress is a change, and a status set again is not.
// Until 2026-11-28 each store kept its own copy of that status, and the copies disagreed: three
// had no `setProblem`, so the host's `setProblem?.()` dropped a page's problem without a word,
// and one did not count a new progress as a change. At the client's root rather than in
// plugins/ because it names the stores the features build on the framework.

const { createPluginHost } = await import('./plugins/host')
const { peekStore, WindowStore } = await import('./plugins/store')
const { storeFactory } = await import('./tsregistry/store')
const { createMtfGraphStore } = await import('./mtf/store')
const { Mtf01Store } = await import('./mtf01/store')
const { BarStore } = await import('./volprofile/source')
const { RunStore } = await import('./lab/plugin')

/** Every store class a source can be given, by name. */
const KINDS: Array<[string, (key: string) => SourceStore]> = [
  ['WindowStore', (key) => new WindowStore(key)],
  ['RegistryStore', (key) => storeFactory(null)(key)],
  ['MtfGraphStore', createMtfGraphStore],
  ['Mtf01Store', (key) => new Mtf01Store(key)],
  ['BarStore', (key) => new BarStore(key)],
  ['RunStore', (key) => new RunStore(key)]
]

const WHY = 'the 4h timeframe could not be read'

const hosts: Array<{ teardown(): void }> = []
afterEach(() => {
  for (const host of hosts.splice(0)) host.teardown()
})

/** A plugin whose one source is a store of `create`'s class and whose every page is partial. */
function partialPlugin(name: string, create: (key: string) => SourceStore): IndicatorPlugin {
  return {
    id: `kind-${name}`,
    feature: null,
    register: (): IndicatorGroup[] => [],
    matches: (template) => template === name,
    bind: () => ({
      sources: [
        {
          id: 'v',
          key: `kind|${name}`,
          createStore: create,
          fetch: async (): Promise<Page<never>> => ({ points: [], nextFrom: null, problem: WHY })
        }
      ],
      label: () => name
    })
  }
}

describe('every source store', () => {
  for (const [name, create] of KINDS) {
    test(`${name}: a page's problem reaches the store and the legend's warning`, async () => {
      // Read again only after a minute, so the problem stands for the whole test.
      const host = await createPluginHost({ plugins: [partialPlugin(name, create)], facilities: fakeFacilities(), partialRetryMs: 60_000 })
      hosts.push(host)
      const fc = fakeChart()
      fc.data = [{ timestamp: 1 }]
      fc.indicators = [fakeIndicator(name, 'i1')]
      host.sync([fakePane('p1', fc.chart)])
      await flush()
      await flush()
      expect(peekStore<SourceStore>(`kind|${name}`)?.problem).toBe(WHY)
      const last = fc.overrides.at(-1) as { extendData?: { problem?: unknown } } | undefined
      expect(last?.extendData?.problem).toBe(WHY)
    })

    test(`${name}: a problem set and cleared is a change each time, and set again is none`, () => {
      const store = create('k')
      const before = store.rev
      store.setProblem(WHY)
      expect(store.problem).toBe(WHY)
      expect(store.rev).toBeGreaterThan(before)
      const set = store.rev
      store.setProblem(WHY)
      expect(store.rev).toBe(set)
      store.setProblem(null)
      expect(store.problem).toBeNull()
      expect(store.rev).toBeGreaterThan(set)
    })

    test(`${name}: a server's new progress is a change, and the same status set again is none`, () => {
      const store = create('k')
      store.setPhase('replaying', 0.25)
      const first = store.rev
      store.setPhase('replaying', 0.5)
      expect(store.progress).toBe(0.5)
      expect(store.rev).toBeGreaterThan(first)
      store.setPhase('ready')
      const ready = store.rev
      expect(store.progress).toBeNull()
      store.setPhase('ready')
      expect(store.rev).toBe(ready)
      store.setPhase('error', null, '500 from the server')
      expect(store.error).toBe('500 from the server')
      expect(store.rev).toBeGreaterThan(ready)
    })
  }
})
