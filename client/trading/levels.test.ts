import { describe, expect, test } from 'bun:test'
import type { SimAccount, SimQuote, SimTrade } from './api'
import type { InstrumentInfo } from './instrument'
import type { LevelBasis } from './levels'
import { installWindow } from '../plugins/testing'

// levels.ts -> format.ts -> symbols.ts -> config.ts reads `window` at import, so the DOM stub has
// to exist before those load (as in trading.test.ts).
installWindow()
const {
  amountText,
  defaultRestingPrice,
  fractionUnits,
  levelModeRefusal,
  levelReadout,
  levelRefusal,
  levelText,
  parseLevel,
  restingDistance,
  restingRefusal,
  reverseOrder,
  stepLevelText,
  usableMode
} = await import('./levels')
const { pricingContext } = await import('./metrics')

const ACCOUNT: SimAccount = { currency: 'USD', initialBalance: 10_000, balance: 10_000, unrealizedPnl: 0, equity: 10_000 }
const EURUSD: InstrumentInfo = { precision: 5, pipSize: 0.0001, assetClass: 'forex', marginRate: 0.0333, unitsPrecision: 0 }
const SPX: InstrumentInfo = { precision: 1, pipSize: null, assetClass: 'cfd', marginRate: 0.05, unitsPrecision: 1 }
const QUOTE: SimQuote = { time: 0, bid: 1.1, ask: 1.1002 }

const eurusd = (over: Partial<LevelBasis> = {}): LevelBasis => ({
  side: 'buy',
  entry: 1.1,
  units: 10_000,
  ctx: pricingContext('oanda:EURUSD', EURUSD, ACCOUNT, QUOTE),
  ...over
})

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

describe('stating a level', () => {
  test('pips are the distance from the entry, whichever side the level is on', () => {
    expect(levelText(1.098, 'pips', eurusd())).toBe('20.0')
    expect(levelText(1.104, 'pips', eurusd())).toBe('40.0')
  })

  test('percent is the share of the balance realised there, at the size', () => {
    // 10K units, 20 pips: 20 USD of a 10,000 balance.
    expect(levelText(1.098, 'percent', eurusd())).toBe('0.20')
  })

  test('falls back to the price where the unit cannot be worked out', () => {
    expect(levelText(1.098, 'pips', eurusd({ entry: null }))).toBe('1.09800')
    expect(levelText(1.098, 'percent', eurusd({ units: null }))).toBe('1.09800')
  })

  test('reads back to the same price, on the side the role and side put it', () => {
    expect(parseLevel('20', 'pips', 'stop', eurusd())).toBe(1.098)
    expect(parseLevel('20', 'pips', 'target', eurusd())).toBe(1.102)
    expect(parseLevel('20', 'pips', 'stop', eurusd({ side: 'sell' }))).toBe(1.102)
    expect(parseLevel('0.20', 'percent', 'stop', eurusd())).toBeCloseTo(1.098, 5)
    expect(parseLevel('1.09750', 'price', 'stop', eurusd())).toBe(1.0975)
  })

  test('an empty field is no level; nonsense is a sentence', () => {
    expect(parseLevel('  ', 'pips', 'stop', eurusd())).toBeNull()
    expect(() => parseLevel('abc', 'pips', 'stop', eurusd())).toThrow('Invalid stop loss')
    expect(() => parseLevel('-3', 'price', 'target', eurusd())).toThrow('Invalid take profit')
    expect(() => parseLevel('20', 'pips', 'stop', eurusd({ entry: null }))).toThrow('No price to measure')
    expect(() => parseLevel('1', 'percent', 'stop', eurusd({ units: null }))).toThrow('needs a size')
  })

  test('the modes an instrument allows', () => {
    const spx = pricingContext('oanda:SPX500_USD', SPX, ACCOUNT, { time: 0, bid: 5000, ask: 5000.5 })
    expect(levelModeRefusal('pips', spx)).toBe('This instrument is not priced in pips')
    expect(usableMode('pips', spx)).toBe('price')
    expect(levelModeRefusal('percent', eurusd().ctx, true)).toContain('Sizing by risk')
    expect(usableMode('percent', eurusd().ctx, true)).toBe('pips')
    // EURGBP on a USD account with no GBPUSD quote held: no rate, so no percent.
    const cross = pricingContext('oanda:EURGBP', EURUSD, ACCOUNT, { time: 0, bid: 0.85, ask: 0.8502 })
    expect(levelModeRefusal('percent', cross)).toBe('No USD rate for GBP')
  })
})

describe('stepping a level', () => {
  test('up makes the number in the field bigger, in its own unit', () => {
    expect(stepLevelText('20.0', 'pips', 'stop', 1, false, eurusd())).toBe('21.0')
    expect(stepLevelText('20.0', 'pips', 'stop', -1, true, eurusd())).toBe('10.0')
    expect(stepLevelText('1.09800', 'price', 'stop', 1, false, eurusd())).toBe('1.09810')
    expect(stepLevelText('0.20', 'percent', 'stop', 1, false, eurusd())).toBe('0.30')
  })

  test('never steps a distance to nothing', () => {
    expect(stepLevelText('0.5', 'pips', 'stop', -1, false, eurusd())).toBe('0.1')
  })

  test('an empty field starts ten pips out, on the right side', () => {
    expect(stepLevelText('', 'price', 'stop', 1, false, eurusd())).toBe('1.09900')
    expect(stepLevelText('', 'price', 'target', 1, false, eurusd({ side: 'sell' }))).toBe('1.09900')
    expect(stepLevelText('', 'pips', 'stop', 1, false, eurusd())).toBe('10.0')
  })
})

