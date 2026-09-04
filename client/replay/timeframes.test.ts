import { describe, expect, test } from 'bun:test'
import boundaries from './fixtures/boundaries.json'
import {
  advanceTarget,
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
