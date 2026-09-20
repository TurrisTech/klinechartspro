import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { InstrumentConfig } from './symbols'

// ONE request per instrument per page. Two modules read `GET /instrument` -- the pane's
// SymbolInfo (client/symbols.ts) and the trading panel (client/trading/instrument.ts) -- and
// before this cache existed each paid for its own, so a wall cost two identical Postgres
// reads per instrument on every boot and again on every workspace switch.
//
// `fetch` is stubbed rather than the module mocked, the way client/preferences.test.ts and
// client/books/tiles.test.ts do it. `window` does not exist under bun and config.ts reads it
// at MODULE LOAD, so it is installed before the dynamic imports below -- a static import
// would be hoisted above the stub and crash on load.

const hadWindow = 'window' in globalThis
;(globalThis as Record<string, unknown>).window = {
  location: { href: 'http://localhost/', origin: 'http://localhost' }
}
afterAll(() => {
  if (!hadWindow) delete (globalThis as Record<string, unknown>).window
})

const { cachedInstrumentConfig, instrumentConfig, resetInstrumentConfigCache } = await import('./instrumentconfig')

const pristineFetch = globalThis.fetch
let calls: string[] = []
let answer: (url: string) => Response = () => new Response('{}', { status: 200 })

function config(symbol: string): InstrumentConfig {
  return {
    vendor: 'oanda',
    symbol,
    displayName: symbol,
    instrumentType: 'CURRENCY',
    assetClass: 'forex',
    displayPrecision: 5,
    forexPipLocation: -4,
    tradeUnitsPrecision: 0,
    minimumTradeSize: 1,
    maximumOrderUnits: null,
    maximumPositionSize: null,
    minimumTrailingStopDistance: null,
    maximumTrailingStopDistance: null,
    marginRate: 0.02,
    marketHours: { timezone: 'America/New_York', sessions: [] }
  }
}

beforeEach(() => {
  resetInstrumentConfigCache()
  calls = []
  answer = (url) => new Response(JSON.stringify(config(new URL(url).searchParams.get('symbol') ?? '')), { status: 200 })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url)
    return answer(url)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = pristineFetch
})

describe('instrumentConfig', () => {
  test('a second caller is served from the cache, not the network', async () => {
    const first = await instrumentConfig('oanda:EURUSD')
    const second = await instrumentConfig('oanda:EURUSD')
    expect(first?.symbol).toBe('oanda:EURUSD')
    expect(second).toBe(first)
    expect(calls.length).toBe(1)
  })

  test('concurrent callers share one request', async () => {
    const [a, b, c] = await Promise.all([
      instrumentConfig('oanda:GBPUSD'),
      instrumentConfig('oanda:GBPUSD'),
      instrumentConfig('oanda:GBPUSD')
    ])
    expect(calls.length).toBe(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  test('distinct instruments are fetched separately', async () => {
    await Promise.all([instrumentConfig('oanda:EURUSD'), instrumentConfig('coinbase:BTCUSD')])
    expect(calls.length).toBe(2)
  })

  test('a failure resolves null, is not retried, and never rejects', async () => {
    answer = () => new Response('{"code":"not_found","detail":"no such instrument"}', { status: 404 })
    expect(await instrumentConfig('oanda:NOPE')).toBeNull()
    expect(await instrumentConfig('oanda:NOPE')).toBeNull()
    expect(calls.length).toBe(1)
  })

  test('cachedInstrumentConfig tells "never asked" apart from "asked and failed"', async () => {
    expect(cachedInstrumentConfig('oanda:EURUSD')).toBeUndefined()
    await instrumentConfig('oanda:EURUSD')
    expect(cachedInstrumentConfig('oanda:EURUSD')?.symbol).toBe('oanda:EURUSD')
    answer = () => new Response('{"code":"internal","detail":"boom"}', { status: 500 })
    await instrumentConfig('oanda:BROKEN')
    expect(cachedInstrumentConfig('oanda:BROKEN')).toBeNull()
  })
})

describe('the trading panel reuses the pane fetch', () => {
  test('instrumentInfo issues no request once the config is cached', async () => {
    const { instrumentInfo } = await import('./trading/instrument')
    await instrumentConfig('oanda:EURUSD')
    expect(calls.length).toBe(1)
    const info = instrumentInfo('oanda:EURUSD')
    expect(calls.length).toBe(1)
    // Derived from the shared config, not a placeholder: EURUSD's pip is 1e-4.
    expect(info.pipSize).toBeCloseTo(0.0001, 10)
    expect(info.marginRate).toBe(0.02)
  })
})