describe('the readout', () => {
  test('gives every figure the field does not state', () => {
    const text = (mode: 'pips' | 'price' | 'percent') => levelReadout(1.098, mode, eurusd()).map((p) => p.text)
    expect(text('pips')).toEqual(['1.09800', '−20.00 USD', '−0.20%'])
    expect(text('price')).toEqual(['−20.0p', '−20.00 USD', '−0.20%'])
    expect(text('percent')).toEqual(['1.09800', '−20.0p', '−20.00 USD'])
  })

  test('a target reads as a gain, a stop as a loss', () => {
    expect(levelReadout(1.102, 'pips', eurusd())[1].tone).toBe('up')
    expect(levelReadout(1.098, 'pips', eurusd())[1].tone).toBe('down')
  })

  test('with no size yet, only the price and the distance', () => {
    expect(levelReadout(1.098, 'pips', eurusd({ units: null })).map((p) => p.text)).toEqual(['1.09800'])
    expect(levelReadout(1.098, 'price', eurusd({ units: null })).map((p) => p.text)).toEqual(['−20.0p'])
  })

  test('an amount in another currency carries the account figure only where it converts', () => {
    const jpy: InstrumentInfo = { precision: 3, pipSize: 0.01, assetClass: 'forex', marginRate: 0.04, unitsPrecision: 0 }
    const ctx = pricingContext('oanda:USDJPY', jpy, ACCOUNT, { time: 0, bid: 150, ask: 150.02 })
    expect(amountText(-3000, -20, ctx)).toBe('−3,000 JPY ≈ −20.00 USD')
    expect(amountText(-20, -20, eurusd().ctx)).toBe('−20.00 USD')
  })

  test('a level on the wrong side says which side it belongs on', () => {
    expect(levelRefusal('buy', 'stop', 1.101, 1.1, 'the ask')).toBe('The stop loss must be below the ask')
    expect(levelRefusal('sell', 'target', 1.099, 1.1, 'the order price')).toBeNull()
  })
})

describe('resting orders', () => {
  test('a starting price is clear of the market on the side the type rests on', () => {
    expect(defaultRestingPrice('buy', 'limit', QUOTE, EURUSD)).toBe(1.0992) // 10p under the ask
    expect(defaultRestingPrice('buy', 'stop', QUOTE, EURUSD)).toBe(1.1012)
    expect(defaultRestingPrice('sell', 'limit', QUOTE, EURUSD)).toBe(1.101) // 10p over the bid
    expect(defaultRestingPrice('sell', 'stop', QUOTE, EURUSD)).toBe(1.099)
    expect(defaultRestingPrice('buy', 'market', QUOTE, EURUSD)).toBeNull()
    expect(defaultRestingPrice('buy', 'limit', undefined, EURUSD)).toBeNull()
  })

  test('the starting price never refuses', () => {
    for (const side of ['buy', 'sell'] as const) {
      for (const type of ['limit', 'stop'] as const) {
        const price = defaultRestingPrice(side, type, QUOTE, EURUSD) as number
        expect(restingRefusal(side, type, price, QUOTE, 5)).toBeNull()
      }
    }
  })

  test('a limit through the market is refused, in words', () => {
    expect(restingRefusal('buy', 'limit', 1.1005, QUOTE, 5)).toBe('A buy limit must be below the ask (1.10020)')
    expect(restingRefusal('sell', 'stop', 1.1001, QUOTE, 5)).toBe('A sell stop must be below the bid (1.10000)')
  })

  test('distance from where it would fill', () => {
    expect(restingDistance('buy', 1.0992, QUOTE, EURUSD)).toBe('10.0p below the ask')
    expect(restingDistance('sell', 1.101, QUOTE, EURUSD)).toBe('10.0p above the bid')
  })
})

describe('ending a trade', () => {
  test('fractions floor to whole units, and never to nothing', () => {
    const ctx = eurusd().ctx
    expect(fractionUnits(10_000, 0.25, ctx)).toBe(2500)
    expect(fractionUnits(3, 0.5, ctx)).toBe(1)
    expect(fractionUnits(1, 0.25, ctx)).toBeNull()
    expect(fractionUnits(1, 1, ctx)).toBe(1)
  })

  test('a reverse carries the stop and target across at their distances', () => {
    const r = reverseOrder(trade({ stopLoss: 1.098, takeProfit: 1.104 }), QUOTE, 5)
    // A sell fills at the bid, 1.10000: stop 20 pips above, target 40 below.
    expect(r).toEqual({ side: 'sell', units: 10_000, fill: 1.1, stopLoss: 1.102, takeProfit: 1.096 })
  })

  test('a reverse without levels sends none', () => {
    expect(reverseOrder(trade(), QUOTE, 5)).toEqual({ side: 'sell', units: 10_000, fill: 1.1, stopLoss: undefined, takeProfit: undefined })
    expect(reverseOrder(trade(), undefined, 5)).toBeNull()
  })
})
