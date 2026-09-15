import { describe, expect, test } from 'bun:test'
import type { SimAccount, SimOrder, SimTrade } from './api'
import type { InstrumentInfo } from './instrument'
import {
  defaultProtection,
  layoutLabels,
  levelForBalancePercent,
  orderFigures,
  orderPriceValid,
  pairCurrencies,
  positionSummary,
  pricingContext,
  protectionValid,
  quoteToAccountRate,
  restingPriceValid,
  targetForReward,
  tradeFigures,
  unitsForRisk
} from './metrics'

const ACCOUNT: SimAccount = { currency: 'USD', initialBalance: 10_000, balance: 10_000, unrealizedPnl: 0, equity: 10_000 }
const EURUSD: InstrumentInfo = { precision: 5, pipSize: 0.0001, assetClass: 'forex', marginRate: 0.0333, unitsPrecision: 0 }
const USDJPY: InstrumentInfo = { precision: 3, pipSize: 0.01, assetClass: 'forex', marginRate: 0.04, unitsPrecision: 0 }

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

function order(over: Partial<SimOrder> = {}): SimOrder {
  return {
    id: 'o1',
    symbol: 'oanda:EURUSD',
    side: 'buy',
    type: 'limit',
    units: 10_000,
    price: 1.095,
    stopLoss: null,
    takeProfit: null,
    status: 'pending',
    createdAt: 0,
    filledAt: null,
    fillPrice: null,
    tradeId: null,
    label: null,
    ...over
  }
}

describe('currencies', () => {
  test('pair tickers in both spellings; tickers that name none are null', () => {
    expect(pairCurrencies('oanda:EURUSD')).toEqual({ base: 'EUR', quote: 'USD' })
    expect(pairCurrencies('oanda:EUR_USD')).toEqual({ base: 'EUR', quote: 'USD' })
    expect(pairCurrencies('oanda:SPX500_USD')).toEqual({ base: 'SPX500', quote: 'USD' })
    expect(pairCurrencies('schwab:SPY')).toBeNull()
  })

  test('an amount converts to the account exactly only when the account is the quote or the base', () => {
    const quote = { time: 0, bid: 149.99, ask: 150.01 }
    expect(quoteToAccountRate(pricingContext('oanda:EURUSD', EURUSD, ACCOUNT, quote))).toBe(1)
    expect(quoteToAccountRate(pricingContext('oanda:USDJPY', USDJPY, ACCOUNT, quote))).toBeCloseTo(1 / 150, 12)
    expect(quoteToAccountRate(pricingContext('oanda:EURGBP', EURUSD, ACCOUNT, quote))).toBeNull()
    // No currency in the ticker: booked, as the engine books it, in the account currency.
    expect(quoteToAccountRate(pricingContext('schwab:SPY', { ...EURUSD, pipSize: null, assetClass: 'equity' }, ACCOUNT, quote))).toBe(1)
  })
})

