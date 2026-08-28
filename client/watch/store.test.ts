import { afterAll, expect, test } from 'bun:test'
import type { Watch, WatchDraft } from './types'
import {
  instrumentTarget,
  priceCondition,
  priceDirection,
  priceLevel,
  PRICE_SOURCE
} from './types'

// `window` does not exist under bun, and client/config.ts reads it at MODULE LOAD -- the
// store reaches it through ../capabilities and ./api. It is installed before the dynamic
// import rather than at the top of the file, for the reason client/preferences.test.ts
// spells out: a static import is hoisted above it and crashes on load.

const hadWindow = 'window' in globalThis
;(globalThis as Record<string, unknown>).window = {
  location: { href: 'http://localhost/', origin: 'http://localhost' },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
}

const { WatchStore } = await import('./store')

afterAll(() => {
  if (!hadWindow) delete (globalThis as Record<string, unknown>).window
})

function watch(over: Partial<Watch> = {}): Watch {
  return {
    id: 'w1',
    source: PRICE_SOURCE,
    target: 'oanda:EURUSD',
    condition: priceCondition(1.165),
    name: 'EURUSD 1.16500',
    note: '',
    enabled: true,
    trigger: 'edge',
    repeat: 'once',
    cooldownMs: 60_000,
    createdAt: 1,
    updatedAt: 1,
    armedAt: 1,
    status: 'armed',
    lastFiredAt: null,
    fireCount: 0,
    ...over
  }
}

/** Records every call and answers from a scripted list. */
function fakeApi(initial: Watch[] = []) {
  let rows = [...initial]
  const calls: string[] = []
  let nextId = 100
  return {
    calls,
    rows: () => rows,
    setRows: (next: Watch[]) => {
      rows = next
    },
    fail: false,
    async sources() {
      calls.push('sources')
      return { sources: [{ id: 'price', title: 'Price', description: '', targetHint: '', available: true, fields: [] }], ops: ['crosses'], maxWatches: 200 }
    },
    async list() {
      calls.push('list')
      return [...rows]
    },
    async create(draft: WatchDraft) {
      calls.push('create')
      if (this.fail) throw new Error('refused')
      nextId += 1
      const created = watch({ id: `w${nextId}`, ...draft, note: draft.note ?? '', createdAt: nextId })
      rows = [created, ...rows]
      return created
    },
    async update(id: string, patch: Partial<WatchDraft>) {
      calls.push('update')
      const updated = watch({ ...rows.find((row) => row.id === id), id, ...patch } as Partial<Watch>)
      rows = rows.map((row) => (row.id === id ? updated : row))
      return updated
    },
    async arm(id: string) {
      calls.push('arm')
      const armed = watch({ ...rows.find((row) => row.id === id), id, status: 'armed' } as Partial<Watch>)
      rows = rows.map((row) => (row.id === id ? armed : row))
      return armed
    },
    async remove(id: string) {
      calls.push('remove')
      if (this.fail) throw new Error('refused')
      rows = rows.filter((row) => row.id !== id)
      return { deleted: id }
    }
  }
}

// -- the price-watch shape ---------------------------------------------------------------

test('a level round-trips through the server condition language', () => {
  expect(priceCondition(1.165)).toEqual({ field: 'price', op: 'crosses', value: 1.165 })
  expect(priceLevel(watch())).toBe(1.165)
  expect(priceDirection(watch())).toBe('crosses')
  expect(priceDirection(watch({ condition: priceCondition(1.165, 'crosses_below') }))).toBe(
    'crosses_below'
  )
})

test('a watch the chart has no line for reads as no level, rather than a guess', () => {
  // Everything the server can hold that a price line cannot express: another source, a
  // combinator, another field.
  expect(priceLevel(watch({ source: 'bar', target: 'oanda:EURUSD@1h' }))).toBeNull()
  expect(priceLevel(watch({ condition: { all: [priceCondition(1)] } }))).toBeNull()
  expect(priceLevel(watch({ condition: { field: 'spread', op: '<', value: 0.0002 } }))).toBeNull()
})

