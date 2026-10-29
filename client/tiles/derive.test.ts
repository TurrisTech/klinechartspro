import { describe, expect, test } from 'bun:test'
import type { KLineData } from 'klinecharts'
import { tradingWeekOf } from '../daygeometry'
import type { MarketHours } from '../symbols'
import { scheduleIsMarketOpen, type TradingWeek, tradingFilter } from '../replay/timeframes'
import { fold, foldedCoveredFrom, foldedCoveredTo, foldsIntradayRows, manifestDay, sourceInterval, sourceWindow } from './derive'
import prod from './fixtures/trading-folds.json'
import type { TileManifest } from './manifest'

// Folding a derived timeframe out of the base tiles, in the browser.
//
// The aggregation is the easy half and the boundary arithmetic is not this file's to prove --
// `../replay/timeframes.test.ts` pins every open, close and next-open against wmarkettypes for
// both schedules. What is proved here is the part that only exists because the tiles are being
// folded rather than fetched: where coverage has to stop, how far the read has to widen, and
// which manifests may be folded at all.

const TZ = 'America/New_York'
const UTC = 'UTC'

// The three schedules as the manifest states them: hours from the midnight that dates a
// session to the day's open and close. Equities anchor at 09:00 with a 09:30 market open.
const FX = { openOffset: -7, closeOffset: 17, everyDayTrades: false }
const CRYPTO = { openOffset: 0, closeOffset: 24, everyDayTrades: true }
const EQUITY = { openOffset: 9, closeOffset: 16, everyDayTrades: false }

