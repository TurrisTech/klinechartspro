import { describe, expect, test } from 'bun:test'
import type { SymbolInfo } from '../src'
import { installWindow } from './plugins/testing'

// symbols.ts reads `window` at import, through config.ts, so it is loaded after one is installed:
// a static import would be hoisted above the install.
installWindow()

const { DEFAULT_VENDOR, instrumentKey, splitInstrumentKey, symbolKey, symbolVendor, tickerOf } = await import('./symbols')
const { normaliseSymbol } = await import('./alerts/store')
const { defaultLayout } = await import('./layout')
const { normalInstrument } = await import('./lab/model')
const { pairCurrencies } = await import('./trading/metrics')
const { instrumentTarget } = await import('./watch/types')

// The inputs a parse can go wrong on: a bare ticker, nothing at all, an empty vendor, an empty
// ticker -- and well-formed keys of each vendor, for the spellings that must come through intact.
const EDGES = ['EURUSD', '', ':EURUSD', 'oanda:', 'oanda:EURUSD', 'coinbase:BTCUSD', 'schwab:$SPX']
const KEYED = EDGES.filter((key) => key.includes(':'))

const info = (ticker: string, exchange?: string): SymbolInfo => ({ ticker, exchange }) as unknown as SymbolInfo

describe('the instrument key', () => {
  test('a bare ticker is the default vendor, and that vendor is OANDA', () => {
    expect(DEFAULT_VENDOR).toBe('oanda')
    expect(splitInstrumentKey('EURUSD')).toEqual({ vendor: 'oanda', ticker: 'EURUSD' })
  })

  test('a key is spelled as given, with no case changed', () => {
    expect(instrumentKey('oanda', 'EURUSD')).toBe('oanda:EURUSD')
    expect(instrumentKey('Coinbase', 'btcusd')).toBe('Coinbase:btcusd')
    expect(instrumentKey('', '')).toBe(':')
  })

  test('a key splits at its first colon, and an empty half stays empty', () => {
    expect(splitInstrumentKey('schwab:$SPX')).toEqual({ vendor: 'schwab', ticker: '$SPX' })
    expect(splitInstrumentKey(':EURUSD')).toEqual({ vendor: '', ticker: 'EURUSD' })
    expect(splitInstrumentKey('oanda:')).toEqual({ vendor: 'oanda', ticker: '' })
    expect(splitInstrumentKey('')).toEqual({ vendor: 'oanda', ticker: '' })
    expect(splitInstrumentKey('a:b:c')).toEqual({ vendor: 'a', ticker: 'b:c' })
  })

  test('splitting and joining a key that names its vendor gives it back unchanged', () => {
    for (const key of [...KEYED, 'a:b:c']) {
      const { vendor, ticker } = splitInstrumentKey(key)
      expect(instrumentKey(vendor, ticker)).toBe(key)
    }
  })

  test('tickerOf is the ticker half, or the whole of a bare one', () => {
    expect(EDGES.map(tickerOf)).toEqual(['EURUSD', '', 'EURUSD', '', 'EURUSD', 'BTCUSD', '$SPX'])
  })

  test("a symbol's vendor is its exchange, the default when it names none", () => {
    expect(symbolVendor(info('EURUSD'))).toBe('oanda')
    expect(symbolVendor(info('BTCUSD', 'coinbase'))).toBe('coinbase')
    expect(symbolKey(info('EURUSD'))).toBe('oanda:EURUSD')
    expect(symbolKey(info('BTCUSD', 'coinbase'))).toBe('coinbase:BTCUSD')
    // `??`, as before: an empty exchange is kept, not replaced with the default.
    expect(symbolKey(info('EURUSD', ''))).toBe(':EURUSD')
  })
})

