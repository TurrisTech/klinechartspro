import { describe, expect, test } from 'bun:test'
import type { ReplayBar } from '../replay/cache'
import type { LabEntry } from './entries'
import type { LabSignal, Readings } from './graph'
import { type CandleGrid, FX_GRID } from '../replay/timeframes'
import { defaultExits, defaultSizing, type ExitSpec, type Sizing } from './model'
import { simulate, type SimInput } from './trades'

// The simulated trades, bar by bar, against the fill engine's rules: a long buys the ask at the
// entry close and is stopped on the bid; a bar reaching stop and target takes the stop.

const M = 60_000
const T0 = Date.UTC(2026, 0, 6, 10)
const PIP = 0.0001
const SPREAD = 0.0002

/** A 1m bar at index i, its mid OHLC given, bid/ask half a spread either side. */
function bar(i: number, o: number, h: number, l: number, c: number): ReplayBar {
  const half = SPREAD / 2
  const side = (d: number) => ({ o: o + d, h: h + d, l: l + d, c: c + d })
  return { open: T0 + i * M, end: T0 + (i + 1) * M, date: T0 + i * M, o, h, l, c, v: 1, bid: side(-half), ask: side(half) }
}

function entry(at: number, direction: 'long' | 'short', interval = '1m'): LabEntry {
  const signal: LabSignal = {
    key: `s|${interval}|${at}`,
    source: 's',
    interval,
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

function run(bars: ReplayBar[], entries: LabEntry[], exits: Partial<ExitSpec> = {}, sizing: Partial<Sizing> = {}, exitRule?: (t: number) => boolean, path: { ms: number; grid: CandleGrid | null } = { ms: M, grid: null }) {
  const input: SimInput = {
    symbol: 'oanda:EURUSD',
    entries,
    bars,
    pathMs: path.ms,
    grid: path.grid,
    exits: { ...defaultExits(), maxBars: null, ...exits },
    sizing: { ...defaultSizing(), mode: 'units', units: 10_000, ...sizing },
    pip: PIP,
    readings,
    levels: {},
    levelEnv: () => ({ get: () => undefined, call: () => undefined }),
    exitRule: () => exitRule ?? null
  }
  return simulate(input)
}

const flat = (i: number, p = 1.1) => bar(i, p, p, p, p)

describe('stops and targets', () => {
  test('a long reaches its 1R target: in at the ask, out at the target', () => {
    // Stop 10 pips under the 1.1000 mid close, target 1R (10 pips) over it.
    const bars = [flat(0), bar(1, 1.1, 1.1012, 1.0998, 1.101)]
    const result = run(bars, [entry(bars[0].end, 'long')], { stop: { kind: 'pips', value: 10 }, target: { kind: 'r', mult: 1 } })
    const [trade] = result.trades
    expect(trade.openPrice).toBeCloseTo(1.1001, 10)
    expect(trade.stop).toBeCloseTo(1.099, 10)
    expect(trade.target).toBeCloseTo(1.101, 10)
    expect(trade.reason).toBe('target')
    expect(trade.closePrice).toBeCloseTo(1.101, 10)
    expect(trade.pnl).toBeCloseTo((1.101 - 1.1001) * 10_000, 6)
    // One R is measured from the fill: 11 pips of risk, 9 of gain.
    expect(trade.r).toBeCloseTo(9 / 11, 6)
    expect(result.stats.wins).toBe(1)
  })

  test('a short is stopped on the ask', () => {
    const bars = [flat(0), bar(1, 1.1, 1.1011, 1.0999, 1.1005)]
    const [trade] = run(bars, [entry(bars[0].end, 'short')], { stop: { kind: 'pips', value: 10 }, target: null }).trades
    expect(trade.openPrice).toBeCloseTo(1.0999, 10)
    expect(trade.reason).toBe('stop')
    expect(trade.closePrice).toBeCloseTo(1.101, 10)
    expect(trade.pnl as number).toBeLessThan(0)
  })

  test('one bar reaching both takes the stop', () => {
    const bars = [flat(0), bar(1, 1.1, 1.103, 1.097, 1.1)]
    const [trade] = run(bars, [entry(bars[0].end, 'long')], { stop: { kind: 'pips', value: 10 }, target: { kind: 'r', mult: 1 } }).trades
    expect(trade.reason).toBe('stop')
  })

  test('an ATR stop, sized by risk', () => {
    const bars = [flat(0), flat(1), bar(2, 1.1, 1.1, 1.098, 1.0985)]
    const [trade] = run(bars, [entry(bars[0].end, 'long')], { stop: { kind: 'atr', mult: 1.5, period: 14, interval: null }, target: null }, { mode: 'risk', riskPercent: 1, balance: 100_000 }).trades
    // 1.5 x 0.001 under the mid: 1.0985. Risk 1% of 100k over 0.0015 of distance.
    expect(trade.stop).toBeCloseTo(1.0985, 10)
    expect(trade.units).toBe(Math.floor(1000 / 0.0015))
    expect(trade.reason).toBe('stop')
  })
})

describe('management at the close', () => {
  test('a time exit after N bars of the entry timeframe', () => {
    const bars = [flat(0), flat(1), flat(2), flat(3), flat(4)]
    const [trade] = run(bars, [entry(bars[0].end, 'long')], { stop: null, target: null, maxBars: { count: 2, interval: null } }).trades
    expect(trade.reason).toBe('time')
    expect(trade.closedAt).toBe(bars[2].end)
    expect(trade.barsHeld).toBe(2)
  })

  test("a time exit in bars of a chosen timeframe closes on that timeframe's closes", () => {
    // FX daily path bars from Thu 2026-01-15 for ten weeks, on the FX week: a day opens 17:00 New
    // York the evening before and the weekend belongs to no candle.
    const bars: ReplayBar[] = []
    for (let open = FX_GRID.start('1D', Date.UTC(2026, 0, 15, 12)); bars.length < 50; open = FX_GRID.nextStart('1D', open)) {
      const half = SPREAD / 2
      const side = (d: number) => ({ o: 1.1 + d, h: 1.1 + d, l: 1.1 + d, c: 1.1 + d })
      bars.push({ open, end: FX_GRID.end('1D', open), date: open, o: 1.1, h: 1.1, l: 1.1, c: 1.1, v: 1, bid: side(-half), ask: side(half) })
    }
    const daily = { ms: 86_400_000, grid: FX_GRID }
    const at = bars[0].end // Thu 2026-01-15 17:00 New York
    const closeOf = (count: number, interval: string) => run(bars, [entry(at, 'long', '1D')], { stop: null, target: null, maxBars: { count, interval } }, {}, undefined, daily).trades[0]
    const ny = (ms: number | null) => new Date((ms as number) - 5 * 3_600_000).toISOString().slice(0, 16)

    // The month it opened in closes 17:00 on its last market day, Fri 30 January.
    expect(closeOf(1, '1M').reason).toBe('time')
    expect(ny(closeOf(1, '1M').closedAt)).toBe('2026-01-30T17:00')
    expect(ny(closeOf(2, '1M').closedAt)).toBe('2026-02-27T17:00')
    // A week closes Friday 17:00: one bar is this week's close, two the next one's -- not 7 or
    // 14 trading days.
    expect(ny(closeOf(1, '1W').closedAt)).toBe('2026-01-16T17:00')
    expect(ny(closeOf(2, '1W').closedAt)).toBe('2026-01-23T17:00')
    // Days are market days: two from Thursday's close are Friday's and Monday's.
    expect(ny(closeOf(2, '1D').closedAt)).toBe('2026-01-19T17:00')
  })

  test('without a grid a chosen timeframe still ends, by its nominal length', () => {
    const bars = Array.from({ length: 50 }, (_, i) => ({ ...flat(i), open: T0 + i * 86_400_000, end: T0 + (i + 1) * 86_400_000, date: T0 + i * 86_400_000 }))
    const [trade] = run(bars, [entry(bars[0].end, 'long')], { stop: null, target: null, maxBars: { count: 1, interval: '1M' } }, {}, undefined, { ms: 86_400_000, grid: null }).trades
    expect(trade.reason).toBe('time')
    expect(trade.barsHeld).toBe(30)
  })

  test('breakeven: the stop moves to the entry and the trade is then stopped there', () => {
    const bars = [flat(0), bar(1, 1.1, 1.1012, 1.1, 1.1012), bar(2, 1.1012, 1.1012, 1.0995, 1.0996)]
    const [trade] = run(bars, [entry(bars[0].end, 'long')], { stop: { kind: 'pips', value: 10 }, target: null, breakevenAtR: 1 }).trades
    expect(trade.reason).toBe('breakeven')
    expect(trade.closePrice).toBeCloseTo(1.1001, 10)
  })

  test('a trailing stop follows the best close and only tightens', () => {
    const bars = [flat(0), bar(1, 1.1, 1.102, 1.1, 1.102), bar(2, 1.102, 1.103, 1.101, 1.1015), bar(3, 1.1015, 1.1016, 1.1005, 1.1008)]
    const [trade] = run(bars, [entry(bars[0].end, 'long')], { stop: { kind: 'pips', value: 10 }, target: null, trail: { distance: { kind: 'pips', value: 10 }, activateR: 0 } }).trades
    // Best close 1.1020 after bar 1: the stop is 1.1010, and stays there through bar 2's lower close.
    expect(trade.reason).toBe('trail')
    expect(trade.closePrice).toBeCloseTo(1.101, 10)
  })

  test('a rule exit at the first close it holds', () => {
    const bars = [flat(0), flat(1), flat(2), flat(3)]
    const at = bars[2].end
    const [trade] = run(bars, [entry(bars[0].end, 'long')], { stop: null, target: null }, {}, (t) => t >= at).trades
    expect(trade.reason).toBe('rule')
    expect(trade.closedAt).toBe(at)
  })

  test('at most maxOpen at once, and the opposite entry closes the other way first', () => {
    const bars = [flat(0), flat(1), flat(2), flat(3)]
    const busy = run(bars, [entry(bars[0].end, 'long'), entry(bars[1].end, 'long')], { stop: null, target: null })
    expect(busy.trades).toHaveLength(1)
    expect(busy.skipped[0].reason).toContain('already open')
    const flip = run(bars, [entry(bars[0].end, 'long'), entry(bars[1].end, 'short')], { stop: null, target: null, onOpposite: true })
    expect(flip.trades.map((t) => [t.direction, t.reason])).toEqual([
      ['long', 'opposite'],
      ['short', 'end']
    ])
  })

  test('an entry no path bar closes at is refused, not moved', () => {
    const bars = [flat(0), flat(1)]
    const result = run(bars, [entry(bars[0].end + 30_000, 'long')])
    expect(result.trades).toHaveLength(0)
    expect(result.skipped[0].reason).toContain('no path bar')
  })
})

test('stats', () => {
  const bars = [flat(0), bar(1, 1.1, 1.1012, 1.1, 1.101), flat(2, 1.101), bar(3, 1.101, 1.1011, 1.0999, 1.1)]
  const result = run(bars, [entry(bars[0].end, 'long'), entry(bars[2].end, 'long')], { stop: { kind: 'pips', value: 10 }, target: { kind: 'r', mult: 1 } })
  expect(result.stats.trades).toBe(2)
  expect(result.stats.wins).toBe(1)
  expect(result.stats.losses).toBe(1)
  expect(result.stats.winRate).toBe(0.5)
  expect(result.stats.byReason).toEqual({ target: 1, stop: 1 })
  expect(result.stats.maxDrawdown).toBeGreaterThan(0)
})
