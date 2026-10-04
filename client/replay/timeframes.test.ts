import { describe, expect, test } from 'bun:test'
import boundaries from './fixtures/boundaries.json'
import {
  CONTINUOUS_DAY,
  FX_DAY,
  FX_GRID,
  FX_SCHEDULE,
  advanceTarget,
  gridFor,
  gridOf,
  scheduleOf,
  defaultBase,
  divides,
  finerStored,
  fromWall,
  gcdInterval,
  intervalEnd,
  intervalStart,
  isMarketOpen,
  nextIntervalStart,
  scheduleIntervalEnd,
  scheduleIntervalStart,
  scheduleIsMarketOpen,
  scheduleNextIntervalStart,
  toWall,
  toWireDate,
  validateBase
} from './timeframes'

const TZ = 'America/New_York'

function ny(text: string): number {
  // A wall-clock reading in New York, as an instant.
  const [d, t] = text.split(' ')
  const [y, m, day] = d.split('-').map(Number)
  const [h, mi, s = 0] = t.split(':').map(Number)
  return fromWall(Date.UTC(y, m - 1, day, h, mi, s), TZ)
}

describe('wall clock', () => {
  test('round-trips through the zone, including DST', () => {
    for (const text of ['2024-03-04 09:00', '2024-07-04 12:00', '2024-11-03 00:30', '2024-03-10 03:30']) {
      const ms = ny(text)
      const wall = toWall(ms, TZ)
      expect(fromWall(wall, TZ)).toBe(ms)
    }
  })
  test('a skipped hour rounds up to the next wall time that exists', () => {
    // 2024-03-10 02:30 New York does not exist; 03:30 EDT does.
    expect(toWall(fromWall(Date.UTC(2024, 2, 10, 2, 30), TZ), TZ)).toBe(Date.UTC(2024, 2, 10, 3, 30))
  })
  test('a repeated hour takes the earlier reading', () => {
    // 2024-11-03 01:30 New York happens twice; the earlier is EDT (UTC-4).
    expect(fromWall(Date.UTC(2024, 10, 3, 1, 30), TZ)).toBe(Date.UTC(2024, 10, 3, 5, 30))
  })
})

describe('boundaries match wmarkettypes (fixtures/boundaries.json)', () => {
  const rows = boundaries.rows as Array<{
    at: number
    wall: string
    schedule: string
    tz: string
    day: { open: number; close: number; everyDay: boolean }
    interval: string
    start: number
    end: number
    next: number
    marketOpen: boolean
  }>
  test('fixture is present', () => {
    expect(rows.length).toBeGreaterThan(100)
  })
  // Both schedules the store carries and this port claims to walk. The fx-week rows also go
  // through the unparameterised functions, which are what the replay uses and must keep
  // behaving exactly as they did.
  test('the fixture covers all three schedules the store carries', () => {
    expect(new Set(rows.map((r) => r.schedule))).toEqual(
      new Set(['fx-week', 'continuous', 'session'])
    )
  })
  for (const row of rows) {
    const day = {
      openOffset: row.day.open,
      closeOffset: row.day.close,
      everyDayTrades: row.day.everyDay
    }
    test(`${row.schedule} ${row.interval} at ${row.wall}`, () => {
      expect(scheduleIntervalStart(row.interval, row.at, row.tz, day)).toBe(row.start)
      expect(scheduleIntervalEnd(row.interval, row.at, row.tz, day)).toBe(row.end)
      expect(scheduleNextIntervalStart(row.interval, row.at, row.tz, day)).toBe(row.next)
      expect(scheduleIsMarketOpen(row.at, row.tz, day)).toBe(row.marketOpen)
      if (row.schedule === 'fx-week') {
        expect(intervalStart(row.interval, row.at, TZ)).toBe(row.start)
        expect(intervalEnd(row.interval, row.at, TZ)).toBe(row.end)
        expect(nextIntervalStart(row.interval, row.at, TZ)).toBe(row.next)
        expect(isMarketOpen(row.at, TZ)).toBe(row.marketOpen)
      }
    })
  }
})

