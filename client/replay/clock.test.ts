import { describe, expect, test } from 'bun:test'
import type { SimOrder, SimTrade } from '../trading/api'
import { hasWorking, intersectsWorking, planAdvance, targetOf } from './clock'
import { fromWall } from './timeframes'

function ny(text: string): number {
  const [d, t] = text.split(' ')
  const [y, m, day] = d.split('-').map(Number)
  const [h, mi] = t.split(':').map(Number)
  return fromWall(Date.UTC(y, m - 1, day, h, mi), 'America/New_York')
}

const order = (over: Partial<SimOrder>): SimOrder => ({
  id: 'o1',
  symbol: 'oanda:EURUSD',
  side: 'buy',
  type: 'limit',
  units: 1,
  price: 1.1,
  stopLoss: null,
  takeProfit: null,
  status: 'pending',
  createdAt: 0,
  filledAt: null,
  fillPrice: null,
  tradeId: null,
  label: null,
  ...over
})

const trade = (over: Partial<SimTrade>): SimTrade => ({
  id: 't1',
  symbol: 'oanda:EURUSD',
  side: 'buy',
  units: 1,
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
})

describe('planAdvance', () => {
  const cursor = ny('2024-03-04 10:00')
  test('the target is N whole candles on the boundary rules', () => {
    expect(targetOf(cursor, { interval: '1h', multiple: 3 })).toBe(ny('2024-03-04 13:00'))
    expect(targetOf(cursor, { toEnd: true, end: 123 })).toBe(123)
  })
  test('an armed signal before the target wins', () => {
    const plan = planAdvance(cursor, { interval: '4h', multiple: 2 }, [
      { ref: 'arev:arev21:long', resolution: '1h', effective: ny('2024-03-04 12:00'), date: ny('2024-03-04 11:00') },
      { ref: 'krev:krev01:top', resolution: '1h', effective: ny('2024-03-04 15:00'), date: 0 }
    ])
    // The 4h grid is anchored at 17:00: 09:00-13:00 then 13:00-17:00.
    expect(plan.target).toBe(ny('2024-03-04 17:00'))
    expect(plan.stopAt).toBe(ny('2024-03-04 12:00'))
    expect(plan.reason).toBe('signal')
    expect(plan.signal?.ref).toBe('arev:arev21:long')
  })
  test('a signal at the cursor or after the target does not stop the advance', () => {
    const plan = planAdvance(cursor, { interval: '1h', multiple: 2 }, [
      { ref: 'a', resolution: '1h', effective: cursor, date: 0 },
      { ref: 'b', resolution: '1h', effective: ny('2024-03-04 12:01'), date: 0 }
    ])
    expect(plan.reason).toBe('target')
    expect(plan.stopAt).toBe(ny('2024-03-04 12:00'))
  })
  test('a signal exactly at the target stops with reason signal', () => {
    const plan = planAdvance(cursor, { interval: '1h', multiple: 2 }, [{ ref: 'a', resolution: '1h', effective: ny('2024-03-04 12:00'), date: 0 }])
    expect(plan.reason).toBe('signal')
    expect(plan.stopAt).toBe(plan.target)
  })
  test('next-signal is an advance to the end of the data', () => {
    const plan = planAdvance(cursor, { toEnd: true, end: ny('2024-12-31 17:00') }, [{ ref: 'a', resolution: '1h', effective: ny('2024-03-06 12:00'), date: 0 }])
    expect(plan.stopAt).toBe(ny('2024-03-06 12:00'))
  })
})

describe('intersectsWorking', () => {
  const band = { bidLow: 1.099, bidHigh: 1.101, askLow: 1.0992, askHigh: 1.1012 }
  const sym = 'oanda:EURUSD'
  test('nothing working: no descent', () => {
    expect(hasWorking([], [], sym)).toBe(false)
    expect(intersectsWorking(band, [], [], sym)).toBe(false)
  })
  test('a buy limit is tested against the ask band', () => {
    expect(intersectsWorking(band, [order({ side: 'buy', price: 1.0991 })], [], sym)).toBe(false)
    expect(intersectsWorking(band, [order({ side: 'buy', price: 1.0992 })], [], sym)).toBe(true)
    expect(intersectsWorking(band, [order({ side: 'buy', type: 'stop', price: 1.1012 })], [], sym)).toBe(true)
    expect(intersectsWorking(band, [order({ side: 'buy', type: 'stop', price: 1.1013 })], [], sym)).toBe(false)
  })
  test('a sell order is tested against the bid band', () => {
    expect(intersectsWorking(band, [order({ side: 'sell', price: 1.101 })], [], sym)).toBe(true)
    expect(intersectsWorking(band, [order({ side: 'sell', price: 1.1011 })], [], sym)).toBe(false)
  })
  test("a long's protection is tested on the bid, a short's on the ask", () => {
    expect(intersectsWorking(band, [], [trade({ side: 'buy', stopLoss: 1.099 })], sym)).toBe(true)
    expect(intersectsWorking(band, [], [trade({ side: 'buy', stopLoss: 1.0989 })], sym)).toBe(false)
    expect(intersectsWorking(band, [], [trade({ side: 'sell', takeProfit: 1.0992 })], sym)).toBe(true)
    expect(intersectsWorking(band, [], [trade({ side: 'sell', takeProfit: 1.0991 })], sym)).toBe(false)
  })
  test('other symbols, filled orders and closed trades are ignored', () => {
    expect(intersectsWorking(band, [order({ symbol: 'oanda:GBPUSD', price: 1.1 })], [], sym)).toBe(false)
    expect(intersectsWorking(band, [order({ status: 'filled', price: 1.1 })], [], sym)).toBe(false)
    expect(intersectsWorking(band, [], [trade({ stopLoss: 1.1, closedAt: 1 })], sym)).toBe(false)
    expect(hasWorking([order({ status: 'cancelled' })], [trade({ closedAt: 1 })], sym)).toBe(false)
  })
})