test('instrument targets are the server spelling', () => {
  expect(instrumentTarget('oanda', 'EURUSD')).toBe('oanda:EURUSD')
})

// -- the cache -----------------------------------------------------------------------------

test('load reads the catalogue and the list', async () => {
  const api = fakeApi([watch()])
  const store = new WatchStore(api)
  await store.load()
  expect(api.calls.sort()).toEqual(['list', 'sources'])
  expect(store.list()).toHaveLength(1)
  expect(store.catalogue().map((source) => source.id)).toEqual(['price'])
  expect(store.source('price')?.available).toBe(true)
})

test('a failure on either read leaves the wall mountable', async () => {
  const store = new WatchStore({
    sources: async () => {
      throw new Error('offline')
    },
    list: async () => {
      throw new Error('offline')
    },
    create: async () => watch(),
    update: async () => watch(),
    arm: async () => watch(),
    remove: async () => ({})
  })
  await store.load()
  expect(store.list()).toEqual([])
  expect(store.catalogue()).toEqual([])
})

test('forInstrument filters by target, oldest first', async () => {
  const api = fakeApi([
    watch({ id: 'a', createdAt: 2 }),
    watch({ id: 'b', createdAt: 1 }),
    watch({ id: 'c', target: 'oanda:GBPUSD' }),
    watch({ id: 'd', target: 'oanda:EURUSD@1h', source: 'bar' })
  ])
  const store = new WatchStore(api)
  await store.load()
  expect(store.forInstrument('oanda', 'EURUSD').map((row) => row.id)).toEqual(['b', 'a'])
  expect(store.forInstrument('oanda', 'GBPUSD').map((row) => row.id)).toEqual(['c'])
})

test('every mutation replaces the local copy from the server answer', async () => {
  const api = fakeApi()
  const store = new WatchStore(api)
  const created = await store.create({
    source: PRICE_SOURCE,
    target: 'oanda:EURUSD',
    condition: priceCondition(1.165)
  })
  expect(created).not.toBeNull()
  expect(store.list()).toHaveLength(1)

  await store.update(created?.id ?? '', { condition: priceCondition(1.17) })
  expect(priceLevel(store.list()[0])).toBe(1.17)

  await store.remove(created?.id ?? '')
  expect(store.list()).toEqual([])
})

test('a refusal is reported and changes nothing', async () => {
  const api = fakeApi()
  api.fail = true
  const store = new WatchStore(api)
  expect(
    await store.create({ source: PRICE_SOURCE, target: 'oanda:EURUSD', condition: priceCondition(1) })
  ).toBeNull()
  expect(store.list()).toEqual([])
})

test('a failed delete keeps the row, so the line does not vanish on a server error', async () => {
  const api = fakeApi([watch()])
  const store = new WatchStore(api)
  await store.load()
  api.fail = true
  await store.remove('w1')
  expect(store.list()).toHaveLength(1)
})

test('refresh re-reads the list — how a fired watch turns its line grey', async () => {
  const api = fakeApi([watch()])
  const store = new WatchStore(api)
  await store.load()
  api.setRows([watch({ status: 'fired', fireCount: 1 })])
  await store.refresh()
  expect(store.list()[0].status).toBe('fired')
})

test('subscribers hear the current list immediately, then every change', async () => {
  const api = fakeApi([watch()])
  const store = new WatchStore(api)
  await store.load()
  const seen: number[] = []
  const stop = store.subscribe((rows) => seen.push(rows.length))
  await store.create({ source: PRICE_SOURCE, target: 'oanda:EURUSD', condition: priceCondition(2) })
  await store.remove('w1')
  stop()
  await store.remove(store.list()[0].id)
  expect(seen).toEqual([1, 2, 1])
})