describe('advanceTarget', () => {
  test('one hour from mid-bar is the close of that bar', () => {
    expect(advanceTarget('1h', ny('2024-03-04 09:30'), 1)).toBe(ny('2024-03-04 10:00'))
  })
  test('from a close, one candle is the next close', () => {
    expect(advanceTarget('1h', ny('2024-03-04 10:00'), 1)).toBe(ny('2024-03-04 11:00'))
    expect(advanceTarget('1h', ny('2024-03-04 10:00'), 3)).toBe(ny('2024-03-04 13:00'))
  })
  test('out of a Friday evening lands on the Sunday session', () => {
    expect(advanceTarget('1h', ny('2024-03-08 16:30'), 1)).toBe(ny('2024-03-08 17:00'))
    expect(advanceTarget('1h', ny('2024-03-08 17:00'), 1)).toBe(ny('2024-03-10 18:00'))
    expect(advanceTarget('1h', ny('2024-03-09 12:00'), 1)).toBe(ny('2024-03-10 18:00'))
  })
  test('a 1D step lands on the next market day', () => {
    // Thursday 20 Aug 2026 15:00 is inside Thursday's session (closes 17:00).
    expect(advanceTarget('1D', ny('2026-08-20 15:00'), 1)).toBe(ny('2026-08-20 17:00'))
    // Friday's session closes Friday 17:00; the next daily candle closes Monday 17:00.
    expect(advanceTarget('1D', ny('2026-08-20 17:00'), 1)).toBe(ny('2026-08-21 17:00'))
    expect(advanceTarget('1D', ny('2026-08-21 17:00'), 1)).toBe(ny('2026-08-24 17:00'))
  })
  test('a weekly step closes Friday 17:00', () => {
    expect(advanceTarget('1W', ny('2024-03-05 09:00'), 1)).toBe(ny('2024-03-08 17:00'))
    expect(advanceTarget('1W', ny('2024-03-08 17:00'), 1)).toBe(ny('2024-03-15 17:00'))
  })
})

describe('wire dates', () => {
  test('daily-and-coarser bars are dated open + 7h, intraday by their open', () => {
    const open = ny('2024-03-03 17:00')
    expect(toWireDate('1D', open)).toBe(open + 7 * 3_600_000)
    expect(toWireDate('1h', open)).toBe(open)
  })
})

describe('an instrument\'s grid', () => {
  const rows = boundaries.rows as Array<{
    at: number
    tz: string
    schedule: string
    day: { open: number; close: number; everyDay: boolean }
    interval: string
    start: number
    end: number
    next: number
    marketOpen: boolean
  }>

  test('answers exactly as wmarkettypes does, for all three schedules in the fixture', () => {
    for (const row of rows) {
      const grid = gridOf({ timezone: row.tz, day: { openOffset: row.day.open, closeOffset: row.day.close, everyDayTrades: row.day.everyDay } })
      expect([grid.start(row.interval, row.at), grid.end(row.interval, row.at), grid.nextStart(row.interval, row.at), grid.isOpen(row.at)]).toEqual([
        row.start,
        row.end,
        row.next,
        row.marketOpen
      ])
    }
  })

  test('the FX grid steps exactly as the replay always has, across weekends, DST and month ends', () => {
    // An hour-by-hour sweep over a fortnight spanning the spring DST change, from every kind of
    // cursor: mid-bar, on a close, inside the closed window.
    const from = ny('2024-03-01 00:00')
    for (let t = from; t < from + 16 * 86_400_000; t += 3_600_000 + 17 * 60_000) {
      for (const code of ['5m', '1h', '4h', '1D', '1W', '1M']) {
        expect(FX_GRID.advanceTarget(code, t, 2)).toBe(advanceTarget(code, t, 2))
      }
    }
  })

  const UTC = (d: number, h = 0, mi = 0): number => Date.UTC(2024, 2, d, h, mi)
  const crypto = gridOf({ timezone: 'UTC', day: CONTINUOUS_DAY })
  const equities = gridOf({ timezone: 'America/New_York', day: { openOffset: 9, closeOffset: 16, everyDayTrades: false } })

  test('a crypto replay walks through the weekend on UTC days', () => {
    // Friday 23:00 UTC: the next hour is Saturday's first, not Sunday 17:00 New York.
    expect(crypto.advanceTarget('1h', UTC(8, 23), 1)).toBe(UTC(9, 0))
    // A daily step from Saturday noon closes at Sunday's midnight -- every day is a market day.
    expect(crypto.advanceTarget('1D', UTC(9, 12), 1)).toBe(UTC(10, 0))
    expect(crypto.advanceTarget('1D', UTC(10, 0), 1)).toBe(UTC(11, 0))
    // The FX week would have skipped the whole weekend from the same cursor.
    expect(FX_GRID.advanceTarget('1h', ny('2024-03-08 17:00'), 1)).toBe(ny('2024-03-10 18:00'))
    // Daily bars are dated by their open: no session shift on the wire.
    expect(crypto.toWire('1D', UTC(9))).toBe(UTC(9))
    expect(crypto.fromWire('1D', UTC(9))).toBe(UTC(9))
  })

  test('an equity replay steps 09:00-16:00 days and skips the overnight', () => {
    // The 15:00 candle closes at the 16:00 close...
    expect(equities.advanceTarget('1h', ny('2024-03-04 15:30'), 1)).toBe(ny('2024-03-04 16:00'))
    // ...and from the close the next hour is Tuesday's 09:00 candle, closing 10:00.
    expect(equities.advanceTarget('1h', ny('2024-03-04 16:00'), 1)).toBe(ny('2024-03-05 10:00'))
    // A day closes at 16:00; Friday's close steps to Monday's.
    expect(equities.advanceTarget('1D', ny('2024-03-04 12:00'), 1)).toBe(ny('2024-03-04 16:00'))
    expect(equities.advanceTarget('1D', ny('2024-03-08 16:00'), 1)).toBe(ny('2024-03-11 16:00'))
    // Daily bars are dated 9h before their 09:00 open: the midnight of their date.
    expect(equities.toWire('1D', ny('2024-03-04 09:00'))).toBe(ny('2024-03-04 00:00'))
  })

  test('the schedule comes off the SymbolInfo, and none is none -- never a guess', () => {
    expect(scheduleOf({ timezone: 'America/New_York', dayGeometry: FX_DAY })).toEqual(FX_SCHEDULE)
    expect(scheduleOf({ timezone: 'UTC' })).toBeNull()
    expect(scheduleOf({ dayGeometry: FX_DAY })).toBeNull()
    expect(scheduleOf(null)).toBeNull()
    expect(gridFor({ timezone: 'UTC', dayGeometry: CONTINUOUS_DAY })?.schedule.timezone).toBe('UTC')
    expect(gridFor(undefined)).toBeNull()
  })
})

