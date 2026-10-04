import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

installWindow()
const { AlertMonitor } = await import('./monitor')
const { ClientAlertStore } = await import('./store')
import type { NotificationSpec } from '../notifications'
import type { OHLCVBar } from '../ohlcv'
import type { StreamListener } from '../stream'
import type { AlertBar } from './compute'
import type { AlertData, Point } from './data'
import type { AlertDefinition, Operand, Rule } from './types'

const H = 3_600_000
// A Tuesday, well inside the FX week, so no bar here closes into a weekend.
const T0 = Date.UTC(2024, 0, 9, 0)
const SYM = 'oanda:EURUSD'
const close: Operand = { kind: 'bar', interval: '1h', field: 'close' }

function bar(i: number, c: number): AlertBar {
  const open = T0 + i * H
  return { open, end: open + H, date: open, o: c, h: c, l: c, c, v: 1 }
}

function frame(i: number, c: number): OHLCVBar {
  return { date: T0 + i * H, open: c, high: c, low: c, close: c, volume: 1 }
}

class FakeStream {
  listeners = new Map<string, Set<StreamListener>>()
  subscribe(vendor: string, symbol: string, interval: string, listener: StreamListener): void {
    const key = `${vendor}:${symbol}@${interval}`
    let set = this.listeners.get(key)
    if (!set) {
      set = new Set()
      this.listeners.set(key, set)
    }
    set.add(listener)
  }
  unsubscribe(vendor: string, symbol: string, interval: string, listener: StreamListener): void {
    this.listeners.get(`${vendor}:${symbol}@${interval}`)?.delete(listener)
  }
  push(interval: string, bar: OHLCVBar, closed = true): void {
    for (const l of this.listeners.get(`oanda:EURUSD@${interval}`) ?? []) l.onBar(bar, closed)
  }
  count(): number {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0)
  }
}

class FakeData implements AlertData {
  points_: Point[] = []
  constructor(public history: AlertBar[]) {}
  async bars(): Promise<AlertBar[]> {
    return this.history
  }
  async points(_s: unknown, _sym: string, _i: string, from: number, to: number): Promise<Point[]> {
    return this.points_.filter((p) => p.date >= from && p.date < to)
  }
}

function setup(history: AlertBar[], at: number) {
  let clock = at
  const store = new ClientAlertStore({ load: async () => undefined, save: () => {} })
  const stream = new FakeStream()
  const data = new FakeData(history)
  const raised: NotificationSpec[] = []
  const monitor = new AlertMonitor({
    store,
    data,
    stream,
    catalogue: async () => ({
      stored: [
        {
          entry: { name: 'arev21', title: 'AREV21' } as never,
          plugin: 'arev',
          variant: 'arev21',
          foldBy: null,
          series: [{ key: 'p', label: 'p' } as never]
        }
      ],
      signals: []
    }),
    notify: {
      notify: (spec) => {
        raised.push(spec)
        return spec as never
      }
    },
    now: () => clock,
    settleMs: 0,
    pollMs: 5,
    graceMs: 60 * H
  })
  monitor.start()
  return { store, stream, data, raised, monitor, setClock: (t: number) => (clock = t) }
}

function definition(rule: Rule, extra: Partial<AlertDefinition> = {}): AlertDefinition {
  return { name: 'above', note: '', enabled: true, symbol: SYM, rule, trigger: 'level', repeat: 'always', cooldownMs: 0, ...extra }
}

const settle = (): Promise<void> => Bun.sleep(20)

describe('AlertMonitor', () => {
  const history = Array.from({ length: 50 }, (_, i) => bar(i, 1.1))

  test('never fires on history, fires on a closed bar, and only on a closed one', async () => {
    const env = setup([...history.slice(0, 49), bar(49, 1.3)], T0 + 50 * H)
    // The rule ALREADY holds on the newest closed bar: that is the baseline, not news.
    await env.store.create(definition({ left: close, op: '>', right: { value: 1.2 } }))
    await settle()
    expect(env.raised).toEqual([])
    env.stream.push('1h', frame(50, 1.25), false)
    await settle()
    expect(env.raised).toEqual([])
    env.setClock(T0 + 51 * H)
    env.stream.push('1h', frame(50, 1.25), true)
    await settle()
    expect(env.raised.length).toBe(1)
    expect(env.raised[0]).toMatchObject({ title: 'above', source: 'alert', level: 'alert', data: { eventAt: T0 + 51 * H } })
    expect(env.raised[0].body).toContain('EURUSD')
    expect(env.store.list()[0]).toMatchObject({ fireCount: 1, lastFiredAt: T0 + 51 * H })
  })

  test('edge fires once per episode; level at every close', async () => {
    const env = setup(history, T0 + 50 * H)
    await env.store.create(definition({ left: close, op: '>', right: { value: 1.2 } }, { name: 'level' }))
    await env.store.create(definition({ left: close, op: '>', right: { value: 1.2 } }, { name: 'edge', trigger: 'edge' }))
    await settle()
    for (const [i, c] of [[50, 1.25], [51, 1.26], [52, 1.1], [53, 1.3]] as const) {
      env.setClock(T0 + (i + 1) * H)
      env.stream.push('1h', frame(i, c))
      await settle()
    }
    const names = env.raised.map((n) => n.title)
    expect(names.filter((n) => n === 'level').length).toBe(3)
    expect(names.filter((n) => n === 'edge').length).toBe(2)
  })

  test('a once alert stops running once it fires; disabling stops one, enabling restarts it', async () => {
    const env = setup(history, T0 + 50 * H)
    const once = await env.store.create(definition({ left: close, op: 'crosses_above', right: { value: 1.2 } }, { repeat: 'once' }))
    await settle()
    expect(env.monitor.running()).toEqual([once.id])
    env.setClock(T0 + 51 * H)
    env.stream.push('1h', frame(50, 1.25))
    await settle()
    expect(env.raised.length).toBe(1)
    expect(env.monitor.running()).toEqual([])
    expect(env.stream.count()).toBe(0)
    await env.store.setEnabled(once.id, false)
    await env.store.setEnabled(once.id, true)
    await settle()
    expect(env.monitor.running()).toEqual([once.id])
  })

  test('waits for a server value that is late for the newest bar, then evaluates it', async () => {
    const p: Operand = { kind: 'series', interval: '1h', indicator: 'arev21', key: 'p' }
    const env = setup(history, T0 + 50 * H)
    env.data.points_ = history.map((b) => ({ date: b.date, p: 0.4 }))
    await env.store.create(definition({ left: p, op: 'crosses_above', right: { value: 0.6 } }))
    await settle()
    env.setClock(T0 + 51 * H)
    env.stream.push('1h', frame(50, 1.1))
    await settle()
    // The bar has closed but its `p` is not written yet: nothing is decided.
    expect(env.raised).toEqual([])
    env.data.points_.push({ date: T0 + 50 * H, p: 0.7 })
    await settle()
    expect(env.raised.length).toBe(1)
  })
})
