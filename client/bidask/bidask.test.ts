import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

installWindow()
const { quoteOf, quoteSource, quoteSourceKey } = await import('./api')
const { bandOpacity, DEFAULT_BAND, quoteValue } = await import('./templates')
const { OhlcvApiError } = await import('../config')
const { WindowStore } = await import('../plugins/store')
import type { OHLCVBar } from '../ohlcv'
import type { PluginFacilities, SourceStore } from '../plugins/types'
import type { StreamListener } from '../stream'
import type { QuotePoint } from './api'

// The bid/ask plugin: which bars count as quoted (the columns exist on every vendor, so it is
// the values that decide), how a window is paged over `/getbars`, and what a live frame does
// to the store.

type Bar = OHLCVBar & Record<string, unknown>

// Real rows, dev and prod `/getbars?columns=all`, 2026-09-17.
const OANDA: Bar = {
  date: 1789614000000,
  open: 1.14582,
  high: 1.14615,
  low: 1.14574,
  close: 1.14602,
  volume: 2749,
  canonical_date: '2026-09-17T00:00:00',
  bid_open: 1.14574,
  bid_high: 1.14608,
  bid_low: 1.14566,
  bid_close: 1.14593,
  ask_open: 1.1459,
  ask_high: 1.14623,
  ask_low: 1.14582,
  ask_close: 1.1461
}
// coinbase stores the trade OHLC in all eight quote columns; schwab stores the mid.
const COINBASE: Bar = {
  date: 1789614000000,
  open: 76303.74,
  high: 76463.59,
  low: 76297.88,
  close: 76364.57,
  volume: 83,
  bid_open: 76303.74,
  bid_high: 76463.59,
  bid_low: 76297.88,
  bid_close: 76364.57,
  ask_open: 76303.74,
  ask_high: 76463.59,
  ask_low: 76297.88,
  ask_close: 76364.57
}

describe('quoteOf', () => {
  test('an OANDA bar is quoted', () => {
    expect(quoteOf(OANDA)).toEqual({
      date: OANDA.date,
      bo: 1.14574,
      bh: 1.14608,
      bl: 1.14566,
      bc: 1.14593,
      ao: 1.1459,
      ah: 1.14623,
      al: 1.14582,
      ac: 1.1461
    })
  })
  test('identical sides are no quote (coinbase, schwab)', () => {
    expect(quoteOf(COINBASE)).toBeNull()
  })
  test('one differing price is enough', () => {
    expect(quoteOf({ ...COINBASE, ask_close: 76364.58 })).not.toBeNull()
  })
  test('missing, null or non-finite columns are no quote', () => {
    const { bid_low: _, ...missing } = OANDA
    expect(quoteOf(missing as Bar)).toBeNull()
    expect(quoteOf({ ...OANDA, ask_high: null })).toBeNull()
    expect(quoteOf({ ...OANDA, bid_close: Number.NaN })).toBeNull()
    const { open, high, low, close, volume, date } = OANDA
    expect(quoteOf({ date, open, high, low, close, volume })).toBeNull()
  })
})

describe('template values', () => {
  test('a bar shows its closes', () => {
    expect(quoteValue(quoteOf(OANDA) as QuotePoint)).toEqual({ ask: 1.1461, bid: 1.14593 })
    expect(quoteValue(undefined)).toEqual({})
  })
  test('band opacity is clamped and defaults', () => {
    expect(bandOpacity([30])).toBe(30)
    expect(bandOpacity(['40'])).toBe(40)
    expect(bandOpacity([0])).toBe(0)
    expect(bandOpacity([250])).toBe(100)
    expect(bandOpacity([-5])).toBe(0)
    expect(bandOpacity([])).toBe(DEFAULT_BAND)
    expect(bandOpacity(undefined)).toBe(DEFAULT_BAND)
    expect(bandOpacity([null])).toBe(DEFAULT_BAND)
  })
})

const HOUR = 3_600_000

function harness(respond: (params: Record<string, unknown>) => unknown) {
  const calls: Array<Record<string, unknown>> = []
  const listeners: Array<{ key: string; listener: StreamListener }> = []
  const f = {
    api: {
      get: async (_path: string, params: Record<string, unknown>) => {
        calls.push(params)
        return respond(params)
      }
    },
    resolutionDurationMs: () => HOUR,
    stream: {
      subscribe: (vendor: string, symbol: string, interval: string, listener: StreamListener) =>
        listeners.push({ key: `${vendor}:${symbol}|${interval}`, listener }),
      unsubscribe: (_v: string, _s: string, _i: string, listener: StreamListener) => {
        const i = listeners.findIndex((l) => l.listener === listener)
        if (i >= 0) listeners.splice(i, 1)
      }
    }
  } as unknown as PluginFacilities
  return { f, calls, listeners }
}

