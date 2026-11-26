import { describe, expect, test } from 'bun:test'
import type { KLineData } from 'klinecharts'
import { FX_GRID } from '../replay/timeframes'
import type { SimSnapshot, SimTrade } from './api'
import {
  accountStart,
  chooseStep,
  MAX_BUCKETS,
  markInterval,
  marksFrom,
  marksNeeded,
  perfModel,
  perfWindow,
  periodEnds,
  rangeStart
} from './performance'

const HOUR = 3_600_000
const DAY = 24 * HOUR

function trade(over: Partial<SimTrade> = {}): SimTrade {
  return {
    id: 't1',
    symbol: 'oanda:EURUSD',
    side: 'buy',
    units: 10_000,
    entryPrice: 1.1,
    openedAt: 0,
    orderId: 'o1',
    stopLoss: null,
    takeProfit: null,
    closedAt: null,
    closePrice: null,
    closeReason: null,
    realizedPnl: null,
    label: null,
    ...over
  }
}

function snapshot(trades: SimTrade[], balance: number, equity = balance): Pick<SimSnapshot, 'trades' | 'account' | 'createdAt'> {
  return { createdAt: 0, trades, account: { currency: 'USD', initialBalance: 10_000, balance, unrealizedPnl: equity - balance, equity } }
}

describe('the window a range button means', () => {
  test('whole calendar months back, clamped to the shorter month', () => {
    const now = Date.UTC(2026, 2, 31, 12) // 31 March
    expect(new Date(rangeStart('1M', now)).toISOString()).toBe('2026-02-28T12:00:00.000Z')
    expect(new Date(rangeStart('3M', now)).toISOString()).toBe('2025-12-31T12:00:00.000Z')
    expect(new Date(rangeStart('1Y', now)).toISOString()).toBe('2025-03-31T12:00:00.000Z')
    expect(rangeStart('all', now)).toBe(Number.NEGATIVE_INFINITY)
  })

  test('a range older than the account begins at the account, and says so', () => {
    const now = Date.UTC(2026, 10, 13)
    const young = perfWindow('1M', now, now - 5 * DAY)
    expect(young).toEqual({ from: now - 5 * DAY, to: now, clamped: true })
    const old = perfWindow('1M', now, now - 90 * DAY)
    expect(old.clamped).toBe(false)
    expect(old.from).toBe(rangeStart('1M', now))
    expect(perfWindow('all', now, now - 90 * DAY)).toEqual({ from: now - 90 * DAY, to: now, clamped: true })
  })

  test('the account begins at a replay’s start, else its creation -- or an earlier trade', () => {
    expect(accountStart({ createdAt: 5_000, trades: [] })).toBe(5_000)
    expect(accountStart({ createdAt: 5_000, trades: [] }, 1_000)).toBe(1_000)
    expect(accountStart({ createdAt: 5_000, trades: [trade({ openedAt: 2_000 })] })).toBe(2_000)
  })
})

describe('periods', () => {
  test('the finest step that keeps the bars under the cap', () => {
    expect(chooseStep(2 * HOUR)).toBe('1m')
    expect(chooseStep(2 * DAY)).toBe('1h')
    expect(chooseStep(31 * DAY)).toBe('1D')
    expect(chooseStep(92 * DAY)).toBe('1D')
    expect(chooseStep(183 * DAY)).toBe('1W')
    expect(chooseStep(366 * DAY)).toBe('1W')
    expect(chooseStep(20 * 365 * DAY)).toBe('1M')
    expect(92 * DAY / DAY).toBeLessThanOrEqual(MAX_BUCKETS)
  })

  test('on the FX grid, days close at 17:00 New York and the weekend is no period', () => {
    // Thu 5 Nov 2026 12:00 New York (17:00Z) -> Tue 10 Nov 12:00 New York.
    const from = Date.UTC(2026, 10, 5, 17)
    const to = Date.UTC(2026, 10, 10, 17)
    const ends = periodEnds(from, to, '1D', FX_GRID)
    // Thu, Fri, Mon closes at 17:00 New York (22:00Z after the DST change on 1 Nov), then now.
    expect(ends.map((t) => new Date(t).toISOString())).toEqual([
      '2026-11-05T22:00:00.000Z',
      '2026-11-06T22:00:00.000Z',
      '2026-11-09T22:00:00.000Z',
      '2026-11-10T17:00:00.000Z'
    ])
  })

  test('starting inside the closed window, the first period is the next session’s', () => {
    const saturday = Date.UTC(2026, 10, 7, 15)
    const ends = periodEnds(saturday, Date.UTC(2026, 10, 10, 17), '1D', FX_GRID)
    expect(new Date(ends[0]).toISOString()).toBe('2026-11-09T22:00:00.000Z')
  })

  test('with no grid, equal steps on the epoch', () => {
    expect(periodEnds(30 * 60_000, 3 * HOUR + 5, '1h', null)).toEqual([HOUR, 2 * HOUR, 3 * HOUR, 3 * HOUR + 5])
    expect(periodEnds(10, 10, '1h', null)).toEqual([10])
  })

  test('past equity is marked on hours from an hour up, minutes below', () => {
    expect(markInterval('15m')).toBe('1m')
    expect(markInterval('1h')).toBe('1h')
    expect(markInterval('1W')).toBe('1h')
  })
})

