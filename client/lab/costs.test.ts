import { describe, expect, test } from 'bun:test'
import type { ReplayBar } from '../replay/cache'
import { FX_GRID } from '../replay/timeframes'
import type { LabEntry } from './entries'
import type { LabSignal, Readings } from './graph'
import { type CostSpec, defaultExits, defaultSizing, type ExitSpec, type Sizing } from './model'
import { financedCloses, simulate, type SimInput } from './trades'

// What a trade pays beyond the spread, and the leverage cap: slippage moves every fill that is not
// a limit, commission is per million each side, financing is charged at each daily close held
// through -- and the P&L, R and balance are net of all of it.

const M = 60_000
const H = 3_600_000
const D = 24 * H
const T0 = Date.UTC(2026, 0, 6, 10) // a Tuesday, 05:00 New York
const PIP = 0.0001
const SPREAD = 0.0002

function bar(i: number, o: number, h: number, l: number, c: number, step = M): ReplayBar {
  const half = SPREAD / 2
  const side = (d: number) => ({ o: o + d, h: h + d, l: l + d, c: c + d })
  return { open: T0 + i * step, end: T0 + (i + 1) * step, date: T0 + i * step, o, h, l, c, v: 1, bid: side(-half), ask: side(half) }
}

function entry(at: number, direction: 'long' | 'short'): LabEntry {
  const signal: LabSignal = {
    key: `s|1m|${at}`,
    source: 's',
    interval: '1m',
    durationMs: M,
    knownAt: at,
    sourceDate: at - M,
    side: direction === 'long' ? 'top' : 'bottom',
    price: 1.1,
    bar: { o: 1.1, h: 1.1, l: 1.1, c: 1.1 },
    label: '',
    raw: {}
  }
  return { id: signal.key, signal, at, side: signal.side, direction, rule: direction, graph: null, node: -1 }
}

const readings: Readings = { pip: PIP, atr: () => 0.001, ind: () => undefined }
const NO_COSTS: CostSpec = { commission: 0, slippagePips: 0, financing: null }

function run(bars: ReplayBar[], entries: LabEntry[], opts: { exits?: Partial<ExitSpec>; sizing?: Partial<Sizing>; costs?: Partial<CostSpec>; pathMs?: number } = {}) {
  const input: SimInput = {
    symbol: 'oanda:EURUSD',
    entries,
    bars,
    pathMs: opts.pathMs ?? M,
    exits: { ...defaultExits(), maxBars: null, ...opts.exits },
    sizing: { ...defaultSizing(), mode: 'units', units: 10_000, ...opts.sizing },
    costs: { ...NO_COSTS, ...opts.costs },
    grid: FX_GRID,
    pip: PIP,
    readings,
    levels: {},
    levelEnv: () => ({ get: () => undefined, call: () => undefined }),
    exitRule: () => null
  }
  return simulate(input)
}

const flat = (i: number, p = 1.1) => bar(i, p, p, p, p)

describe('the leverage cap', () => {
  test('cuts a risk-sized position to the cap of the balance, and says so', () => {
    // 1% of 100k over a 1-pip stop asks for 10M units: 11M notional, 110:1.
    const bars = [flat(0), bar(1, 1.1, 1.1, 1.0985, 1.0995)]
    const result = run(bars, [entry(bars[0].end, 'long')], { exits: { stop: { kind: 'pips', value: 1 }, target: null }, sizing: { mode: 'risk', riskPercent: 1, balance: 100_000, maxLeverage: 50 } })
    const [trade] = result.trades
    expect(trade.units).toBe(Math.floor((50 * 100_000) / 1.1))
    expect(trade.capped).toBe(true)
    expect(result.stats.capped).toBe(1)
  })

  test('no cap: the risk size stands', () => {
    const bars = [flat(0), bar(1, 1.1, 1.1, 1.0985, 1.0995)]
    const [trade] = run(bars, [entry(bars[0].end, 'long')], { exits: { stop: { kind: 'pips', value: 1 }, target: null }, sizing: { mode: 'risk', riskPercent: 1, balance: 100_000, maxLeverage: null } }).trades
    expect(trade.units).toBe(Math.floor(1000 / 0.0001))
    expect(trade.capped).toBe(false)
  })
})