describe('divisibility and the base timeframe', () => {
  test('divides', () => {
    expect(divides('1m', '5m')).toBe(true)
    expect(divides('3m', '5m')).toBe(false)
    expect(divides('4h', '1D')).toBe(true)
    expect(divides('5h', '1D')).toBe(false)
    expect(divides('1D', '1W')).toBe(true)
    expect(divides('1D', '1M')).toBe(true)
    expect(divides('1W', '1M')).toBe(false)
    expect(divides('1M', '1Y')).toBe(true)
    expect(divides('1h', '1W')).toBe(true)
    expect(divides('1D', '4h')).toBe(false)
    // 20m: 20 divides 60, so 1m tiles it and it tiles the hour -- the property that lets it
    // replay off a stored 1m base like every other minute multiple.
    expect(divides('1m', '20m')).toBe(true)
    expect(divides('20m', '1h')).toBe(true)
    expect(divides('20m', '1D')).toBe(true)
    expect(divides('15m', '20m')).toBe(false)
  })
  test('the table from the prompt', () => {
    const stored = ['5s', '1m', '1h', '1D']
    expect(gcdInterval(['3m', '5m'])).toBe('1m')
    expect(defaultBase(['3m', '5m'], stored)).toBe('1m')
    expect(gcdInterval(['1h', '4h'])).toBe('1h')
    expect(defaultBase(['1h', '4h'], stored)).toBe('1h')
    expect(gcdInterval(['15m', '1h'])).toBe('15m')
    expect(defaultBase(['15m', '1h'], stored)).toBe('1m')
    expect(gcdInterval(['20m', '1h'])).toBe('20m')
    expect(defaultBase(['20m', '1h'], stored)).toBe('1m')
    expect(gcdInterval(['15m', '20m'])).toBe('5m')
    expect(gcdInterval(['1D', '1W'])).toBe('1D')
    expect(defaultBase(['1D', '1W'], stored)).toBe('1D')
    expect(defaultBase(['15m', '1h', '4h'], stored)).toBe('1m')
    expect(defaultBase(['1W', '1M'], stored)).toBe('1D')
    expect(defaultBase(['4h', '1D'], stored)).toBe('1h')
    expect(defaultBase(['1h'], ['1m', '1h', '1D'])).toBe('1h')
  })
  test('nothing stored dividing the gcd is null, not a guess', () => {
    expect(defaultBase(['30s', '1m'], ['1m', '1h', '1D'])).toBeNull()
    expect(defaultBase(['30s', '1m'], ['5s', '1m', '1h', '1D'])).toBe('5s')
  })
  test('validateBase rejects a non-divisor and an unstored base', () => {
    const stored = ['5s', '1m', '1h', '1D']
    expect(validateBase('1h', ['15m', '1h'], stored).ok).toBe(false)
    expect(validateBase('1h', ['15m', '1h'], stored).reason).toContain('15m')
    expect(validateBase('15m', ['15m', '1h'], stored).ok).toBe(false)
    expect(validateBase('15m', ['15m', '1h'], stored).reason).toContain('not stored')
    expect(validateBase('1m', ['15m', '1h'], stored)).toEqual({ ok: true })
    expect(validateBase('1D', ['1D', '1W'], stored)).toEqual({ ok: true })
    expect(validateBase('1D', ['4h', '1D'], stored).ok).toBe(false)
  })
  test('the refinement ladder is the stored intervals finer than the candle, finest first', () => {
    expect(finerStored('1h', ['5s', '1m', '1h', '1D'])).toEqual(['5s', '1m'])
    expect(finerStored('1m', ['1m', '1h', '1D'])).toEqual([])
    expect(finerStored('1D', ['1m', '1h', '1D'])).toEqual(['1m', '1h'])
  })
})
