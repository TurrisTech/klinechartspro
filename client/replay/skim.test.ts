import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import { evaluate, type Observation } from '../alerts/conditions'
import type { BarSource, ReplayBar } from './cache'
import { Engine } from './engine'
import { FX_GRID, fromWall } from './timeframes'

// THE SKIM: a walk with nothing that could fill and only price watches to answer reads coarser
// stored candles wherever no watch could fire on them, and descends to the base bars only near a
// level. The answer must be the walk's -- the same bar, the same instant -- and only the cost
// different. Against a week of synthetic 1m bars whose 1h and 1D candles are folded from them.

installWindow()
const { ReplayTradingSession } = await import('./session')
const { ReplayWatches, observeBar } = await import('./watches')

const M = 60_000
const SYM = 'oanda:EURUSD'
const ny = (iso: string): number => fromWall(Date.parse(`${iso}Z`), 'America/New_York')
// Sunday 17:00 New York: the FX week opens.
const START = ny('2024-03-03T17:00')
const MINUTES = 5 * 1440

/** A wandering mid: a slow swing, a faster one and a drift, a pip of spread. Deterministic. */
function minutes(): ReplayBar[] {
  const out: ReplayBar[] = []
  let open = START
  for (let i = 0; i < MINUTES; i++) {
    const mid = (k: number) => 1.1 + 0.004 * Math.sin(k / 900) + 0.0011 * Math.sin(k / 47) + 0.0000004 * k
    const o = mid(i)
    const c = mid(i + 1)
    const h = Math.max(o, c) + 0.00003
    const l = Math.min(o, c) - 0.00003
    const side = (d: number) => ({ o: o + d, h: h + d, l: l + d, c: c + d })
    out.push({ open, end: open + M, date: open, o, h, l, c, v: 1, bid: side(-0.00005), ask: side(0.00005) })
    open += M
  }
  return out
}

function fold(interval: string, base: ReplayBar[]): ReplayBar[] {
  const buckets = new Map<number, ReplayBar[]>()
  for (const bar of base) {
    const open = FX_GRID.start(interval, bar.open)
    const list = buckets.get(open) ?? []
    list.push(bar)
    buckets.set(open, list)
  }
  const side = (parts: ReplayBar[], key: 'bid' | 'ask') => ({
    o: parts[0][key]?.o as number,
    h: Math.max(...parts.map((p) => p[key]?.h as number)),
    l: Math.min(...parts.map((p) => p[key]?.l as number)),
    c: parts[parts.length - 1][key]?.c as number
  })
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([open, parts]) => ({
      open,
      end: FX_GRID.end(interval, open),
      date: FX_GRID.toWire(interval, open),
      o: parts[0].o,
      h: Math.max(...parts.map((p) => p.h)),
      l: Math.min(...parts.map((p) => p.l)),
      c: parts[parts.length - 1].c,
      v: parts.length,
      bid: side(parts, 'bid'),
      ask: side(parts, 'ask')
    }))
}

const BASE = minutes()
const STORE: Record<string, ReplayBar[]> = { '1m': BASE, '1h': fold('1h', BASE), '1D': fold('1D', BASE) }

class Store implements BarSource {
  /** Base bars handed out, in all. */
  baseRead = 0
  async fetch(_symbol: string, interval: string, from: number, to: number): Promise<ReplayBar[]> {
    const bars = (STORE[interval] ?? []).filter((b) => b.open >= from && b.open < to)
    if (interval === '1m') this.baseRead += bars.length
    return bars
  }
}

/** Where a crossing of `level` first fires walking every 1m bar from `from`: the brute force. */
function bruteForce(from: number, level: number): number | null {
  let previous: Observation | null = null
  for (const bar of BASE) {
    if (bar.end <= from) {
      previous = observeBar(bar)
      continue
    }
    const now = observeBar(bar)
    if (evaluate({ field: 'price', op: 'crosses', value: level }, now, previous) === true) return bar.end
    previous = now
  }
  return null
}

async function replayAt(cursor: number, stored = ['1m', '1h', '1D']) {
  const store = new Store()
  const watches = new ReplayWatches({ symbol: SYM, notify: { notify: (spec) => ({ ...spec, id: 'n', at: 0, read: false }) as never } })
  const session = new ReplayTradingSession({
    id: 's',
    name: 'Replay',
    createdAt: 0,
    vendor: 'oanda',
    grid: FX_GRID,
    symbol: SYM,
    cursor,
    startedAt: cursor,
    base: '1m',
    advance: { interval: '1D', multiple: 1 },
    pauseOnFill: false,
    storedIntervals: stored,
    engine: new Engine(10_000),
    barSource: store,
    dataEnd: () => START + MINUTES * M,
    save: async () => {},
    onAdvanced: () => {},
    observer: watches
  })
  session.setIntervalsInUse(['1m'])
  watches.attach(session)
  await watches.load()
  return { session, watches, store }
}