// Each parse the helpers replaced, copied as it was written, against what replaced it at its site.
// Where the two differ it is on an input the site cannot receive, and the case says which.
describe('the parses the helpers replaced', () => {
  const pair = (key: string) => {
    const { vendor, ticker } = splitInstrumentKey(key)
    return [vendor, ticker]
  }

  test("includes(':') ? split(':', 2) : ['oanda', key] -- tiles, bars/tiled, replay, symbol search", () => {
    const old = (key: string) => (key.includes(':') ? key.split(':', 2) : ['oanda', key])
    for (const key of EDGES) expect(pair(key)).toEqual(old(key))
    // `split(':', 2)` dropped what followed a second colon. No ticker contains one, so no key
    // reaching these sites has two.
    expect(old('a:b:c')).toEqual(['a', 'b'])
    expect(pair('a:b:c')).toEqual(['a', 'b:c'])
  })

  test("includes(':') ? split(':', 1)[0] : 'oanda' -- bars/source", () => {
    const old = (key: string) => (key.includes(':') ? key.split(':', 1)[0] : 'oanda')
    for (const key of [...EDGES, 'a:b:c']) expect(splitInstrumentKey(key).vendor).toBe(old(key))
  })

  test('the three ticker spellings -- trading, alerts, replay, lab and watch labels', () => {
    const guarded = (key: string) => (key.includes(':') ? key.split(':', 2)[1] : key)
    const second = (key: string) => key.split(':')[1] ?? key
    const last = (key: string) => key.split(':').pop() ?? key
    for (const key of EDGES) {
      expect(tickerOf(key)).toBe(guarded(key))
      expect(tickerOf(key)).toBe(second(key))
      expect(tickerOf(key)).toBe(last(key))
    }
  })

  test("indexOf(':') and two slices -- alerts/data, lab/data, lab/page, the alert monitor's vendor and ticker", () => {
    const old = (key: string) => {
      const at = key.indexOf(':')
      return [key.slice(0, at), key.slice(at + 1)]
    }
    for (const key of [...KEYED, 'a:b:c']) expect(pair(key)).toEqual(old(key))
    // Unguarded, a bare ticker lost its last letter to the vendor. These sites are handed an
    // alert's or a Lab run's instrument, which always names its vendor (alerts/store.ts
    // `normaliseSymbol`, lab/model.ts `strategyProblems`).
    expect(old('EURUSD')).toEqual(['EURUS', 'EURUSD'])
    expect(pair('EURUSD')).toEqual(['oanda', 'EURUSD'])
  })

  test("split(':') and split(':', 2)[0] unguarded -- the Lab chart's pane, the runner's vendor", () => {
    const destructured = (key: string) => {
      const [vendor, ticker] = key.split(':')
      return [vendor, ticker]
    }
    const vendorOf = (key: string) => key.split(':', 2)[0]
    for (const key of KEYED) {
      expect(pair(key)).toEqual(destructured(key))
      expect(splitInstrumentKey(key).vendor).toBe(vendorOf(key))
    }
    // A bare one read as a vendor with no ticker. Both are handed the strategy's instrument, which
    // a run refuses unless it is `vendor:TICKER` (lab/model.ts `strategyProblems`).
    expect(destructured('EURUSD')[0]).toBe('EURUSD')
    expect(destructured('EURUSD')[1]).toBeUndefined()
    expect(vendorOf('EURUSD')).toBe('EURUSD')
  })

  test("split(':')[0] || 'oanda' -- a replay's watches", () => {
    const old = (key: string) => key.split(':')[0] || 'oanda'
    const now = (key: string) => splitInstrumentKey(key).vendor || DEFAULT_VENDOR
    for (const key of KEYED) expect(now(key)).toBe(old(key))
    // The replay's instrument is a pane's `symbolKey`, so it always has a colon.
    expect(old('EURUSD')).toBe('EURUSD')
    expect(now('EURUSD')).toBe('oanda')
  })

  test("split(':')[1]?.slice(3) || 'quote' -- a Lab run's quote currency", () => {
    const old = (key: string) => key.split(':')[1]?.slice(3) || 'quote'
    const now = (key: string) => tickerOf(key).slice(3) || 'quote'
    for (const key of KEYED) expect(now(key)).toBe(old(key))
    // A run's instrument names its vendor (lab/model.ts `strategyProblems`).
    expect(old('EURUSD')).toBe('quote')
    expect(now('EURUSD')).toBe('USD')
  })

  test("includes(':') ? key : 'oanda:' + key -- trading/instrument", () => {
    const old = (key: string) => (key.includes(':') ? key : `oanda:${key}`)
    const now = (key: string) => {
      const { vendor, ticker } = splitInstrumentKey(key)
      return instrumentKey(vendor, ticker)
    }
    for (const key of [...EDGES, 'a:b:c']) expect(now(key)).toBe(old(key))
  })

  test("indexOf(':') > 0 -- the alert editor's and the Lab's timeframes: only a key naming its vendor", () => {
    const old = (key: string) => {
      const at = key.indexOf(':')
      return at > 0 ? [key.slice(0, at), key.slice(at + 1)] : null
    }
    const now = (key: string) => {
      const { vendor, ticker } = splitInstrumentKey(key)
      return key.includes(':') && vendor ? [vendor, ticker] : null
    }
    for (const key of [...EDGES, 'a:b:c']) expect(now(key)).toEqual(old(key))
  })

  test("a replay watch's target: a bare one is the replay's vendor, not the default", () => {
    // replay/watches.ts `normalise`, before and after; it is not exported.
    const old = (target: string, fallbackVendor: string) => {
      const raw = target.trim()
      if (!raw) throw new Error('target is required')
      const [head, ...rest] = raw.split(':')
      const symbol = rest.length > 0 ? rest.join(':') : head
      const vendor = rest.length > 0 ? head : fallbackVendor
      if (!symbol) throw new Error(`not an instrument: '${target}'`)
      return `${vendor.toLowerCase()}:${symbol.toUpperCase()}`
    }
    const now = (target: string, fallbackVendor: string) => {
      const raw = target.trim()
      if (!raw) throw new Error('target is required')
      const { vendor, ticker: symbol } = raw.includes(':') ? splitInstrumentKey(raw) : { vendor: fallbackVendor, ticker: raw }
      if (!symbol) throw new Error(`not an instrument: '${target}'`)
      return instrumentKey(vendor.toLowerCase(), symbol.toUpperCase())
    }
    const outcome = (f: () => string) => {
      try {
        return f()
      } catch (err) {
        return (err as Error).message
      }
    }
    for (const target of [...EDGES, ' eurusd ', 'Coinbase:btcusd', 'a:b:c']) {
      expect(outcome(() => now(target, 'coinbase'))).toBe(outcome(() => old(target, 'coinbase')))
    }
  })

  test("an alert's instrument refuses a bare ticker and an empty half (alerts/store.ts normaliseSymbol)", () => {
    const old = (symbol: string) => {
      const raw = symbol.trim()
      const at = raw.indexOf(':')
      if (at <= 0 || at === raw.length - 1) throw new Error(`not an instrument: '${symbol}' (want vendor:TICKER)`)
      return `${raw.slice(0, at).toLowerCase()}:${raw.slice(at + 1).toUpperCase()}`
    }
    const outcome = (f: () => string) => {
      try {
        return f()
      } catch (err) {
        return (err as Error).message
      }
    }
    for (const symbol of [...EDGES, ' Oanda:eurusd ', 'a:b:c', ':']) {
      expect(outcome(() => normaliseSymbol(symbol))).toBe(outcome(() => old(symbol)))
    }
  })

  test("a deep link's default pane keeps an empty or default vendor out of `v` (layout.ts defaultLayout)", () => {
    const old = (ticker: string) => {
      const [vendor, bare] = ticker.includes(':') ? (ticker.split(':', 2) as [string, string]) : [undefined, ticker]
      return { s: bare, ...(vendor && vendor !== 'oanda' ? { v: vendor } : {}) }
    }
    for (const ticker of EDGES) {
      const pane = defaultLayout(ticker).panes[0]
      expect({ s: pane.s, ...(pane.v === undefined ? {} : { v: pane.v }) }).toEqual(old(ticker))
    }
  })
})