describe('tradeFigures', () => {
  const quote = { time: 0, bid: 1.1012, ask: 1.1014 }
  const ctx = pricingContext('oanda:EURUSD', EURUSD, ACCOUNT, quote)

  test('a long marks on the bid: pips, amount, share of balance', () => {
    const f = tradeFigures(trade(), ctx)
    expect(f.mark).toBe(1.1012)
    expect(f.pnl?.pips).toBeCloseTo(12, 9)
    expect(f.pnl?.amount).toBeCloseTo(12, 9)
    expect(f.pnl?.amountAccount).toBeCloseTo(12, 9)
    expect(f.pnl?.ofBalance).toBeCloseTo(0.12, 9)
  })

  test('a short marks on the ask', () => {
    const f = tradeFigures(trade({ side: 'sell', entryPrice: 1.102 }), ctx)
    expect(f.mark).toBe(1.1014)
    expect(f.pnl?.pips).toBeCloseTo(6, 9)
  })

  test('stop and target are what each would realise from the entry, and give reward to risk', () => {
    const f = tradeFigures(trade({ stopLoss: 1.098, takeProfit: 1.104 }), ctx)
    expect(f.stop?.pips).toBeCloseTo(-20, 9)
    expect(f.stop?.amount).toBeCloseTo(-20, 9)
    expect(f.target?.pips).toBeCloseTo(40, 9)
    expect(f.rewardToRisk).toBeCloseTo(2, 9)
  })

  test('a stop past the entry locks profit and risks nothing, so there is no ratio', () => {
    const f = tradeFigures(trade({ stopLoss: 1.1005, takeProfit: 1.104 }), ctx)
    expect(f.stop?.pips).toBeCloseTo(5, 9)
    expect(f.rewardToRisk).toBeNull()
  })

  test('size: lots, pip value and margin in the account currency', () => {
    const f = tradeFigures(trade(), ctx)
    expect(f.lots).toBeCloseTo(0.1, 12)
    expect(f.pipValue).toBeCloseTo(1, 12)
    expect(f.pipValueAccount).toBeCloseTo(1, 12)
    expect(f.notionalAccount).toBeCloseTo(11_013, 6)
    expect(f.margin).toBeCloseTo(11_013 * 0.0333, 6)
  })

  test('USDJPY: yen P&L, converted at the mid; notional is the units themselves', () => {
    const jpy = pricingContext('oanda:USDJPY', USDJPY, ACCOUNT, { time: 0, bid: 150.1, ask: 150.12 })
    const f = tradeFigures(trade({ symbol: 'oanda:USDJPY', entryPrice: 150 }), jpy)
    expect(f.pnl?.pips).toBeCloseTo(10, 9)
    expect(f.pnl?.amount).toBeCloseTo(1_000, 6) // yen
    expect(f.pnl?.amountAccount).toBeCloseTo(1_000 / 150.11, 6)
    expect(f.pipValue).toBeCloseTo(100, 9) // yen per pip
    expect(f.notionalAccount).toBe(10_000)
    expect(f.margin).toBeCloseTo(400, 9)
  })

  test('a cross converts through a pair the account holds a quote for, and only then', () => {
    const quotes = { 'oanda:GBPUSD': { time: 0, bid: 1.2999, ask: 1.3001 } }
    const cross = pricingContext('oanda:EURGBP', EURUSD, ACCOUNT, { time: 0, bid: 0.86, ask: 0.8602 }, quotes)
    const f = tradeFigures(trade({ symbol: 'oanda:EURGBP', entryPrice: 0.85 }), cross)
    expect(f.pnl?.amount).toBeCloseTo(100, 6) // GBP
    expect(f.pnl?.amountAccount).toBeCloseTo(130, 6) // at GBPUSD 1.3000
    const yen = pricingContext('oanda:EURJPY', USDJPY, ACCOUNT, undefined, { 'oanda:USDJPY': { time: 0, bid: 150, ask: 150 } })
    expect(quoteToAccountRate(yen)).toBeCloseTo(1 / 150, 12)
  })

  test('a cross has no account figure rather than an invented one', () => {
    const cross = pricingContext('oanda:EURGBP', EURUSD, ACCOUNT, { time: 0, bid: 0.86, ask: 0.8602 })
    const f = tradeFigures(trade({ symbol: 'oanda:EURGBP', entryPrice: 0.85 }), cross)
    expect(f.pnl?.amount).toBeCloseTo(100, 6)
    expect(f.pnl?.amountAccount).toBeNull()
    expect(f.pnl?.ofBalance).toBeNull()
    expect(f.margin).toBeNull()
  })

  test('no quote yet: no mark and no P&L, but the levels still read', () => {
    const f = tradeFigures(trade({ stopLoss: 1.098 }), pricingContext('oanda:EURUSD', EURUSD, ACCOUNT, undefined))
    expect(f.mark).toBeNull()
    expect(f.pnl).toBeNull()
    expect(f.stop?.pips).toBeCloseTo(-20, 9)
  })
})

