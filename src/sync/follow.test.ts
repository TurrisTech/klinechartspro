import { describe, expect, test } from 'bun:test'
import { samePeriod, sameSymbol } from './follow'

// The gate the wall-wide symbol/timeframe switches fan out behind. It is a value test, not an
// identity test, and that is the whole point: every pane of a restored wall holds its own
// SymbolInfo object, so identity alone would rewrite all of them on mount -- tearing down and
// refetching data that already showed exactly what was asked for.

const EURUSD = { ticker: 'EURUSD', exchange: 'oanda', name: 'EUR/USD' }
const H1 = { multiplier: 1, timespan: 'hour', text: '1h' }

describe('sameSymbol', () => {
  test('equal-but-distinct objects are the same symbol', () => {
    expect(sameSymbol(EURUSD, { ...EURUSD })).toBe(true)
    // Everything but ticker and vendor is presentation: a pane whose logo or precision was
    // resolved differently is still on the same instrument.
    expect(sameSymbol(EURUSD, { ticker: 'EURUSD', exchange: 'oanda', pricePrecision: 5 })).toBe(true)
  })

  test('the vendor is half the identity', () => {
    expect(sameSymbol({ ticker: 'BTCUSD', exchange: 'coinbase' }, { ticker: 'BTCUSD', exchange: 'oanda' }))
      .toBe(false)
    // An app that states no vendor at all still compares consistently with itself.
    expect(sameSymbol({ ticker: 'BTCUSD' }, { ticker: 'BTCUSD' })).toBe(true)
    expect(sameSymbol({ ticker: 'BTCUSD' }, { ticker: 'BTCUSD', exchange: 'coinbase' })).toBe(false)
  })

  test('different tickers, and a pane with no symbol yet, never match', () => {
    expect(sameSymbol(EURUSD, { ticker: 'GBPUSD', exchange: 'oanda' })).toBe(false)
    expect(sameSymbol(EURUSD, undefined)).toBe(false)
    expect(sameSymbol(undefined, undefined)).toBe(true)
  })
})

describe('samePeriod', () => {
  test('the text is the identity, as it is everywhere else', () => {
    expect(samePeriod(H1, { ...H1 })).toBe(true)
    expect(samePeriod(H1, { multiplier: 4, timespan: 'hour', text: '4h' })).toBe(false)
    expect(samePeriod(H1, undefined)).toBe(false)
  })
})