describe('marks', () => {
  test('only the instruments with something open at an instant, over just that span plus a bar', () => {
    const s = snapshot(
      [
        trade({ id: 'a', openedAt: HOUR, closedAt: 4 * HOUR, closePrice: 1.1, realizedPnl: 0 }),
        trade({ id: 'b', symbol: 'oanda:GBPUSD', openedAt: 10 * HOUR, closedAt: 11 * HOUR, closePrice: 1.3, realizedPnl: 0 }),
        trade({ id: 'c', symbol: 'oanda:USDJPY', openedAt: 5 * HOUR })
      ],
      10_000
    )
    const needed = marksNeeded(s, [0, 2 * HOUR, 3 * HOUR, 6 * HOUR], HOUR)
    expect([...needed]).toEqual([
      ['oanda:EURUSD', { from: HOUR, to: 3 * HOUR }],
      ['oanda:USDJPY', { from: 5 * HOUR, to: 6 * HOUR }]
    ])
  })

  test('a mark is the close of the last bar that had CLOSED by then, never the one forming', () => {
    const bar = (timestamp: number, close: number): KLineData => ({ timestamp, open: close, high: close, low: close, close })
    const markAt = marksFrom(new Map([['k', [bar(2 * HOUR, 1.2), bar(0, 1.0), bar(HOUR, 1.1)]]]), HOUR)
    expect(markAt('k', HOUR - 1)).toBeNull()
    expect(markAt('k', HOUR)).toBe(1.0)
    expect(markAt('k', 2 * HOUR + 30 * 60_000)).toBe(1.1)
    expect(markAt('k', 3 * HOUR)).toBe(1.2)
    expect(markAt('other', 3 * HOUR)).toBeNull()
  })
})

describe('the histogram', () => {
  // +100 at 2h, −40 at 5h; a long open since 6h worth +30 now.
  const trades = [
    trade({ id: 'a', openedAt: 0, closedAt: 2 * HOUR, closePrice: 1.11, realizedPnl: 100 }),
    trade({ id: 'b', openedAt: HOUR, closedAt: 5 * HOUR, closePrice: 1.096, realizedPnl: -40 }),
    trade({ id: 'c', openedAt: 6 * HOUR, entryPrice: 1.1 })
  ]
  const s = snapshot(trades, 10_060, 10_090)
  const win = { from: 0, to: 8 * HOUR, clamped: true }
  const ends = [2 * HOUR, 4 * HOUR, 6 * HOUR, 8 * HOUR]

  test('balance: each bar the balance at its end, from the line at the start; the last is the account now', () => {
    const m = perfModel(s, 'balance', win, '1h', ends, null)
    expect(m.base).toBe(10_000)
    expect(m.bars.map((b) => b.value)).toEqual([10_100, 10_100, 10_060, 10_060])
    expect(m.bars.map((b) => b.start)).toEqual([0, 2 * HOUR, 4 * HOUR, 6 * HOUR])
    expect(m.bars.map((b) => b.live)).toEqual([false, false, false, true])
    expect(m.change).toBe(60)
    expect(m.changePercent).toBeCloseTo(0.6, 10)
  })

  test('equity: the open trades marked at each end, and the last bar the engine’s own equity', () => {
    // At 2h trade b (entry 1.1, long 10K) is open; marked at 1.098 it is −20.
    const markAt = (_symbol: string, t: number): number | null => (t === 2 * HOUR || t === 4 * HOUR ? 1.098 : null)
    const m = perfModel(s, 'equity', win, '1h', ends, markAt)
    expect(m.bars.map((b) => Math.round(b.value))).toEqual([10_080, 10_080, 10_060, 10_090])
    // At 6h trade c is open with no mark: counted at entry, and said so.
    expect(m.bars.map((b) => b.unmarked)).toEqual([0, 0, 1, 0])
    expect(m.change).toBe(90)
  })

  test('a window that begins with the account reads its line just before, with nothing open yet', () => {
    // Trade a opens AT the start: marked there it would put the line half a spread down.
    const markAt = (): number => 1.0999
    expect(perfModel(s, 'equity', win, '1h', ends, markAt).base).toBe(10_000)
    // A window inside the account's life reads it at its start, open trades and all.
    const inside = { from: HOUR, to: 8 * HOUR, clamped: false }
    expect(perfModel(s, 'equity', inside, '1h', ends, markAt).base).toBeCloseTo(10_000 - 1 - 1, 6)
  })
})
