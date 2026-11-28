import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BindContext } from '../plugins/types'
import type { InstrumentConfig } from '../symbols'
import { fakeChart, fakeFacilities, fakeIndicator, fakePane, installWindow } from '../plugins/testing'

// The P&L label beside each mtf01 trade states its move in the instrument's own pips, and the pip
// is read from the instrument's configuration -- the `GET /instrument` record the pane's SymbolInfo
// is built from -- never assumed. Each case runs a record through the real path: the config read,
// `fetchSymbolInfo`, the plugin's binding, the template's calc and draw. Until 2026-11-28 the
// plugin passed no pip and the template divided by 0.0001, so a JPY cross read 100x and a crypto
// pair's dollars read as millions of "pips".

installWindow()

const { getIndicatorClass, utils } = await import('klinecharts')
const { createMtf01Plugin } = await import('./plugin')
const { Mtf01Store } = await import('./store')
const { storeFor } = await import('../plugins/store')
const { fetchSymbolInfo } = await import('../symbols')
const { resetInstrumentConfigCache } = await import('../instrumentconfig')
type Trade = import('./api').Mtf01Trade

const FX_WEEK = {
  timezone: 'America/New_York',
  sessions: [{ openDay: 'sun', openTime: '17:00', closeDay: 'fri', closeTime: '17:00' }]
}

function config(vendorSymbol: string, over: Partial<InstrumentConfig> = {}): InstrumentConfig {
  const [vendor, symbol] = vendorSymbol.split(':')
  return {
    vendor,
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
    marketHours: FX_WEEK,
    ...over
  }
}

// What the server's `/instrument` holds. EURHUF is the case a name rule gets wrong: its pip is the
// second decimal with no JPY in the name.
const records: Record<string, InstrumentConfig> = {
  'oanda:EURUSD': config('oanda:EURUSD'),
  'oanda:USDJPY': config('oanda:USDJPY', { forexPipLocation: -2, displayPrecision: 3 }),
  'oanda:EURHUF': config('oanda:EURHUF', { forexPipLocation: -2, displayPrecision: 3 }),
  'coinbase:BTCUSD': config('coinbase:BTCUSD', {
    instrumentType: 'CRYPTO',
    assetClass: 'crypto',
    forexPipLocation: null,
    displayPrecision: 2,
    marketHours: { timezone: 'UTC', sessions: [] }
  })
}

const pristineFetch = globalThis.fetch
const pristineWarn = console.warn

beforeEach(() => {
  resetInstrumentConfigCache()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const symbol = new URL(typeof input === 'string' ? input : input.toString()).searchParams.get('symbol') ?? ''
    const record = records[symbol]
    return record
      ? new Response(JSON.stringify(record), { status: 200 })
      : new Response(JSON.stringify({ detail: 'not found' }), { status: 404 })
  }) as typeof fetch
  // symbols.ts warns about an instrument with no configuration, which one case is on purpose.
  console.warn = () => {}
})

afterEach(() => {
  globalThis.fetch = pristineFetch
  console.warn = pristineWarn
})

type Template = {
  calc: (bars: unknown[], indicator: unknown) => unknown[]
  draw: (params: unknown) => boolean
}

/** The labels the template draws for one trade worth `pnlPrice` on `vendor:ticker`'s 1h pane. */
async function labels(vendor: string, ticker: string, pnlPrice: number): Promise<string[]> {
  const symbol = await fetchSymbolInfo(ticker, vendor)
  const plugin = createMtf01Plugin()
  plugin.register(fakeFacilities())
  const { chart } = fakeChart()
  const spec = plugin.bind({
    chart,
    pane: fakePane('pane', chart, ticker),
    paneIndex: 0,
    indicator: fakeIndicator('MTF01:mtf01', 'mtf01'),
    symbol,
    vendor,
    ticker,
    interval: '1h',
    siblings: [],
    config: undefined
  } as BindContext)
  if (!spec) throw new Error('mtf01 did not bind')
  const key = spec.sources[0].key
  const store = storeFor(key, (k) => new Mtf01Store(k)) as InstanceType<typeof Mtf01Store>
  const hour = 3_600_000
  const at = Date.UTC(2026, 9, 6, 12)
  const bars = [at - hour, at, at + hour].map((timestamp) => ({ timestamp, open: 1, high: 1, low: 1, close: 1 }))
  const trade = { date: at, triggeredAt: at, resolvedAt: at + hour, outcome: 'target', pnlPrice } as Trade
  store.ingest([], { from: bars[0].timestamp, to: bars[2].timestamp + 1 }, { trades: [trade] })

  const extendData = { seriesKey: key, rev: store.rev, ...spec.extendData?.({ sources: [], chartInterval: '1h' }) }
  const template = new (getIndicatorClass('MTF01:mtf01') as new () => Template)()
  const result = template.calc(bars, { calcParams: [], extendData })
  const texts: string[] = []
  const ctx = new Proxy(
    {},
    {
      get: (_, name) => (name === 'fillText' ? (text: string) => texts.push(text) : () => {}),
      set: () => true
    }
  )
  template.draw({
    ctx,
    chart: {
      getDataList: () => bars,
      getVisibleRange: () => ({ realFrom: 0, realTo: bars.length - 1 }),
      getBarSpace: () => ({ bar: 10 })
    },
    indicator: { extendData, result },
    xAxis: { convertToPixel: (i: number) => i * 100 },
    yAxis: { convertToPixel: (v: number) => v }
  })
  return texts
}

describe("the trade label's unit comes from the instrument's configuration", () => {
  test('a JPY cross reads in its configured 0.01 pip, not 100x', async () => {
    expect(await labels('oanda', 'USDJPY', 0.5)).toEqual(['+50.0'])
  })

  test('a pair whose configured pip is the second decimal reads in it whatever its name', async () => {
    expect(await labels('oanda', 'EURHUF', 0.75)).toEqual(['+75.0'])
  })

  test('a four-decimal pair reads in its configured 0.0001 pip', async () => {
    expect(await labels('oanda', 'EURUSD', -0.0025)).toEqual(['-25.0'])
  })

  test('an instrument its configuration prices without pips reads in price, at its display precision', async () => {
    expect(await labels('coinbase', 'BTCUSD', 512.5)).toEqual(['+512.50'])
  })

  test('an instrument with no configuration reads in price, at the precision its price axis uses', async () => {
    const symbol = await fetchSymbolInfo('ZZZTST', 'oanda')
    expect(symbol.pipSize).toBeUndefined()
    expect(symbol.pricePrecision).toBeUndefined()
    expect(await labels('oanda', 'ZZZTST', 1.5)).toEqual([`+${utils.formatPrecision(1.5)}`])
  })
})
