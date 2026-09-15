import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import type { SimOrder, SimSnapshot, SimTrade } from './api'
import type { InstrumentInfo } from './instrument'

// format.ts -> symbols.ts -> config.ts reads `window` at import: stub it, then import.
installWindow()
const { amendmentRefusal, describeAmendment } = await import('./amend')

const KEY = 'oanda:EURUSD'
const INFO: InstrumentInfo = { precision: 5, pipSize: 0.0001, assetClass: 'forex', marginRate: 0.0333, unitsPrecision: 0 }

const trade: SimTrade = {
  id: 't1', symbol: KEY, side: 'buy', units: 10_000, entryPrice: 1.1, openedAt: 0, orderId: 'o0',
  stopLoss: 1.098, takeProfit: null, closedAt: null, closePrice: null, closeReason: null, realizedPnl: null, label: null
}
const order: SimOrder = {
  id: 'o1', symbol: KEY, side: 'buy', type: 'limit', units: 10_000, price: 1.095, stopLoss: 1.093, takeProfit: null,
  status: 'pending', createdAt: 0, filledAt: null, fillPrice: null, tradeId: null, label: null
}
const snapshot: SimSnapshot = {
  id: 's', mode: 'paper', name: 'Paper', createdAt: 0, rev: 1,
  account: { currency: 'USD', initialBalance: 10_000, balance: 10_000, unrealizedPnl: 0, equity: 10_000 },
  quotes: { [KEY]: { time: 0, bid: 1.1, ask: 1.1002 } },
  orders: [order], trades: [trade], symbols: [KEY]
}

describe('describeAmendment', () => {
  test('a move names the position, both levels, and what the new level would realise', () => {
    const words = describeAmendment({ owner: 'trade', id: 't1', role: 'stop', price: 1.097, from: 1.098 }, snapshot, INFO)
    expect(words?.title).toBe("Move the EURUSD long 10K's stop loss 1.09800 → 1.09700?")
    expect(words?.detail).toBe('If hit: −30.0p · −30.00 USD (−0.30% of balance)')
  })

  test('an add, a removal, and a pending price', () => {
    expect(describeAmendment({ owner: 'trade', id: 't1', role: 'target', price: 1.104, from: null }, snapshot, INFO)?.title).toBe(
      'Add a take profit at 1.10400 to the EURUSD long 10K?'
    )
    const removal = describeAmendment({ owner: 'trade', id: 't1', role: 'stop', price: null, from: 1.098 }, snapshot, INFO)
    expect(removal?.detail).toBe('The position will have no stop loss.')
    expect(describeAmendment({ owner: 'order', id: 'o1', role: 'order', price: 1.096, from: 1.095 }, snapshot, INFO)?.detail).toBe(
      '42.0p from the market'
    )
  })
})

describe('amendmentRefusal', () => {
  test("a long's stop must stay under the bid; an order may not pass its own stop or the market", () => {
    expect(amendmentRefusal({ owner: 'trade', id: 't1', role: 'stop', price: 1.1001 }, snapshot, INFO)).toBe(
      "A long's stop must be below the bid (1.10000)"
    )
    expect(amendmentRefusal({ owner: 'trade', id: 't1', role: 'stop', price: 1.099 }, snapshot, INFO)).toBeNull()
    expect(amendmentRefusal({ owner: 'order', id: 'o1', role: 'order', price: 1.092 }, snapshot, INFO)).toBe(
      'The order would pass its own stop loss'
    )
    expect(amendmentRefusal({ owner: 'order', id: 'o1', role: 'order', price: 1.1005 }, snapshot, INFO)).toBe(
      'A buy limit must be below the ask (1.10020)'
    )
    expect(amendmentRefusal({ owner: 'order', id: 'o1', role: 'order', price: null }, snapshot, INFO)).toBe('An order must keep a price')
  })
})