// Three window-free modules spell or parse the key themselves, because importing symbols.ts would
// give them a `window` to need; these hold each to the helpers it stands in for.
describe('the copies in window-free modules', () => {
  test('watch/types.ts instrumentTarget is instrumentKey', () => {
    for (const key of EDGES) {
      const { vendor, ticker } = splitInstrumentKey(key)
      expect(instrumentTarget(vendor, ticker)).toBe(instrumentKey(vendor, ticker))
    }
  })

  test("trading/metrics.ts reads a key's ticker as tickerOf does", () => {
    for (const key of [...EDGES, 'oanda:EUR_USD', 'oanda:SPX500_USD', 'schwab:SPY']) {
      expect(pairCurrencies(key)).toEqual(pairCurrencies(tickerOf(key)))
    }
  })

  test('lab/model.ts normalInstrument reads a bare ticker as the default vendor', () => {
    expect(normalInstrument(' eurusd ')).toBe(instrumentKey(DEFAULT_VENDOR, 'EURUSD'))
    for (const key of ['Coinbase:btcusd', 'oanda:eurusd', 'oanda:']) {
      const { vendor, ticker } = splitInstrumentKey(key)
      expect(normalInstrument(key)).toBe(instrumentKey(vendor.toLowerCase(), ticker.toUpperCase()))
    }
  })
})
