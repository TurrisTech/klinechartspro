import { describe, expect, test } from 'bun:test'
import type { KLineData } from 'klinecharts'
import { fold, foldedCoveredFrom, foldedCoveredTo, manifestDay, sourceInterval, sourceWindow } from './derive'
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

describe('which tiled series answers a timeframe', () => {
  test('a stored interval folds from nothing — it has tiles of its own', () => {
    for (const code of ['5s', '1m', '1h', '1D', '1M']) expect(sourceInterval(code)).toBeNull()
  })
  test('every other timeframe names the interval it derives from', () => {
    expect(sourceInterval('3m')).toBe('1m')
    expect(sourceInterval('20m')).toBe('1m')
    expect(sourceInterval('30m')).toBe('1m')
    expect(sourceInterval('4h')).toBe('1h')
    expect(sourceInterval('8h')).toBe('1h')
    expect(sourceInterval('3D')).toBe('1D')
    expect(sourceInterval('1W')).toBe('1D')
    expect(sourceInterval('2W')).toBe('1D')
    expect(sourceInterval('3M')).toBe('1M')
    expect(sourceInterval('1Y')).toBe('1M')
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
    const out = fold('4h', '1h', bars(8), TZ, FX)
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
    const out = fold('4h', '1h', rows, TZ, FX)
    expect(out).toHaveLength(1)
    expect(out[0].high).toBe(1)
    expect(out[0].volume).toBe(10)
  })

  test('a continuous market keeps every row and buckets on its own calendar', () => {
    const midnight = Date.UTC(2024, 2, 9) // a Saturday: closed for FX, open for crypto
    const rows = bars(8, midnight)
    const out = fold('4h', '1h', rows, UTC, CRYPTO)
    expect(out.map((b) => b.timestamp)).toEqual([midnight, midnight + 4 * HOUR])
    expect(out[0].volume).toBe(1 + 2 + 3 + 4)
  })

  test('an empty source folds to nothing rather than to a bar with no rows', () => {
    expect(fold('4h', '1h', [], TZ, FX)).toEqual([])
  })
})