describe('orderFigures and the summary', () => {
  const quote = { time: 0, bid: 1.1, ask: 1.1002 }
  const ctx = pricingContext('oanda:EURUSD', EURUSD, ACCOUNT, quote)

  test('a buy limit is measured from the ask it would fill on; its levels from its own price', () => {
    const f = orderFigures(order({ stopLoss: 1.093, takeProfit: 1.1 }), ctx)
    expect(f.distance?.pips).toBeCloseTo(52, 9)
    expect(f.stop?.pips).toBeCloseTo(-20, 9)
    expect(f.target?.pips).toBeCloseTo(50, 9)
    expect(f.rewardToRisk).toBeCloseTo(2.5, 9)
  })

  test('net units, a one-sided average entry, and risk that is unbounded once any stop is missing', () => {
    const a = trade({ entryPrice: 1.09, stopLoss: 1.08 })
    const b = trade({ id: 't2', units: 30_000, entryPrice: 1.094, stopLoss: 1.09 })
    const bounded = positionSummary([a, b], [], ctx)
    expect(bounded.netUnits).toBe(40_000)
    expect(bounded.averageEntry).toBeCloseTo(1.093, 12)
    expect(bounded.riskAtStops).toBeCloseTo(-100 - 120, 6)
    const hedged = positionSummary([a, trade({ id: 't3', side: 'sell', units: 5_000 })], [], ctx)
    expect(hedged.netUnits).toBe(5_000)
    expect(hedged.averageEntry).toBeNull()
    expect(hedged.riskAtStops).toBeNull()
  })
})

describe('what the engine refuses', () => {
  const quote = { time: 0, bid: 1.1, ask: 1.1002 }

  test('protection: a long stop below and target above the reference, a short the reverse', () => {
    expect(protectionValid('buy', 'stop', 1.09, 1.1)).toBe(true)
    expect(protectionValid('buy', 'stop', 1.1, 1.1)).toBe(false)
    expect(protectionValid('buy', 'target', 1.11, 1.1)).toBe(true)
    expect(protectionValid('sell', 'stop', 1.11, 1.1)).toBe(true)
    expect(protectionValid('sell', 'target', 1.11, 1.1)).toBe(false)
  })

  test('resting prices: limits on the far side of the market, stops beyond it', () => {
    expect(restingPriceValid('buy', 'limit', 1.1001, quote)).toBe(true)
    expect(restingPriceValid('buy', 'limit', 1.1002, quote)).toBe(false)
    expect(restingPriceValid('sell', 'limit', 1.1, quote)).toBe(false)
    expect(restingPriceValid('buy', 'stop', 1.1003, quote)).toBe(true)
    expect(restingPriceValid('sell', 'stop', 1.0999, quote)).toBe(true)
    expect(restingPriceValid('sell', 'stop', 1.1, quote)).toBe(false)
  })

  test("moving an order may not carry it past its own stop or target", () => {
    const o = order({ stopLoss: 1.09 })
    expect(orderPriceValid(o, 1.095, quote)).toBe(true)
    expect(orderPriceValid(o, 1.089, quote)).toBe(false)
  })

  test('a starting stop sits beyond both the entry and the market, so it is valid when placed', () => {
    // A long under water (mark 1.095 < entry 1.1): the stop goes below the mark, not the entry.
    expect(defaultProtection('buy', 'stop', 1.1, 1.095, 0.002, 5)).toBeCloseTo(1.093, 12)
    expect(defaultProtection('buy', 'target', 1.1, 1.095, 0.002, 5)).toBeCloseTo(1.102, 12)
    expect(defaultProtection('sell', 'stop', 1.1, 1.105, 0.002, 5)).toBeCloseTo(1.107, 12)
  })

  test('a starting level that would land off the pane is pulled back on, when there is room', () => {
    const visible = { low: 1.0985, high: 1.11 } // pad = 0.00046, so the floor is 1.09896
    // 20 pips below 1.1000 would be 1.0980, off the bottom: pulled up to the floor.
    expect(defaultProtection('buy', 'stop', 1.1, 1.1, 0.002, 5, visible)).toBeCloseTo(1.09896, 12)
    // No room -- 2.4 pips to the floor is under a third of 20 -- so it stays off screen.
    expect(defaultProtection('buy', 'stop', 1.0992, 1.0992, 0.002, 5, visible)).toBeCloseTo(1.0972, 12)
    // Already on screen: untouched.
    expect(defaultProtection('buy', 'target', 1.1, 1.1, 0.002, 5, visible)).toBeCloseTo(1.102, 12)
  })
})