// And when each trades, as `/instrument` states it -- which is what decides the rows of an
// intraday fold. Forex and crypto trade their grid; a US equity's sessions open at 09:30.
const FX_WEEK = { timezone: TZ, sessions: [{ openDay: 'sun', openTime: '17:00', closeDay: 'fri', closeTime: '17:00' }] }
const CRYPTO_WEEK = { timezone: UTC, sessions: [{ openDay: 'mon', openTime: '00:00', closeDay: 'mon', closeTime: '00:00' }] }
const EQUITY_WEEK = {
  timezone: TZ,
  sessions: ['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => ({ openDay: d, openTime: '09:30', closeDay: d, closeTime: '16:00' }))
}

/** Monday 4 March 2024 17:00 New York — a session open, so the 4h grid starts on it. */
const MON_1700 = Date.UTC(2024, 2, 4, 22)
const HOUR = 3_600_000

function manifest(extra: Partial<TileManifest> = {}): TileManifest {
  return {
    vendor: 'oanda',
    symbol: 'EURUSD',
    interval: '1h',
    granularity: 'month',
    precision: 5,
    sessionDated: false,
    coveredFrom: MON_1700,
    coveredTo: MON_1700 + 10 * HOUR,
    tiles: [],
    tz: TZ,
    schedule: 'fx-week',
    day: { open: -7, close: 17, everyDay: false },
    ...extra
  }
}

const OANDA = ['5s', '1m', '1h', '1D', '1M']
const SCHWAB = ['1m', '30m', '1D']

describe('which tiled series answers a timeframe', () => {
  test('a stored interval folds from nothing — it has tiles of its own', () => {
    for (const code of OANDA) expect(sourceInterval(code, OANDA)).toBeNull()
  })
  test('every other timeframe names the interval it derives from', () => {
    expect(sourceInterval('3m', OANDA)).toBe('1m')
    expect(sourceInterval('20m', OANDA)).toBe('1m')
    expect(sourceInterval('30m', OANDA)).toBe('1m')
    expect(sourceInterval('4h', OANDA)).toBe('1h')
    expect(sourceInterval('8h', OANDA)).toBe('1h')
    expect(sourceInterval('3D', OANDA)).toBe('1D')
    expect(sourceInterval('1W', OANDA)).toBe('1D')
    expect(sourceInterval('2W', OANDA)).toBe('1D')
    expect(sourceInterval('3M', OANDA)).toBe('1M')
    expect(sourceInterval('1Y', OANDA)).toBe('1M')
  })

  // The case the vendor parameter exists for. schwab stores 30m and NO 1h, so the oanda
  // answers are wrong for it in both directions: 1h is not tiled itself, and 4h cannot fold
  // from a 1h tree that does not exist. Both used to send the browser to a 404 and back to
  // the API.
  test('a vendor with different bases folds differently', () => {
    expect(sourceInterval('1h', SCHWAB)).toBe('30m')
    expect(sourceInterval('2h', SCHWAB)).toBe('30m')
    expect(sourceInterval('4h', SCHWAB)).toBe('30m')
    expect(sourceInterval('8h', SCHWAB)).toBe('30m')
    // 30m IS a base here, so it has tiles of its own.
    expect(sourceInterval('30m', SCHWAB)).toBeNull()
    // Not divisible by 30m, so the finer base answers.
    expect(sourceInterval('5m', SCHWAB)).toBe('1m')
    expect(sourceInterval('15m', SCHWAB)).toBe('1m')
  })

  test('the highest divisor wins, not the finest', () => {
    // Both 1m and 30m divide 60 minutes. 30m is chosen because it reaches ~9 months where
    // 1m reaches ~48 days -- identical candles, six times the history.
    expect(sourceInterval('1h', SCHWAB)).toBe('30m')
  })

  test('a coarser family falls back to the finer one below it', () => {
    // schwab stores no monthly, so a month folds from daily rather than answering null.
    expect(sourceInterval('1M', SCHWAB)).toBe('1D')
    expect(sourceInterval('1Y', SCHWAB)).toBe('1D')
    expect(sourceInterval('1W', SCHWAB)).toBe('1D')
  })
})

describe('which manifests may be folded', () => {
  test('a manifest states its day, and any day can be walked', () => {
    expect(manifestDay(manifest())).toEqual(FX)
    expect(manifestDay(manifest({ day: { open: 0, close: 24, everyDay: true }, tz: UTC }))).toEqual(
      CRYPTO
    )
    // The partial-day one is folded like the others now: the geometry is what the boundary
    // rules need, so there is nothing left for an asset class to decide.
    expect(manifestDay(manifest({ day: { open: 9, close: 16, everyDay: false } }))).toEqual(EQUITY)
  })
  test('a manifest from before the field is refused', () => {
    // Saying nothing is not saying "forex": that build might have been describing any of the
    // three, and there is no way to tell from the tile.
    expect(manifestDay(manifest({ day: undefined }))).toBeNull()
    expect(manifestDay(manifest({ tz: undefined }))).toBeNull()
  })
})

describe('coverage stops at the last whole candle', () => {
  test('a source covering half a candle does not advertise it', () => {
    // 1h covered to Tuesday 03:00, inside the 01:00 4h candle: the fold answers to 01:00.
    const covered = foldedCoveredTo('4h', '1h', MON_1700 + 10 * HOUR, TZ, FX)
    expect(covered).toBe(MON_1700 + 8 * HOUR)
  })
  test('a source covering exactly to a close still stops at that candle', () => {
    // Coverage landing ON an open means none of THAT candle is covered.
    expect(foldedCoveredTo('4h', '1h', MON_1700 + 8 * HOUR, TZ, FX)).toBe(MON_1700 + 8 * HOUR)
  })
  test('coverage ending in the weekend keeps the week’s last candle', () => {
    // A tile period boundary routinely lands in the closed window, where the raw grid runs on
    // but no candle opens. Friday's 13:00 candle closed at 17:00 with the market and is
    // covered; stopping at its open would refuse the last candle of every week.
    const saturday = Date.UTC(2024, 2, 9, 5) // Saturday 9 March 00:00 New York
    const sunday1700 = Date.UTC(2024, 2, 10, 21) // Sunday 10 March 17:00 (EDT)
    expect(foldedCoveredTo('4h', '1h', saturday, TZ, FX)).toBe(sunday1700)
  })
  test('a continuous market has no closed window to step over', () => {
    // Crypto: 4h candles run midnight-anchored and contiguous, so coverage to 09:00 UTC means
    // the 08:00 candle is half covered and the fold stops there.
    const covered = foldedCoveredTo('4h', '1h', Date.UTC(2024, 2, 6, 9), UTC, CRYPTO)
    expect(covered).toBe(Date.UTC(2024, 2, 6, 8))
  })
  test('coverage begins at the candle holding the source’s first bar', () => {
    // Not rounded up: the first candle of a series is folded from whatever history starts
    // with, which is exactly what /getbars returns for the same range.
    expect(foldedCoveredFrom('4h', '1h', MON_1700 + HOUR, TZ, FX)).toBe(MON_1700)
  })
})

describe('the read widens to whole candles', () => {
  test('a window ending mid-candle still reads that candle’s remaining rows', () => {
    // THE reason this function exists. Asking to 23:00 lands inside the 21:00 candle, whose
    // rows run to 01:00 — and that candle IS in the answer, so it has to be read whole.
    const window = sourceWindow('4h', '1h', MON_1700, MON_1700 + 6 * HOUR, TZ, FX)
    expect(window.from).toBe(MON_1700)
    expect(window.to).toBe(MON_1700 + 8 * HOUR)
  })
  test('a session-dated fold converts both clocks', () => {
    // 1W folds from 1D, and both are dated by session (+7h) on the wire. The window is
    // computed on the true instants and handed back on the source's wire clock.
    const sunday1700 = Date.UTC(2024, 2, 10, 21)
    const window = sourceWindow('1W', '1D', sunday1700 + 7 * HOUR, sunday1700 + 7 * HOUR + 86_400_000, TZ, FX)
    expect(window.from).toBe(sunday1700 + 7 * HOUR)
    expect(window.to).toBeGreaterThan(window.from)
  })
})

describe('folding', () => {
  const bars = (n: number, from = MON_1700): KLineData[] =>
    Array.from({ length: n }, (_, i) => ({
      timestamp: from + i * HOUR,
      open: 1 + i / 1000,
      high: 2 + i / 1000,
      low: i / 1000,
      close: 1.5 + i / 1000,
      volume: i + 1
    }))

  test('open of the first, extremes of the bucket, close of the last, volume summed', () => {
    const out = fold('4h', '1h', bars(8), TZ, FX, FX_WEEK)
    expect(out.map((b) => b.timestamp)).toEqual([MON_1700, MON_1700 + 4 * HOUR])
    expect(out[0].open).toBe(1)
    expect(out[0].high).toBe(2.003)
    expect(out[0].low).toBe(0)
    expect(out[0].close).toBe(1.503)
    expect(out[0].volume).toBe(1 + 2 + 3 + 4)
    expect(out[1].open).toBe(1.004)
    expect(out[1].volume).toBe(5 + 6 + 7 + 8)
  })

  test('market-closed rows never reach the calculation', () => {
    // Stored data can carry rows in the closed window; aggregate_ohlcv drops them server-side
    // and so must this, or a folded bar picks up a high no session ever traded at.
    const friday1600 = Date.UTC(2024, 2, 8, 21) // Friday 8 March 16:00 New York
    const rows: KLineData[] = [
      { timestamp: friday1600, open: 1, high: 1, low: 1, close: 1, volume: 10 },
      { timestamp: friday1600 + HOUR, open: 9, high: 9, low: 9, close: 9, volume: 99 }
    ]
    const out = fold('4h', '1h', rows, TZ, FX, FX_WEEK)
    expect(out).toHaveLength(1)
    expect(out[0].high).toBe(1)
    expect(out[0].volume).toBe(10)
  })

  test('a continuous market keeps every row and buckets on its own calendar', () => {
    const midnight = Date.UTC(2024, 2, 9) // a Saturday: closed for FX, open for crypto
    const rows = bars(8, midnight)
    const out = fold('4h', '1h', rows, UTC, CRYPTO, CRYPTO_WEEK)
    expect(out.map((b) => b.timestamp)).toEqual([midnight, midnight + 4 * HOUR])
    expect(out[0].volume).toBe(1 + 2 + 3 + 4)
  })

  test('an empty source folds to nothing rather than to a bar with no rows', () => {
    expect(fold('4h', '1h', [], TZ, FX, FX_WEEK)).toEqual([])
  })
})

// THE ROWS A FOLD TAKES ARE THE ONES THE INSTRUMENT TRADES AT, as `aggregate_ohlcv` takes them.
// `fixtures/trading-folds.json` is prod, 2026-10-29: the tile rows the browser folds, and
// `/getbars`' answer for the same window. Schwab stores SPY's 30m and 1m bars from 07:00 and the
// server folds only those inside the 09:30-16:00 sessions, under a grid anchored at 09:00; a metal
// has stored hours inside its daily 17:00-18:00 break (XAUUSD, Monday 2020-12-07). Folded on the
// boundary rule instead, every SPY bar across 09:00 kept the pre-market half hour.

type Row = number[]
const kline = ([timestamp, open, high, low, close, volume]: Row): KLineData => ({ timestamp, open, high, low, close, volume })

describe('a fold takes the rows the server takes', () => {
  const expectedDropped: Record<string, number> = { 'SPY week': 5, 'SPY morning': 30, 'XAUUSD week': 1 }
  const series = [
    { name: 'SPY week', hours: prod.spy.hours, day: prod.spy.day, source: '30m', part: prod.spy.week },
    { name: 'SPY morning', hours: prod.spy.hours, day: prod.spy.day, source: '1m', part: prod.spy.minutes },
    { name: 'XAUUSD week', hours: prod.xauusd.hours, day: prod.xauusd.day, source: '1h', part: prod.xauusd.week }
  ]

  for (const { name, hours, day, source, part } of series) {
    const tz = (hours as MarketHours).timezone
    const trading = tradingWeekOf(hours as MarketHours)
    const rows = part.rows.map(kline)
    for (const [code, server] of Object.entries(part.server as Record<string, Row[]>)) {
      test(`${name}: ${code} from ${source} is /getbars' ${code}, bar for bar`, () => {
        expect(server.length).toBeGreaterThan(0)
        const folded = fold(code, source, rows, tz, day, trading).filter((b) => b.timestamp >= part.from && b.timestamp < part.to)
        expect(folded).toEqual(server.map(kline))
      })
    }
    test(`${name}: the fixture holds rows the boundary rule keeps and the trading week drops`, () => {
      // What makes the cases above a test of the rule: folded on the boundary rule these rows
      // went in (SPY's 09:00-09:29, the metal's 17:00 hour), and no server bar has them.
      const trades = tradingFilter(trading as TradingWeek)
      const dropped = rows.filter((b) => scheduleIsMarketOpen(b.timestamp, tz, day) && !trades(b.timestamp))
      expect(dropped.length).toBe(expectedDropped[name])
    })
  }

  test('an intraday fold with no trading week has no rule to guess with, and says so', () => {
    expect(() => fold('4h', '1h', [], TZ, FX, null)).toThrow(/trading week/)
  })

  test('a daily source keeps its 09:00-labelled sessions: the trading week is not read', () => {
    // Equity daily bars are labelled at the 09:00 anchor, which the 09:30 sessions do not
    // include: filtered on them, a week folded from its days would have none (the 68-row SPY
    // bug `keep_market_closed_rows` exists for).
    // On the wire a session-dated bar is the midnight of its date: 00:00 New York, 05:00Z in March.
    const days = [4, 5, 6, 7, 8].map((d, i) => ({ timestamp: Date.UTC(2024, 2, d, 5), open: 10 + i, high: 20, low: 5, close: 11 + i, volume: 100 }))
    const week = fold('1W', '1D', days, TZ, EQUITY, EQUITY_WEEK)
    expect(week).toEqual([{ timestamp: Date.UTC(2024, 2, 4, 5), open: 10, high: 20, low: 5, close: 15, volume: 500 }])
    expect(fold('1W', '1D', days, TZ, EQUITY, null)).toEqual(week)
  })

  test('a lira cross folds Istanbul trading hours on the New York grid', () => {
    // USDTRY on prod: the FX week's grid, trading 09:00-18:00 Europe/Istanbul Monday to Friday
    // (UTC+3 all year: 01:00-10:00 New York in early March 2024, 02:00-11:00 after the 10th).
    const usdtry: MarketHours = {
      timezone: TZ,
      sessions: [{ openDay: 'sun', openTime: '17:00', closeDay: 'fri', closeTime: '17:00' }],
      trading: {
        timezone: 'Europe/Istanbul',
        sessions: ['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => ({ openDay: d, openTime: '09:00', closeDay: d, closeTime: '18:00' }))
      }
    }
    // Tuesday 5 March: 1h rows from Monday 17:00 to Tuesday 17:00 New York, volume = the NY hour.
    const rows = Array.from({ length: 24 }, (_, i) => ({ timestamp: MON_1700 + i * HOUR, open: 1, high: 1, low: 1, close: 1, volume: (17 + i) % 24 }))
    const out = fold('4h', '1h', rows, TZ, FX, tradingWeekOf(usdtry))
    // 4h candles open 17, 21, 01, 05, 09, 13 New York; only 01:00-09:59 trades.
    expect(out.map((b) => [new Date(b.timestamp).getUTCHours(), b.volume])).toEqual([
      [6, 1 + 2 + 3 + 4], // the 01:00 candle, whole
      [10, 5 + 6 + 7 + 8], // the 05:00 candle, whole
      [14, 9] // the 09:00 candle: its 09:00 row alone
    ])
  })

  test('a vendor folds intraday rows into its derived intervals only', () => {
    expect(foldsIntradayRows('1h', SCHWAB)).toBe(true) // from 30m
    expect(foldsIntradayRows('5m', SCHWAB)).toBe(true) // from 1m
    expect(foldsIntradayRows('30m', SCHWAB)).toBe(false) // stored
    expect(foldsIntradayRows('1D', SCHWAB)).toBe(false) // stored
    expect(foldsIntradayRows('1W', SCHWAB)).toBe(false) // from 1D
    expect(foldsIntradayRows('4h', OANDA)).toBe(true)
    expect(foldsIntradayRows('1h', OANDA)).toBe(false)
  })
})
