import { describe, expect, test } from 'bun:test'
import type { SimSnapshot, SimTrade } from './api'
import type { InstrumentInfo } from './instrument'
import { findInspected, type Inspected, positionStats } from './stats'

const EURUSD: InstrumentInfo = { precision: 5, pipSize: 0.0001, assetClass: 'forex', marginRate: 0.0333, unitsPrecision: 0 }
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
    stopLoss: 1.098,
    takeProfit: 1.104,
    closedAt: null,
    closePrice: null,
    closeReason: null,
    realizedPnl: null,
    label: null,
    ...over
  }
}

function snapshot(trades: SimTrade[]): SimSnapshot {
  return {
    id: 's',
    mode: 'paper',
    name: 'p',
    createdAt: 0,
    rev: 1,
    account: { currency: 'USD', initialBalance: 10_000, balance: 10_000, unrealizedPnl: 0, equity: 10_000 },
    quotes: { 'oanda:EURUSD': { time: 3 * HOUR + 5 * 60_000, bid: 1.101, ask: 1.1012 } },
    orders: [
      {
        id: 'o2',
        symbol: 'oanda:EURUSD',
        side: 'sell',
        type: 'limit',
        units: 5_000,
        price: 1.105,
        stopLoss: null,
        takeProfit: null,
        status: 'pending',
        createdAt: HOUR,
        filledAt: null,
        fillPrice: null,
        tradeId: null,
        label: null
      }
    ],
    trades,
    symbols: ['oanda:EURUSD']
  }
}

function found(s: SimSnapshot, id: string): Inspected {
  const item = findInspected(s, id)
  if (!item) throw new Error(`${id} not in the snapshot`)
  return item
}

const row = (stats: ReturnType<typeof positionStats>, label: string): string | undefined => stats.rows.find((r) => r.label === label)?.value

describe('position stats', () => {
  test('an open long: marked on the bid, its R multiple, stop and target from the entry', () => {
    const s = snapshot([trade()])
    const stats = positionStats(found(s, 't1'), s, EURUSD)
    expect(stats.title).toBe('Long 10K EURUSD')
    expect(stats.headline).toEqual({ text: '+10.00 USD', tone: 'up' })
    expect(row(stats, 'Mark')).toBe('1.10100 (bid)')
    expect(row(stats, 'Move')).toBe('+10.0p')
    // 10 pips made over a 20-pip stop.
    expect(row(stats, 'Now')).toBe('0.50R')
    expect(row(stats, 'Stop loss')).toBe('1.09800 · −20.0p · −20.00 USD · −0.20%')
    expect(row(stats, 'R:R')).toBe('2.00')
    expect(row(stats, 'Size')).toBe('10000 units · 0.10 lots')
    expect(row(stats, 'Opened')).toContain('3h 05m')
  })

  test('a pending order: how far the market has to go, and no headline', () => {
    const s = snapshot([])
    const stats = positionStats(found(s, 'o2'), s, EURUSD)
    expect(stats.kind).toBe('order')
    expect(stats.title).toBe('Sell limit 5K EURUSD')
    expect(stats.headline).toBeNull()
    expect(row(stats, 'Market')).toBe('1.10100 · 40.0p away')
    expect(row(stats, 'Stop loss')).toBe('none')
  })

  test('a closed trade: how it ended and how long it was held', () => {
    const s = snapshot([trade({ closedAt: 2 * HOUR, closePrice: 1.098, closeReason: 'stop_loss', realizedPnl: -20 })])
    const stats = positionStats(found(s, 't1'), s, EURUSD)
    expect(stats.kind).toBe('closed')
    expect(stats.headline).toEqual({ text: '−20.00 USD realised', tone: 'down' })
    expect(row(stats, 'Exit')).toBe('1.09800 · Stop loss')
    expect(row(stats, 'Held')).toBe('2h 00m')
  })

  test('nothing by that id, or an order no longer pending, is not found', () => {
    const s = snapshot([])
    expect(findInspected(s, 'nope')).toBeNull()
    s.orders[0].status = 'cancelled'
    expect(findInspected(s, 'o2')).toBeNull()
  })
})
