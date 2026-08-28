import { afterAll, expect, test } from 'bun:test'
import type { OHLCVBar } from '../ohlcv'
import type { StreamListener } from '../stream'
import type { AlertStore as AlertStoreType } from './store'
import type { AlertTrigger } from './monitor'

// The monitor against a fake feed. Same window/localStorage preamble as store.test.ts, and
// for the same reason -- ../stream reaches client/config.ts, which reads window at module
// load.

const hadWindow = 'window' in globalThis
const hadLocalStorage = 'localStorage' in globalThis
const cells = new Map<string, string>()
;(globalThis as Record<string, unknown>).window = {
  location: { href: 'http://localhost/', origin: 'http://localhost' },
  get localStorage() {
    return (globalThis as Record<string, unknown>).localStorage
  }
}
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => cells.get(key) ?? null,
  setItem: (key: string, value: string) => {
    cells.set(key, value)
  },
  removeItem: (key: string) => {
    cells.delete(key)
  }
}

const { AlertStore } = await import('./store')
const { AlertMonitor } = await import('./monitor')
const { stream } = await import('./../stream')

// The page's stream client is a singleton, so the fake is installed ON it: assigning here
// shadows the prototype method for every AlertMonitor built below.
const subscribed = new Map<string, StreamListener>()
const realSubscribe = stream.subscribe.bind(stream)
const realUnsubscribe = stream.unsubscribe.bind(stream)
stream.subscribe = (vendor, symbol, interval, listener) => {
  subscribed.set(`${vendor}:${symbol}:${interval}`, listener)
}
stream.unsubscribe = (vendor, symbol, interval) => {
  subscribed.delete(`${vendor}:${symbol}:${interval}`)
}

afterAll(() => {
  stream.subscribe = realSubscribe
  stream.unsubscribe = realUnsubscribe
  if (!hadWindow) delete (globalThis as Record<string, unknown>).window
  if (!hadLocalStorage) delete (globalThis as Record<string, unknown>).localStorage
})

function bar(date: number, close: number, low = close, high = close): OHLCVBar {
  return { date, open: close, high, low, close, volume: 0 }
}

function setup(): { store: AlertStoreType; monitor: InstanceType<typeof AlertMonitor>; fired: AlertTrigger[] } {
  cells.clear()
  subscribed.clear()
  const store = new AlertStore(false)
  const fired: AlertTrigger[] = []
  const monitor = new AlertMonitor(store, (trigger) => fired.push(trigger), '1m')
  return { store, monitor, fired }
}

const draft = { vendor: 'oanda', symbol: 'EURUSD', price: 1.165, reference: 1.162 }

/** `expect(x).not.toBeNull()` narrows nothing, and `!` is a lint error in this repo. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value')
  return value
}


test('it subscribes per instrument, and only while something is armed', () => {
  const { store, monitor } = setup()
  monitor.start()
  expect(monitor.watching()).toEqual([])

  const alert = must(store.add(draft))
  expect(monitor.watching()).toEqual(['oanda:EURUSD'])

  // A second alert on the same instrument shares the one subscription.
  store.add({ ...draft, price: 1.17 })
  expect(monitor.watching()).toEqual(['oanda:EURUSD'])

  store.add({ ...draft, symbol: 'GBPUSD', price: 1.3, reference: 1.29 })
  expect(monitor.watching().sort()).toEqual(['oanda:EURUSD', 'oanda:GBPUSD'])

  store.remove(alert.id)
  store.remove(store.forInstrument('oanda', 'EURUSD')[0].id)
  expect(monitor.watching()).toEqual(['oanda:GBPUSD'])

  monitor.stop()
  expect(monitor.watching()).toEqual([])
})

test('a crossing fires exactly once, and disarms the alert', () => {
  const { store, monitor, fired } = setup()
  monitor.start()
  const alert = must(store.add(draft))
  const feed = must(subscribed.get('oanda:EURUSD:1m'))

  feed.onBar(bar(alert.armedAt + 60_000, 1.1640), false)
  expect(fired).toHaveLength(0)

  feed.onBar(bar(alert.armedAt + 60_000, 1.1652), false)
  expect(fired).toHaveLength(1)
  expect(fired[0].alert.id).toBe(alert.id)
  expect(fired[0].price).toBe(1.1652)
  expect(store.get(alert.id)?.status).toBe('triggered')

  // Every later frame is inert: the alert is no longer armed.
  feed.onBar(bar(alert.armedAt + 120_000, 1.1660), true)
  expect(fired).toHaveLength(1)
})

test('a bar that was already forming when the alert was armed cannot fire it', () => {
  const { store, monitor, fired } = setup()
  monitor.start()
  // Armed ABOVE: waiting for a fall to 1.1600. The bar in progress had already been down to
  // 1.1550 before the alert existed.
  const alert = must(store.add({ ...draft, price: 1.16, reference: 1.162 }))
  const feed = must(subscribed.get('oanda:EURUSD:1m'))

  feed.onBar(bar(alert.armedAt - 30_000, 1.1625, 1.155, 1.163), false)
  expect(fired).toHaveLength(0)

  // The next bar opened after it was armed, so its low counts.
  feed.onBar(bar(alert.armedAt + 30_000, 1.1615, 1.1595, 1.163), true)
  expect(fired).toHaveLength(1)
})

test('backfill after a reconnect reports the crossing it missed', () => {
  const { store, monitor, fired } = setup()
  monitor.start()
  const alert = must(store.add(draft))
  const feed = must(subscribed.get('oanda:EURUSD:1m'))
  feed.onBackfill?.([
    bar(alert.armedAt + 60_000, 1.1630),
    bar(alert.armedAt + 120_000, 1.1648, 1.1640, 1.1655)
  ])
  expect(fired).toHaveLength(1)
  expect(store.get(alert.id)?.status).toBe('triggered')
})

test('a frame for one instrument never fires another instrument’s alert', () => {
  const { store, monitor, fired } = setup()
  monitor.start()
  const euro = must(store.add(draft))
  store.add({ ...draft, symbol: 'GBPUSD', price: 1.3, reference: 1.29 })
  // A price well past BOTH levels, delivered on the EURUSD subscription.
  must(subscribed.get('oanda:EURUSD:1m')).onBar(bar(euro.armedAt + 60_000, 1.4), false)
  expect(fired).toHaveLength(1)
  expect(fired[0].alert.symbol).toBe('EURUSD')
})

test('stopping unsubscribes everything', () => {
  const { store, monitor } = setup()
  monitor.start()
  store.add(draft)
  expect(subscribed.size).toBe(1)
  monitor.stop()
  expect(subscribed.size).toBe(0)
  // A change after stopping is not acted on.
  store.add({ ...draft, symbol: 'USDJPY', price: 150, reference: 149 })
  expect(subscribed.size).toBe(0)
})