describe('slippage and commission', () => {
  test('slippage worsens the entry and a stop, never a target', () => {
    const stopped = run([flat(0), bar(1, 1.1, 1.1, 1.0985, 1.0995)], [entry(T0 + M, 'long')], { exits: { stop: { kind: 'pips', value: 10 }, target: null }, costs: { slippagePips: 0.5 } }).trades[0]
    // In at the ask (1.1001) half a pip worse; stopped on the bid at the 1.0990 stop, half a pip worse.
    expect(stopped.openPrice).toBeCloseTo(1.10015, 10)
    expect(stopped.reason).toBe('stop')
    expect(stopped.closePrice).toBeCloseTo(1.09895, 10)
    expect(stopped.slippage).toBeCloseTo(2 * 0.00005 * 10_000, 6)
    expect(stopped.pips).toBeCloseTo(-12, 6)

    const target = run([flat(0), bar(1, 1.1, 1.1015, 1.0999, 1.101)], [entry(T0 + M, 'long')], { exits: { stop: { kind: 'pips', value: 10 }, target: { kind: 'pips', value: 10 } }, costs: { slippagePips: 0.5 } }).trades[0]
    expect(target.reason).toBe('target')
    expect(target.closePrice).toBeCloseTo(1.101, 10)
    expect(target.slippage).toBeCloseTo(0.00005 * 10_000, 6)
  })

  test('commission is per million each side, and comes off the P&L, the R and the balance', () => {
    const bars = [flat(0), bar(1, 1.1, 1.1015, 1.0999, 1.101)]
    const plain = run(bars, [entry(T0 + M, 'long')], { exits: { stop: { kind: 'pips', value: 10 }, target: { kind: 'pips', value: 10 } } })
    const paid = run(bars, [entry(T0 + M, 'long')], { exits: { stop: { kind: 'pips', value: 10 }, target: { kind: 'pips', value: 10 } }, costs: { commission: 50 } })
    const [a] = plain.trades
    const [b] = paid.trades
    // 10,000 units: 0.5 a side at 50 a million.
    expect(b.commission).toBeCloseTo(1, 10)
    expect(b.pnl as number).toBeCloseTo((a.pnl as number) - 1, 8)
    expect(b.pips).toBeCloseTo(a.pips as number, 10)
    expect(b.r as number).toBeLessThan(a.r as number)
    expect(b.r as number).toBeCloseTo(((a.pnl as number) - 1) / ((b.risk as number) * 10_000), 8)
    expect(paid.equity.at(-1)?.balance).toBeCloseTo(100_000 + (b.pnl as number), 6)
    expect(paid.stats.costs.commission).toBeCloseTo(1, 10)
  })

  test('with no costs, P&L and R are exactly what they were', () => {
    const bars = [flat(0), bar(1, 1.1, 1.1012, 1.0998, 1.101)]
    const [trade] = run(bars, [entry(bars[0].end, 'long')], { exits: { stop: { kind: 'pips', value: 10 }, target: { kind: 'r', mult: 1 } } }).trades
    expect(trade.r).toBe((1.101 - trade.openPrice) / (trade.risk as number))
    expect(trade.commission + trade.financing + trade.slippage).toBe(0)
  })
})

describe('financing', () => {
  test('daily closes: a weekday pays one day, a Friday the weekend', () => {
    // Tue 05:00 NY to the next Tue 05:00 NY: closes Tue, Wed, Thu, Fri (3 days), Mon.
    const closes = financedCloses(FX_GRID, T0, T0 + 7 * D)
    expect(closes.map((c) => c.days)).toEqual([1, 1, 1, 3, 1])
    expect(closes.reduce((a, c) => a + c.days, 0)).toBe(7)
  })

  test('a trade held through two closes pays two days of its rate on its notional', () => {
    // Hourly path bars from Tue 05:00 NY; the trade opens at the first close and is closed by its
    // time limit 40 hours later -- through the Tue and Wed 17:00 closes.
    const bars = Array.from({ length: 48 }, (_, i) => bar(i, 1.1, 1.1, 1.1, 1.1, H))
    const e = { ...entry(bars[0].end, 'long'), signal: { ...entry(bars[0].end, 'long').signal, interval: '1h', durationMs: H } }
    const result = run(bars, [e], { exits: { stop: null, target: null, maxBars: { count: 40, interval: null } }, costs: { financing: { long: 5, short: -1 } }, pathMs: H })
    const [trade] = result.trades
    expect(trade.reason).toBe('time')
    expect(trade.financing).toBeCloseTo((10_000 * trade.openPrice * 5 * 2) / 100 / 365, 8)
    expect(trade.pnl as number).toBeCloseTo((trade.closePrice as number) * 10_000 - trade.openPrice * 10_000 - trade.financing, 6)
  })
})