describe('quoteSource', () => {
  test('keyed by instrument and interval', () => {
    const { f } = harness(() => ({ s: 'no_data' }))
    const spec = quoteSource(f, 'oanda', 'EURUSD', '1h', 5000)
    expect(spec.key).toBe(quoteSourceKey('oanda', 'EURUSD', '1h'))
    expect(spec.key).toBe('bidask|oanda:EURUSD|1h')
    expect(spec.resolution).toBe('1h')
  })

  test('pages forwards by nominal span, asks for every column, never sends limit', async () => {
    const { f, calls } = harness(() => [OANDA, COINBASE])
    // 10 bars per request -> 8 per page.
    const spec = quoteSource(f, 'oanda', 'EURUSD', '1h', 10)
    const page = await spec.fetch({ from: 0, to: 20 * HOUR }, 5000)
    expect(calls).toEqual([{ symbol: 'oanda:EURUSD', resolution: '1h', from: 0, to: 8 * HOUR, columns: 'all' }])
    expect(page.nextFrom).toBe(8 * HOUR)
    // The coinbase-shaped row is dropped, not drawn as a zero spread.
    expect(page.points.length).toBe(1)
    const last = await spec.fetch({ from: 16 * HOUR, to: 20 * HOUR }, 5000)
    expect(last.nextFrom).toBeNull()
    expect(calls[1]).toMatchObject({ from: 16 * HOUR, to: 20 * HOUR })
  })

  test('no_data is an empty page', async () => {
    const { f } = harness(() => ({ s: 'no_data' }))
    const page = await quoteSource(f, 'coinbase', 'BTCUSD', '1h', 5000).fetch({ from: 0, to: HOUR }, 5000)
    expect(page).toEqual({ points: [], nextFrom: null })
  })

  test('a 413 splits the window in halves', async () => {
    const { f, calls } = harness((p) => {
      if ((p.to as number) - (p.from as number) > 2 * HOUR) throw new OhlcvApiError(413, 'too_large', 'too many')
      return [{ ...OANDA, date: p.from as number }]
    })
    const page = await quoteSource(f, 'oanda', 'EURUSD', '1h', 5000).fetch({ from: 0, to: 8 * HOUR }, 5000)
    expect(page.points.map((p) => p.date)).toEqual([0, 2 * HOUR, 4 * HOUR, 6 * HOUR])
    expect(calls.length).toBe(7)
  })

  test('any other error propagates', async () => {
    const { f } = harness(() => {
      throw new OhlcvApiError(400, 'invalid_request', 'bad')
    })
    await expect(quoteSource(f, 'oanda', 'EURUSD', '1h', 5000).fetch({ from: 0, to: HOUR }, 5000)).rejects.toThrow('bad')
  })

  test('a close re-reads from after the newest quote held, and a forming frame does nothing', () => {
    const { f, listeners } = harness(() => [])
    const spec = quoteSource(f, 'oanda', 'EURUSD', '1h', 5000)
    const store = new WindowStore<QuotePoint>(spec.key)
    const q = quoteOf(OANDA) as QuotePoint
    // Quotes through 01:00; the 02:00 bar was covered but came back without one (written late).
    store.ingest([{ ...q, date: 0 }, { ...q, date: HOUR }], { from: 0, to: 3 * HOUR })
    let refetches = 0
    const dispose = (spec.subscribe as NonNullable<typeof spec.subscribe>)(store as SourceStore<QuotePoint>, {
      changed: () => {},
      refetch: () => refetches++
    })
    expect(listeners.map((l) => l.key)).toEqual(['oanda:EURUSD|1h'])
    listeners[0].listener.onBar({ ...OANDA, date: 3 * HOUR }, false)
    expect(refetches).toBe(0)
    expect(store.missing({ from: 0, to: 3 * HOUR })).toEqual([])
    listeners[0].listener.onBar({ ...OANDA, date: 2 * HOUR }, true)
    expect(refetches).toBe(1)
    expect(store.missing({ from: 0, to: 3 * HOUR })).toEqual([{ from: HOUR + 1, to: 3 * HOUR }])
    expect([...store.values.keys()]).toEqual([0, HOUR])
    dispose()
    expect(listeners.length).toBe(0)
  })

  test('with no quote held, a close re-reads only the closed bar', () => {
    const { f, listeners } = harness(() => [])
    const spec = quoteSource(f, 'coinbase', 'BTCUSD', '1h', 5000)
    const store = new WindowStore<QuotePoint>(spec.key)
    store.ingest([], { from: 0, to: 5 * HOUR })
    ;(spec.subscribe as NonNullable<typeof spec.subscribe>)(store as SourceStore<QuotePoint>, { changed: () => {}, refetch: () => {} })
    listeners[0].listener.onBar({ ...COINBASE, date: 4 * HOUR }, true)
    expect(store.missing({ from: 0, to: 5 * HOUR })).toEqual([{ from: 4 * HOUR, to: 5 * HOUR }])
  })
})
