import { describe, expect, test } from 'bun:test'
import type { SimSnapshot, SimTrade } from './api'
import {
  balanceSeries,
  balancesBefore,
  closedMove,
  closedShareOfBalance,
  closedTrades,
  equitySeries,
  markToMarket,
  openAt,
  realisedInAccount
} from './ledger'

const HOUR = 3_600_000

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

function closed(id: string, openedAt: number, closedAt: number, pnl: number, over: Partial<SimTrade> = {}): SimTrade {
  return trade({ id, openedAt, closedAt, realizedPnl: pnl, closePrice: 1.1 + pnl / 10_000, closeReason: 'manual', ...over })
}

function snapshot(trades: SimTrade[], balance: number, equity = balance): Pick<SimSnapshot, 'trades' | 'account'> {
  return { trades, account: { currency: 'USD', initialBalance: 10_000, balance, unrealizedPnl: equity - balance, equity } }
}

describe('the balance through time', () => {
  // +100 at 2h, −40 at 5h, +10 at 5h (a partial close at the same instant): 10,000 -> 10,070.
  const trades = [closed('a', 0, 2 * HOUR, 100), closed('b', HOUR, 5 * HOUR, -40), closed('c', HOUR, 5 * HOUR, 10), trade({ id: 'open', openedAt: 6 * HOUR })]
  const s = snapshot(trades, 10_070)

  test('closed trades in the order they closed, ties as the snapshot lists them', () => {
    expect(closedTrades(s).map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  test('each close is measured against the balance just before it, anchored on the balance now', () => {
    const before = balancesBefore(s)
    expect(before.get('a')).toBe(10_000)
    expect(before.get('b')).toBe(10_100)
    expect(before.get('c')).toBe(10_060)
    expect(before.has('open')).toBe(false)
  })

  test('the series is the balance now less every close after each instant; a close AT an instant counts', () => {
    expect(balanceSeries(s, [0, 2 * HOUR - 1, 2 * HOUR, 4 * HOUR, 5 * HOUR, 9 * HOUR])).toEqual([10_000, 10_000, 10_100, 10_100, 10_070, 10_070])
  })

  test('a server balance that does not re-add from the deposit is still the newest figure', () => {
    // The anchor is the reported balance, so the first figure moves with it, not the last.
    expect(balanceSeries(snapshot(trades, 10_075), [0, 9 * HOUR])).toEqual([10_005, 10_075])
  })
})

describe('a closed trade in the account currency', () => {
  test('quoted in the account currency: as booked', () => {
    expect(realisedInAccount(closed('a', 0, 1, 25), { currency: 'USD' })).toBe(25)
  })

  test('based in it: at the close price, its own rate then', () => {
    const t = closed('a', 0, 1, 1_500, { symbol: 'oanda:USDJPY', closePrice: 150 })
    expect(realisedInAccount(t, { currency: 'USD' })).toBeCloseTo(10, 10)
  })

  test('a cross has no rate of its own at the close, and none is invented', () => {
    expect(realisedInAccount(closed('a', 0, 1, 25, { symbol: 'oanda:EURGBP' }), { currency: 'USD' })).toBeNull()
  })

  test('a ticker naming no currency is booked in the account currency', () => {
    expect(realisedInAccount(closed('a', 0, 1, 25, { symbol: 'schwab:SPY' }), { currency: 'USD' })).toBe(25)
  })

  test('share of the balance before it closed; null without a rate or a balance', () => {
    const t = closed('a', 0, 1, 50)
    expect(closedShareOfBalance(t, 10_000, { currency: 'USD' })).toBeCloseTo(0.5, 10)
    expect(closedShareOfBalance(t, undefined, { currency: 'USD' })).toBeNull()
    expect(closedShareOfBalance(t, 0, { currency: 'USD' })).toBeNull()
    expect(closedShareOfBalance(closed('x', 0, 1, 50, { symbol: 'oanda:EURGBP' }), 10_000, { currency: 'USD' })).toBeNull()
  })

  test('the move is in the position’s favour, side-aware', () => {
    expect(closedMove(trade({ side: 'buy', entryPrice: 1.1, closePrice: 1.102, closedAt: 1 }))).toBeCloseTo(0.002, 10)
    expect(closedMove(trade({ side: 'sell', entryPrice: 1.1, closePrice: 1.102, closedAt: 1 }))).toBeCloseTo(-0.002, 10)
    expect(closedMove(trade())).toBeNull()
  })
})

describe('equity through time', () => {
  test('open at an instant: filled at or before it, not yet closed by it', () => {
    const t = trade({ openedAt: HOUR, closedAt: 3 * HOUR })
    expect([0, HOUR, 2 * HOUR, 3 * HOUR].map((at) => openAt(t, at))).toEqual([false, true, true, false])
  })

  test('mark to market as the engine books it: the move times the units, side-aware', () => {
    expect(markToMarket(trade({ side: 'buy', units: 10_000, entryPrice: 1.1 }), 1.101)).toBeCloseTo(10, 8)
    expect(markToMarket(trade({ side: 'sell', units: 10_000, entryPrice: 1.1 }), 1.101)).toBeCloseTo(-10, 8)
  })

  test('the balance then plus each open trade at its mark; one with no mark is counted at entry', () => {
    const s = snapshot(
      [
        closed('a', 0, 2 * HOUR, 100, { symbol: 'oanda:GBPUSD' }),
        trade({ id: 'long', openedAt: HOUR, units: 10_000, entryPrice: 1.1 }),
        trade({ id: 'jpy', symbol: 'oanda:USDJPY', openedAt: 3 * HOUR, entryPrice: 150, units: 1 })
      ],
      10_100
    )
    // EURUSD has a price; GBPUSD and USDJPY have none.
    const marks: Record<string, number> = { 'oanda:EURUSD': 1.102 }
    const points = equitySeries(s, [0, HOUR, 2 * HOUR, 3 * HOUR], (symbol) => marks[symbol] ?? null)
    expect(points.map((p) => Math.round(p.equity * 100) / 100)).toEqual([10_000, 10_020, 10_120, 10_120])
    expect(points.map((p) => p.unmarked)).toEqual([1, 1, 0, 1])
  })
})
