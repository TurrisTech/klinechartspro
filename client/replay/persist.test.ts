import { describe, expect, test } from 'bun:test'
import type { LocalWatchState } from '../watch/local'
import { Engine } from './engine'
import { readIntent, restore, serialize, writeIntent } from './persist'

/** A stored replay watch, as `LocalWatchRegistry.toState()` writes one. */
function watchState(): LocalWatchState {
  return {
    wire: {
      id: 'w1',
      source: 'price',
      target: 'oanda:EURUSD',
      condition: { field: 'price', op: 'crosses', value: 1.1 },
      name: 'EURUSD 1.10000',
      note: '',
      enabled: true,
      trigger: 'edge',
      repeat: 'once',
      cooldownMs: 60_000,
      createdAt: 1,
      updatedAt: 1,
      armedAt: 1,
      lastFiredAt: null,
      fireCount: 0
    },
    status: 'armed',
    previous: { price: { value: 1.09, low: 1.089, high: 1.0905 } },
    wasTrue: false,
    firedSinceArm: null
  }
}

describe('replay state blob', () => {
  test('serialize/restore round-trips, with the engine continuing its ids', () => {
    const engine = new Engine(5000)
    engine.onQuote({ symbol: 'oanda:EURUSD', time: 10, bid: 1.1, ask: 1.1002 })
    engine.submit({ symbol: 'oanda:EURUSD', side: 'buy', type: 'market', units: 100 })
    const blob = serialize({
      vendor: 'oanda',
      symbol: 'oanda:EURUSD',
      cursor: 10,
      startedAt: 0,
      base: '1m',
      advance: { interval: '1h', multiple: 2 },
      pauseOnFill: true,
      starred: new Set(['b', 'a']),
      armed: [{ ref: 'a', resolution: '1h' }],
      watches: [watchState()],
      engine: engine.toState()
    })
    const back = restore(JSON.parse(JSON.stringify(blob)))
    expect(back).toEqual(blob)
    expect(back?.starred).toEqual(['a', 'b'])
    // The crossing baseline rides in the blob: a reload compares the next event against the
    // reading the watch was ARMED with, not against wherever the replay has got to.
    expect(back?.watches[0]?.previous).toEqual({ price: { value: 1.09, low: 1.089, high: 1.0905 } })
    const copy = Engine.fromState((back as NonNullable<typeof back>).engine)
    expect(copy.balance).toBe(5000)
    expect(copy.submit({ symbol: 'oanda:EURUSD', side: 'sell', type: 'market', units: 1 }).order.id).toBe('o3')
  })
  test('restore refuses another version or a malformed blob', () => {
    expect(restore(null)).toBeNull()
    expect(restore({ version: 99 })).toBeNull()
    expect(restore({ version: 1, vendor: 'oanda', symbol: 'x', cursor: 'no', base: '1m' })).toBeNull()
  })
  test('a blob written before replay watches existed restores with none', () => {
    const blob = serialize({
      vendor: 'oanda',
      symbol: 'oanda:EURUSD',
      cursor: 10,
      startedAt: 0,
      base: '1m',
      advance: { interval: '1h', multiple: 1 },
      pauseOnFill: false,
      starred: [],
      armed: [],
      watches: [],
      engine: new Engine(1000).toState()
    })
    const old = JSON.parse(JSON.stringify(blob)) as Record<string, unknown>
    // Not a version bump: refusing these would have thrown away every replay in progress.
    old.watches = undefined
    expect(restore(old)?.watches).toEqual([])
    expect(restore({ ...old, watches: [{ nonsense: true }] })?.watches).toEqual([])
  })
  test('intent survives storage', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    }
    writeIntent(storage, { sessionId: 's1', cursor: 42 })
    expect(readIntent(storage)).toEqual({ sessionId: 's1', cursor: 42 })
    writeIntent(storage, null)
    expect(readIntent(storage)).toBeNull()
    expect(readIntent(null)).toBeNull()
  })
})
