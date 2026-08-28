import { afterAll, expect, test } from 'bun:test'
import type { AlertStore as AlertStoreType } from './store'

// `window`/`localStorage` do not exist under bun, and client/config.ts reads window at MODULE
// LOAD (DATASOURCE_BASE_URL) -- store.ts pulls it in through ../capabilities and
// ../preferences. Both are installed before the dynamic import rather than at the top of the
// file, for the reason client/preferences.test.ts spells out: a static import is hoisted
// above them and crashes on load.

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

const { AlertStore, MAX_ALERTS } = await import('./store')

afterAll(() => {
  if (!hadWindow) delete (globalThis as Record<string, unknown>).window
  if (!hadLocalStorage) delete (globalThis as Record<string, unknown>).localStorage
})

/** Never remote in a test: the /preferences half is client/preferences.test.ts's subject. */
function store(): AlertStoreType {
  cells.clear()
  return new AlertStore(false)
}

const draft = { vendor: 'oanda', symbol: 'EURUSD', price: 1.165, reference: 1.162 }

/** `expect(x).not.toBeNull()` narrows nothing, and `!` is a lint error in this repo. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value')
  return value
}


test('the armed side comes from the market, not from the level', () => {
  const alerts = store()
  const above = must(alerts.add({ ...draft, price: 1.165, reference: 1.162 }))
  const below = must(alerts.add({ ...draft, price: 1.155, reference: 1.162 }))
  expect(above.from).toBe('below')
  expect(below.from).toBe('above')
  expect(above.status).toBe('armed')
})

test('an alert is triggered once, however many times it is reported', () => {
  const alerts = store()
  const alert = must(alerts.add(draft))
  expect(must(alerts.markTriggered(alert.id, 1.1651, 5)).status).toBe('triggered')
  // The monitor re-reads the store per frame and a repeated frame must not notify twice.
  expect(alerts.markTriggered(alert.id, 1.1652, 6)).toBeNull()
  expect(alerts.get(alert.id)?.triggeredPrice).toBe(1.1651)
})

test('re-arming resets the side, the clock and the triggered state', async () => {
  const alerts = store()
  const alert = must(alerts.add(draft))
  alerts.markTriggered(alert.id, 1.1651, Date.now())
  await Bun.sleep(2)
  // Moved BELOW a market now at 1.170: the alert is waiting for a fall, not a rise.
  const moved = must(alerts.rearm(alert.id, 1.168, 1.17, 'watch the retest'))
  expect(moved.status).toBe('armed')
  expect(moved.from).toBe('above')
  expect(moved.price).toBe(1.168)
  expect(moved.note).toBe('watch the retest')
  expect(moved.triggeredAt).toBeUndefined()
  // armedAt moves, so a bar that was already forming cannot fire the new level.
  expect(moved.armedAt).toBeGreaterThan(alert.armedAt)
})

test('only instruments with an ARMED alert are watched', () => {
  const alerts = store()
  const one = must(alerts.add(draft))
  alerts.add({ ...draft, symbol: 'GBPUSD', price: 1.3, reference: 1.29 })
  expect(alerts.armedInstruments().map((i) => i.symbol).sort()).toEqual(['EURUSD', 'GBPUSD'])
  alerts.markTriggered(one.id, 1.1651, Date.now())
  expect(alerts.armedInstruments().map((i) => i.symbol)).toEqual(['GBPUSD'])
})

test('an instrument with several alerts is watched once', () => {
  const alerts = store()
  alerts.add(draft)
  alerts.add({ ...draft, price: 1.17 })
  expect(alerts.armedInstruments()).toHaveLength(1)
  expect(alerts.forInstrument('oanda', 'EURUSD')).toHaveLength(2)
  expect(alerts.forInstrument('oanda', 'GBPUSD')).toHaveLength(0)
})

test('subscribers hear the current list immediately, then every change', () => {
  const alerts = store()
  const seen: number[] = []
  const stop = alerts.subscribe((list) => seen.push(list.length))
  const alert = must(alerts.add(draft))
  alerts.remove(alert.id)
  stop()
  alerts.add(draft)
  expect(seen).toEqual([0, 1, 0])
})

test('the list round-trips through the local mirror', () => {
  const alerts = store()
  alerts.add({ ...draft, note: 'break of the weekly high' })
  const raw = must(cells.get('wd.priceAlerts'))
  const restored = new AlertStore(false)
  restored.hydrate(JSON.parse(raw))
  expect(restored.list()[0].note).toBe('break of the weekly high')
})

test('the list is capped', () => {
  const alerts = store()
  for (let i = 0; i < MAX_ALERTS; i += 1) alerts.add({ ...draft, price: 1.1 + i / 10_000 })
  expect(alerts.atCapacity()).toBe(true)
  expect(alerts.add(draft)).toBeNull()
  expect(alerts.list()).toHaveLength(MAX_ALERTS)
})

test('clearTriggered leaves the armed ones alone', () => {
  const alerts = store()
  const one = must(alerts.add(draft))
  alerts.add({ ...draft, price: 1.18 })
  alerts.markTriggered(one.id, 1.1651, Date.now())
  alerts.clearTriggered()
  expect(alerts.list().map((a) => a.price)).toEqual([1.18])
})
