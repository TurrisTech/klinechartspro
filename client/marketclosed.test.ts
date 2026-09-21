import { describe, expect, test } from 'bun:test'

import type { KLineData } from 'klinecharts'
import { dropMarketClosedBars, isLegalCandleOpen } from './marketclosed'
import { dayGeometryOf } from './daygeometry'
import type { MarketHours } from './symbols'

const session = (openDay: string, openTime: string, closeDay: string, closeTime: string) => ({
  openDay,
  openTime,
  closeDay,
  closeTime
})

// The three schedules the store actually holds, exactly as `daygeometry.test.ts` writes them.
const FOREX: MarketHours = {
  timezone: 'America/New_York',
  sessions: [session('sun', '17:00', 'fri', '17:00')]
}
const CRYPTO: MarketHours = { timezone: 'UTC', sessions: [session('mon', '00:00', 'mon', '00:00')] }
const EQUITY: MarketHours = {
  timezone: 'America/New_York',
  sessions: ['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => session(d, '09:30', d, '16:00'))
}

const bar = (timestamp: number): KLineData => ({
  timestamp,
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  volume: 1
})

/** A wire label for a daily-or-coarser bar: the midnight that dates the session, in the
 * INSTRUMENT'S OWN timezone -- `open + 7h` for forex is 00:00 New York, not 00:00 UTC. The
 * UTC offset is spelled out per date rather than derived, so a DST mistake is visible here
 * rather than absorbed by the code under test. */
const wireDay = (iso: string, utcOffset: string) => Date.parse(`${iso}T00:00:00${utcOffset}`)
const EST = '-05:00'
const EDT = '-04:00'
const UTC = 'Z'

const legal = (resolution: string, wireMs: number, hours: MarketHours) => {
  const day = dayGeometryOf(hours)
  if (day === null) throw new Error('fixture has no geometry')
  return isLegalCandleOpen(resolution, wireMs, hours.timezone, day)
}

describe('isLegalCandleOpen — forex', () => {
  // The two kinds measured on prod oanda:EURUSD:1D, and the ordinary weekdays around them.
  test('a weekday daily label is legal', () => {
    expect(legal('1D', wireDay('2019-10-10', EDT), FOREX)).toBe(true)
    expect(legal('1D', wireDay('2013-01-31', EST), FOREX)).toBe(true)
  })

  test('Saturday 17:00 — the weekend-quoting era — is not', () => {
    // Session-dated: a bar opening Sat 17:00 New York is dated Sunday on the wire.
    expect(legal('1D', wireDay('2013-02-03', EST), FOREX)).toBe(false)
  })

  test('Friday 17:00 — the single weekly-close print — is not', () => {
    // Opening Fri 17:00 dates as Saturday, which is not a market day.
    expect(legal('1D', wireDay('2019-10-12', EDT), FOREX)).toBe(false)
  })

  test('an hourly label inside the weekend is on the grid but still closed', () => {
    // This is the case the grid check ALONE would let through: 03:00 is a perfect hour.
    const saturday = Date.parse('2026-09-19T07:00:00Z') // 03:00 New York, a Saturday
    expect(legal('1h', saturday, FOREX)).toBe(false)
    const thursday = Date.parse('2026-09-17T07:00:00Z')
    expect(legal('1h', thursday, FOREX)).toBe(true)
  })

  test('an off-grid intraday label is rejected', () => {
    const onGrid = Date.parse('2026-09-17T07:00:00Z')
    expect(legal('1h', onGrid + 60_000, FOREX)).toBe(false)
    expect(legal('5m', onGrid + 60_000, FOREX)).toBe(false)
    expect(legal('5m', onGrid + 300_000, FOREX)).toBe(true)
  })
})

describe('isLegalCandleOpen — crypto', () => {
  // The regression the bare `isMarketOpen` would have caused: a continuous schedule trades
  // every calendar day, so both weekend days are legal candle opens.
  test('both weekend days are legal daily opens', () => {
    expect(legal('1D', wireDay('2026-09-19', UTC), CRYPTO)).toBe(true) // Saturday
    expect(legal('1D', wireDay('2026-09-20', UTC), CRYPTO)).toBe(true) // Sunday
    expect(legal('1D', wireDay('2026-09-21', UTC), CRYPTO)).toBe(true)
  })

  test('every hour of the weekend is a legal hourly open', () => {
    for (let h = 0; h < 24; h++) {
      expect(legal('1h', Date.parse('2026-09-19T00:00:00Z') + h * 3_600_000, CRYPTO)).toBe(true)
    }
  })

  test('but a misaligned label is still rejected — the only check that catches it here', () => {
    expect(legal('1h', Date.parse('2026-09-19T03:30:00Z'), CRYPTO)).toBe(false)
    expect(legal('1D', wireDay('2026-09-19', UTC) + 3_600_000, CRYPTO)).toBe(false)
  })
})

describe('isLegalCandleOpen — US equities', () => {
  // The anchor is 09:00 while the session opens 09:30: the boundary rule, not the filtering
  // rule. So 09:00 is a legal hourly open and 08:00 is not.
  test('a weekday daily label is legal and a weekend one is not', () => {
    expect(legal('1D', wireDay('2026-09-18', EDT), EQUITY)).toBe(true)
    expect(legal('1D', wireDay('2026-09-19', EDT), EQUITY)).toBe(false)
    expect(legal('1D', wireDay('2026-09-20', EDT), EQUITY)).toBe(false)
  })

  test('the session hours are open and the overnight is not', () => {
    const at = (hhmm: string) => Date.parse(`2026-09-17T${hhmm}:00Z`)
    expect(legal('1h', at('13:00'), EQUITY)).toBe(true) // 09:00 New York, the anchor
    expect(legal('1h', at('19:00'), EQUITY)).toBe(true) // 15:00
    expect(legal('1h', at('20:00'), EQUITY)).toBe(false) // 16:00, the close
    expect(legal('1h', at('12:00'), EQUITY)).toBe(false) // 08:00, pre-market
    expect(legal('1h', at('01:00'), EQUITY)).toBe(false) // 21:00 the night before
  })
})

describe('dropMarketClosedBars', () => {
  test('keeps the legal labels and drops the rest', () => {
    const bars = [
      bar(wireDay('2013-01-31', EST)),
      bar(wireDay('2013-02-01', EST)),
      bar(wireDay('2013-02-03', EST)), // the Sat 17:00 open, dated Sunday
      bar(wireDay('2013-02-04', EST))
    ]
    expect(dropMarketClosedBars(bars, '1D', FOREX).map((b) => b.timestamp)).toEqual([
      wireDay('2013-01-31', EST),
      wireDay('2013-02-01', EST),
      wireDay('2013-02-04', EST)
    ])
  })

  test('the same window survives whole on a continuous schedule', () => {
    const bars = [
      bar(wireDay('2026-09-18', UTC)),
      bar(wireDay('2026-09-19', UTC)),
      bar(wireDay('2026-09-20', UTC)),
      bar(wireDay('2026-09-21', UTC))
    ]
    expect(dropMarketClosedBars(bars, '1D', CRYPTO)).toHaveLength(4)
  })

  test('fails open when the instrument has no schedule', () => {
    const bars = [bar(wireDay('2013-02-03', EST))]
    expect(dropMarketClosedBars(bars, '1D', null)).toBe(bars)
    expect(dropMarketClosedBars(bars, '1D', undefined)).toBe(bars)
    expect(dropMarketClosedBars(bars, '1D', { timezone: 'UTC', sessions: [] })).toBe(bars)
  })

  test('an empty window stays empty', () => {
    expect(dropMarketClosedBars([], '1D', FOREX)).toEqual([])
  })
})
