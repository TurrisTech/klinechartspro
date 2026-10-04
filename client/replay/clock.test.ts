import { describe, expect, test } from 'bun:test'
import type { SimOrder, SimTrade } from '../trading/api'
import { canFill, intersectsWorking, planAdvance, targetOf } from './clock'
import { FX_GRID, fromWall } from './timeframes'

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
    expect(targetOf(cursor, { interval: '1h', multiple: 3 }, FX_GRID)).toBe(ny('2024-03-04 13:00'))
    expect(targetOf(cursor, { toEnd: true, end: 123 }, FX_GRID)).toBe(123)
  })
  const alert = (effective: number) => ({ alertId: 'a1', name: 'oversold', effective, readings: '' })
  test('an alert before the target wins', () => {
    const plan = planAdvance(cursor, { interval: '4h', multiple: 2 }, FX_GRID, alert(ny('2024-03-04 12:00')))
    // The 4h grid is anchored at 17:00: 09:00-13:00 then 13:00-17:00.
    expect(plan.target).toBe(ny('2024-03-04 17:00'))
    expect(plan.stopAt).toBe(ny('2024-03-04 12:00'))
    expect(plan.reason).toBe('alert')
    expect(plan.alert?.alertId).toBe('a1')
  })
  test('an alert at the cursor or after the target does not stop the advance', () => {
    for (const at of [cursor, ny('2024-03-04 12:01')]) {
      const plan = planAdvance(cursor, { interval: '1h', multiple: 2 }, FX_GRID, alert(at))
      expect(plan.reason).toBe('target')
      expect(plan.stopAt).toBe(ny('2024-03-04 12:00'))
    }
  })
  test('an alert exactly at the target stops with reason alert', () => {
    const plan = planAdvance(cursor, { interval: '1h', multiple: 2 }, FX_GRID, alert(ny('2024-03-04 12:00')))
    expect(plan.reason).toBe('alert')
    expect(plan.stopAt).toBe(plan.target)
  })
  test('Next alert is an advance to the end of the data that stops at the alert', () => {
    const plan = planAdvance(cursor, { toEnd: true, end: ny('2024-12-31 17:00') }, FX_GRID, alert(ny('2024-03-06 12:00')))
    expect(plan.stopAt).toBe(ny('2024-03-06 12:00'))
    expect(planAdvance(cursor, { toEnd: true, end: ny('2024-12-31 17:00') }, FX_GRID).stopAt).toBe(ny('2024-12-31 17:00'))
  })
})

describe('intersectsWorking', () => {
  const band = { bidLow: 1.099, bidHigh: 1.101, askLow: 1.0992, askHigh: 1.1012 }
  const sym = 'oanda:EURUSD'
  test('nothing working: no descent', () => {
    expect(canFill([], [], sym)).toBe(false)
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
    expect(canFill([order({ status: 'cancelled' })], [trade({ closedAt: 1 })], sym)).toBe(false)
  })
})

describe('canFill -- what makes an advance walk instead of seek', () => {
  const sym = 'oanda:EURUSD'
  test('a resting limit or stop can fill', () => {
    expect(canFill([order({ type: 'limit', price: 1.1 })], [], sym)).toBe(true)
    expect(canFill([order({ type: 'stop', price: 1.1 })], [], sym)).toBe(true)
  })
  test('a protected open trade can close', () => {
    expect(canFill([], [trade({ stopLoss: 1.09 })], sym)).toBe(true)
    expect(canFill([], [trade({ takeProfit: 1.11 })], sym)).toBe(true)
  })
  test('an UNPROTECTED open trade cannot -- no bar can change the account', () => {
    expect(canFill([], [trade({ stopLoss: null, takeProfit: null })], sym)).toBe(false)
  })
  test('filled/cancelled orders, closed trades and other symbols cannot', () => {
    expect(canFill([order({ status: 'filled', price: 1.1 })], [], sym)).toBe(false)
    expect(canFill([order({ status: 'cancelled', price: 1.1 })], [], sym)).toBe(false)
    expect(canFill([], [trade({ stopLoss: 1.09, closedAt: 5 })], sym)).toBe(false)
    expect(canFill([order({ symbol: 'oanda:GBPUSD', price: 1.1 })], [trade({ symbol: 'oanda:GBPUSD', stopLoss: 1 })], sym)).toBe(false)
  })
})