describe('layoutLabels', () => {
  test('labels far apart stay on their lines', () => {
    expect(layoutLabels([50, 150, 250], 300, 20)).toEqual([50, 150, 250])
  })

  test('labels that would overlap are pushed apart, in input order', () => {
    expect(layoutLabels([105, 100, 110], 300, 20)).toEqual([120, 100, 140])
  })

  test('a run against the bottom edge is pulled back inside it', () => {
    expect(layoutLabels([295, 298], 300, 20)).toEqual([270, 290])
  })

  test('lines off the pane pin their labels to the edge they left by', () => {
    expect(layoutLabels([-40, 400], 300, 20)).toEqual([10, 290])
  })
})

describe('sizing by risk', () => {
  const quote = { time: 0, bid: 1.1, ask: 1.1002 }
  const ctx = pricingContext('oanda:EURUSD', EURUSD, ACCOUNT, quote)

  test('units for a 1% risk over a 20-pip stop: 100 USD / 0.0020 = 50,000, floored', () => {
    expect(unitsForRisk(1, 1.1, 1.098, ctx)).toBe(50_000)
    // 0.37% over 23 pips = 37 / 0.0023 = 16,086.9 -> never rounds up past the budget.
    expect(unitsForRisk(0.37, 1.1, 1.0977, ctx)).toBe(16_086)
    expect(unitsForRisk(1, 1.1, 1.1, ctx)).toBeNull()
  })

  test('a yen pair sizes through the mid; a cross with no conversion cannot be sized', () => {
    const jpy = pricingContext('oanda:USDJPY', USDJPY, ACCOUNT, { time: 0, bid: 150, ask: 150 })
    // 100 USD over 0.50 yen per unit at 150 yen per dollar: 100 / (0.5 / 150) = 30,000.
    expect(unitsForRisk(1, 150, 149.5, jpy)).toBe(30_000)
    expect(unitsForRisk(1, 0.85, 0.848, pricingContext('oanda:EURGBP', EURUSD, ACCOUNT, quote))).toBeNull()
  })

  test('the stop that loses a share of the balance, rounded toward the entry', () => {
    // 10,000 units losing 1% (100 USD) moves 0.0100 from the entry.
    expect(levelForBalancePercent('buy', 'stop', 10_000, 1.1, 1, ctx)).toBeCloseTo(1.09, 12)
    expect(levelForBalancePercent('sell', 'stop', 10_000, 1.1, 1, ctx)).toBeCloseTo(1.11, 12)
    expect(levelForBalancePercent('buy', 'target', 10_000, 1.1, 2, ctx)).toBeCloseTo(1.12, 12)
    // 30,000 units losing 1%: 0.003333... -> 1.096667 rounds UP (toward the entry) to 1.09667.
    expect(levelForBalancePercent('buy', 'stop', 30_000, 1.1, 1, ctx)).toBeCloseTo(1.09667, 12)
    expect(levelForBalancePercent('buy', 'stop', 10, 1.1, 1, ctx)).toBeNull() // would pass zero
  })

  test('targets as a multiple of the risk', () => {
    expect(targetForReward('buy', 1.1, 1.098, 2, 5)).toBeCloseTo(1.104, 12)
    expect(targetForReward('sell', 1.1, 1.103, 1.5, 5)).toBeCloseTo(1.0955, 12)
    expect(targetForReward('buy', 1.1, 1.101, 2, 5)).toBeNull() // stop past entry: no risk
  })
})
