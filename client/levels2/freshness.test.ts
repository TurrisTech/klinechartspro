import { describe, expect, test } from 'bun:test'
import { CONTINUOUS_DAY, FX_GRID, gridOf } from '../time/timeframes'
import { zonesClockToken, zonesKnownThrough } from './freshness'

// When zones read under a replay's read clock stop being the server's answer: the instant every
// stamp of an interval's zones is known through under the clock, restated from wdashboard-server
// services/asof.py `known_next_start_ms`, which `/levels2` clamps each zone with
// (services/levels2.py `clamp_zone_asof`). A stamp is the open after the bar that decided it, and
// it is known from that bar's close.

/** Wall clock in New York, January 2026 (UTC-5): the 14th is a Wednesday, the 16th a Friday. */
const ny = (day: number, hour: number, minute = 0): number => Date.UTC(2026, 0, day, hour + 5, minute)
const utc = (day: number, hour: number, minute = 0): number => Date.UTC(2026, 0, day, hour, minute)
const COINBASE_GRID = gridOf({ timezone: 'UTC', day: CONTINUOUS_DAY })

describe('zonesKnownThrough', () => {
  test('inside a bar, its own open: the bar before it is the last one closed', () => {
    expect(zonesKnownThrough('1h', ny(14, 10, 15), FX_GRID)).toBe(ny(14, 10))
    expect(zonesKnownThrough('1h', ny(14, 10, 59), FX_GRID)).toBe(ny(14, 10))
    expect(zonesKnownThrough('4h', ny(14, 10, 15), FX_GRID)).toBe(ny(14, 9))
    expect(zonesKnownThrough('1D', ny(14, 10, 15), FX_GRID)).toBe(ny(13, 17))
  })

  test('at a close, the stamp of the bar that just closed: it is known from that instant on', () => {
    expect(zonesKnownThrough('1h', ny(14, 11), FX_GRID)).toBe(ny(14, 11))
    expect(zonesKnownThrough('4h', ny(14, 13), FX_GRID)).toBe(ny(14, 13))
    expect(zonesKnownThrough('1D', ny(14, 17), FX_GRID)).toBe(ny(14, 17))
  })

  test('a daily or weekly bar closing into the weekend is known at Friday 17:00, before its Sunday stamp', () => {
    for (const code of ['1D', '1W']) {
      expect(zonesKnownThrough(code, ny(16, 16, 59), FX_GRID)).toBeLessThan(ny(18, 17))
      expect(zonesKnownThrough(code, ny(16, 17), FX_GRID)).toBe(ny(18, 17))
      expect(zonesKnownThrough(code, ny(17, 12), FX_GRID)).toBe(ny(18, 17))
      // ...and nothing more is known until the next close, the new week's open included.
      expect(zonesKnownThrough(code, ny(18, 17, 30), FX_GRID)).toBe(ny(18, 17))
    }
  })

  test('the last hour before the weekend is known from its Sunday stamp, as the server knows it: late, never early', () => {
    expect(zonesKnownThrough('1h', ny(16, 17), FX_GRID)).toBeLessThan(ny(18, 17))
    expect(zonesKnownThrough('1h', ny(18, 16, 59), FX_GRID)).toBeLessThan(ny(18, 17))
    expect(zonesKnownThrough('1h', ny(18, 17), FX_GRID)).toBe(ny(18, 17))
  })

  test("on the instrument's own schedule: a coinbase day closes at midnight UTC, not 17:00 New York", () => {
    expect(zonesKnownThrough('1D', utc(14, 23, 59), COINBASE_GRID)).toBe(utc(14, 0))
    expect(zonesKnownThrough('1D', utc(15, 0), COINBASE_GRID)).toBe(utc(15, 0))
    expect(zonesKnownThrough('1D', ny(14, 17), COINBASE_GRID)).toBe(utc(14, 0))
  })
})

describe('zonesClockToken', () => {
  const token = (clock: number, intervals: string[]) => zonesClockToken(clock, intervals, FX_GRID)

  test('the same between two closes of every interval read, whatever the clock does in between', () => {
    expect(token(ny(14, 10, 15), ['1h', '1D'])).toBe(token(ny(14, 10, 59), ['1h', '1D']))
  })

  test('different once a bar of an interval read has closed', () => {
    expect(token(ny(14, 10, 59), ['1h', '1D'])).not.toBe(token(ny(14, 11), ['1h', '1D']))
    expect(token(ny(14, 16, 59), ['1D'])).not.toBe(token(ny(14, 17), ['1D']))
  })

  test('a close of an interval NOT read changes nothing', () => {
    expect(token(ny(14, 10, 59), ['1D'])).toBe(token(ny(14, 11), ['1D']))
    expect(token(ny(14, 12, 59), ['1D', '1W'])).toBe(token(ny(14, 13), ['1D', '1W']))
  })

  test('a step back is a new answer too', () => {
    expect(token(ny(14, 10, 15), ['1h'])).not.toBe(token(ny(14, 9, 15), ['1h']))
  })

  test('with no schedule for the instrument, every move of the clock is a new answer', () => {
    expect(zonesClockToken(ny(14, 10, 15), ['1D'], null)).not.toBe(zonesClockToken(ny(14, 10, 16), ['1D'], null))
    expect(zonesClockToken(ny(14, 10, 15), ['1D'], null)).toBe(zonesClockToken(ny(14, 10, 15), ['1D'], null))
  })
})