describe('the skim', () => {
  const cursor = ny('2024-03-04T09:30')

  test('stops on the bar the walk stops on, reading a sliver of the base bars', async () => {
    // A level the price first reaches days ahead: the highest mid of the second half of the week.
    const later = BASE.filter((b) => b.open > ny('2024-03-06T12:00'))
    const level = Number((Math.max(...later.map((b) => observeBar(b).price.high as number)) - 0.0002).toFixed(5))
    const expected = bruteForce(cursor, level)
    expect(expected).not.toBeNull()
    expect(expected as number).toBeGreaterThan(cursor + 1440 * M)

    const { session, watches, store } = await replayAt(cursor)
    await watches.setStopPrice(level)
    expect(watches.stopPrice()).toBe(level)
    const r = await session.runToWatch()
    expect(r?.reason).toBe('watch')
    expect(session.cursor).toBe(expected as number)
    // A walk would have read every minute between; the skim read the hours and minutes near the
    // level only.
    const walked = (expected as number - cursor) / M
    expect(store.baseRead).toBeLessThan(walked / 10)
    // Fired once: the stop is spent, and Run has nothing left to run to.
    expect(watches.stopPrice()).toBeNull()
    // The engine is quoted where the run landed.
    expect(session.snapshot.quotes[SYM].time).toBe(expected as number)
  })

  test('agrees with the walk at every level across the week', async () => {
    const mids = BASE.map((b) => observeBar(b).price.value as number)
    const lo = Math.min(...mids)
    const hi = Math.max(...mids)
    for (let k = 1; k < 12; k++) {
      const level = Number((lo + ((hi - lo) * k) / 12).toFixed(5))
      const expected = bruteForce(cursor, level)
      const { session, watches } = await replayAt(cursor)
      await watches.setStopPrice(level)
      const r = await session.runToWatch()
      if (expected === null) {
        expect(r?.reason).toBe('none')
        expect(session.cursor).toBe(cursor)
      } else {
        expect([level, session.cursor]).toEqual([level, expected])
        expect(r?.reason).toBe('watch')
      }
    }
  })

  test('a Step stops at the same bar', async () => {
    const level = Number((observeBar(BASE.find((b) => b.open === ny('2024-03-05T14:00')) as ReplayBar).price.value as number).toFixed(5))
    const expected = bruteForce(cursor, level) as number
    const { session, watches } = await replayAt(cursor)
    await watches.setStopPrice(level)
    const r = await session.advanceBy({ interval: '1D', multiple: 3 })
    expect(r?.reason).toBe('watch')
    expect(session.cursor).toBe(expected)
  })

  test('never reached: the run is taken back, the stop still armed', async () => {
    const { session, watches, store } = await replayAt(cursor)
    await watches.setStopPrice(1.5)
    const r = await session.runToWatch()
    expect(r?.reason).toBe('none')
    expect(r?.seeking).toBe('watches')
    expect(session.cursor).toBe(cursor)
    expect(watches.stopPrice()).toBe(1.5)
    // Every daily candle was quiet: one read of the head's minutes at most, none after.
    expect(store.baseRead).toBeLessThan(60 * 8)
    // ...and then a level that IS reached is found from where it was.
    const level = Number((observeBar(BASE.find((b) => b.open === ny('2024-03-05T14:00')) as ReplayBar).price.value as number).toFixed(5))
    await watches.setStopPrice(level)
    expect((await session.runToWatch())?.reason).toBe('watch')
    expect(session.cursor).toBe(bruteForce(cursor, level) as number)
  })

  test('with only the base stored there is nothing to skim with, and the walk answers', async () => {
    const level = Number((observeBar(BASE.find((b) => b.open === ny('2024-03-04T15:00')) as ReplayBar).price.value as number).toFixed(5))
    const { session, watches, store } = await replayAt(cursor, ['1m'])
    await watches.setStopPrice(level)
    await session.runToWatch()
    expect(session.cursor).toBe(bruteForce(cursor, level) as number)
    expect(store.baseRead).toBeGreaterThan(0)
  })

  test('Stop is heard between candles', async () => {
    const { session, watches } = await replayAt(cursor)
    await watches.setStopPrice(1.5)
    const run = session.runToWatch()
    session.cancel()
    const r = await run
    expect(r?.reason).toBe('cancel')
  })
})
