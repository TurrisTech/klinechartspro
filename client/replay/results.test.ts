import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import type { SimSnapshot, SimTrade } from '../trading/api'

// The trading formatters reach config.ts, which reads `window` at import.
installWindow()
const { replayResults, resultHeadline, resultRows } = await import('./results')

// THE SCORE, from snapshots built by hand: which trades count, how they split, and the realised
// curve the drawdown is read off.

const H = 3_600_000
const T0 = Date.UTC(2024, 2, 4, 14)

function trade(id: string, pnl: number | null, closedAt: number | null): SimTrade {
  return {
    id,
    symbol: 'oanda:EURUSD',
    side: 'buy',
    units: 10_000,
    entryPrice: 1.1,
    openedAt: T0,
    orderId: `o${id}`,
    stopLoss: null,
    takeProfit: null,
    closedAt,
    closePrice: closedAt === null ? null : 1.1,
    closeReason: closedAt === null ? null : 'manual',
    realizedPnl: pnl,
    label: null
  }
}

function snapshot(trades: SimTrade[], balance: number, unrealizedPnl = 0): SimSnapshot {
  return {
    id: 's',
    mode: 'replay',
    name: 'Replay',
    createdAt: 0,
    rev: 0,
    account: { currency: 'USD', initialBalance: 10_000, balance, unrealizedPnl, equity: balance + unrealizedPnl },
    quotes: {},
    orders: [],
    trades,
    symbols: []
  }
}

describe('replayResults', () => {
  test('no trades: nothing to score, and nothing pretends otherwise', () => {
    const r = replayResults(snapshot([], 10_000), T0, T0 + 5 * H)
    expect([r.closed, r.net, r.winRate, r.profitFactor, r.expectancy, r.maxDrawdown]).toEqual([0, 0, null, null, null, null])
    expect(r.span).toBe(5 * H)
  })

  test('wins, losses and a scratch trade: the split, the averages and the profit factor', () => {
    const trades = [trade('1', 150, T0 + H), trade('2', -50, T0 + 2 * H), trade('3', 0, T0 + 3 * H), trade('4', 100, T0 + 4 * H), trade('5', -100, T0 + 5 * H)]
    const r = replayResults(snapshot(trades, 10_100), T0, T0 + 6 * H)
    expect([r.closed, r.wins, r.losses]).toEqual([5, 2, 2])
    expect(r.winRate).toBe(40)
    expect([r.avgWin, r.avgLoss]).toEqual([125, -75])
    expect(r.profitFactor).toBeCloseTo(250 / 150)
    expect(r.expectancy).toBe(20)
    expect([r.best, r.worst]).toEqual([150, -100])
    expect([r.realised, r.net, r.netPct]).toEqual([100, 100, 1])
  })

  test('the drawdown is the deepest fall from a previous high, closes taken in time order', () => {
    // Listed out of order on purpose. In time order: +200 (a high of 10,200), -300 (9,900),
    // +50 (9,950), -100 (9,850) -- the deepest fall from the 10,200 high is 350.
    const trades = [trade('d', -100, T0 + 4 * H), trade('a', 200, T0 + H), trade('c', 50, T0 + 3 * H), trade('b', -300, T0 + 2 * H)]
    const r = replayResults(snapshot(trades, 9_850), T0, T0 + 5 * H)
    expect(r.maxDrawdown?.amount).toBe(350)
    expect(r.maxDrawdown?.pct).toBeCloseTo((350 / 10_200) * 100)
  })

  test('only winners: an infinite profit factor and a drawdown of nothing', () => {
    const r = replayResults(snapshot([trade('1', 10, T0 + H), trade('2', 20, T0 + 2 * H)], 10_030), T0, T0 + 3 * H)
    expect(r.profitFactor).toBe(Number.POSITIVE_INFINITY)
    expect(r.maxDrawdown).toEqual({ amount: 0, pct: 0 })
  })

  test('an open trade counts in the net and the open figure, never in the closed split', () => {
    const r = replayResults(snapshot([trade('1', 40, T0 + H), trade('2', null, null)], 10_040, -15), T0, T0 + 2 * H)
    expect([r.closed, r.open, r.unrealised]).toEqual([1, 1, -15])
    expect(r.net).toBe(25)
  })
})

describe('the rows and the headline', () => {
  test('before the first close, only what exists: the open position and the time replayed', () => {
    const r = replayResults(snapshot([trade('1', null, null)], 10_000, -1.5), T0, T0 + 2 * H)
    expect(resultRows(r).map((row) => `${row.label}=${row.value}`)).toEqual(['Open=1 · −1.50', 'Replayed=2h 00m'])
  })

  test('read the way the panel shows them', () => {
    const r = replayResults(snapshot([trade('1', 150, T0 + H), trade('2', -50, T0 + 2 * H), trade('3', null, null)], 10_100, 12.3), T0, T0 + 26 * H)
    expect(resultHeadline(r)).toEqual({ text: '+112.30 USD · +1.12%', tone: 'up' })
    const rows = Object.fromEntries(resultRows(r).map((row) => [row.label, row.value]))
    expect(rows).toEqual({
      Closed: '2',
      'Win rate': '50% · 1W 1L',
      'Profit factor': '3.00',
      Expectancy: '+50.00',
      'Avg win': '+150.00',
      'Avg loss': '−50.00',
      Best: '+150.00',
      Worst: '−50.00',
      'Max drawdown': '−50.00 · 0.49%',
      Open: '1 · +12.30',
      Realised: '+100.00',
      Replayed: '1d 2h'
    })
  })
})
