import { describe, expect, test } from 'bun:test'
import { CONTINUOUS_DAY, FX_GRID, gridOf } from '../replay/timeframes'
import { knownThrough } from './horizon'

// New York is UTC-5 on 2024-03-06 (EST), which is what every wall-clock time below is in.
const NY = (day: number, hour: number, minute = 0): number => Date.UTC(2024, 2, day, hour + 5, minute)

describe('knownThrough', () => {
  test('an intraday source is final through the bar it has forming, on its own grid', () => {
    const cursor = NY(6, 11, 15) // a 15m signal's effective instant: 11:15
    expect(knownThrough('15m', cursor, FX_GRID)).toBe(NY(6, 11, 15))
    expect(knownThrough('1h', cursor, FX_GRID)).toBe(NY(6, 11))
    // 4h and 8h are anchored on the 17:00 session open, so their grids read 09:00, not 08:00.
    expect(knownThrough('4h', cursor, FX_GRID)).toBe(NY(6, 9))
    expect(knownThrough('8h', cursor, FX_GRID)).toBe(NY(6, 9))
    expect(knownThrough('3m', cursor, FX_GRID)).toBe(NY(6, 11, 15))
  })

  test('a daily source answers on the WIRE clock -- the canonical date, not the 17:00 open', () => {
    // Wednesday's candle opened Tuesday 17:00 and is dated Wednesday 00:00 (open + 7h).
    expect(knownThrough('1D', NY(6, 11, 15), FX_GRID)).toBe(NY(6, 0))
    // Still Wednesday's candle a minute before it closes...
    expect(knownThrough('1D', NY(6, 16, 59), FX_GRID)).toBe(NY(6, 0))
    // ...and Thursday's the minute after it opens.
    expect(knownThrough('1D', NY(6, 17, 1), FX_GRID)).toBe(NY(7, 0))
  })

  test('a cursor exactly on a boundary belongs to the bar that opens there', () => {
    // 12:00 closed the 11:00 bar, so 11:00 is final and 12:00 is the one still forming.
    expect(knownThrough('1h', NY(6, 12), FX_GRID)).toBe(NY(6, 12))
  })

  test('an undeclared or unparseable resolution falls back to the cursor itself', () => {
    expect(knownThrough(undefined, NY(6, 11, 15), FX_GRID)).toBe(NY(6, 11, 15))
    expect(knownThrough('', NY(6, 11, 15), FX_GRID)).toBe(NY(6, 11, 15))
    expect(knownThrough('banana', NY(6, 11, 15), FX_GRID)).toBe(NY(6, 11, 15))
  })

  test('a coinbase pane is final through ITS forming bar: UTC days, not 17:00 New York', () => {
    const crypto = gridOf({ timezone: 'UTC', day: CONTINUOUS_DAY })
    // Wednesday 15:15 New York is 20:15 UTC: the day forming is Wednesday's, dated by its open.
    const cursor = NY(6, 15, 15)
    expect(knownThrough('1D', cursor, crypto)).toBe(Date.UTC(2024, 2, 6))
    // The FX week would have answered Wednesday's canonical date too -- but from 17:00 New York
    // on, it moves to Thursday while the UTC day is still Wednesday's.
    expect(knownThrough('1D', NY(6, 18), FX_GRID)).toBe(NY(7, 0))
    expect(knownThrough('1D', NY(6, 18), crypto)).toBe(Date.UTC(2024, 2, 6))
    // 4h is anchored on the UTC midnight, not on 17:00.
    expect(knownThrough('4h', cursor, crypto)).toBe(Date.UTC(2024, 2, 6, 20))
  })

  test('an equity pane: the day is dated 9h before its 09:00 open, and 4h runs from 09:00', () => {
    const equities = gridOf({ timezone: 'America/New_York', day: { openOffset: 9, closeOffset: 16, everyDayTrades: false } })
    const cursor = NY(6, 11, 15)
    expect(knownThrough('1D', cursor, equities)).toBe(NY(6, 0))
    expect(knownThrough('4h', cursor, equities)).toBe(NY(6, 9))
  })

  test('a pane with no schedule forgets from earlier than any schedule could need', () => {
    const cursor = NY(6, 11, 15)
    for (const resolution of ['15m', '1h', '4h', '1D', '1W']) {
      const conservative = knownThrough(resolution, cursor, null)
      expect(conservative).toBeLessThan(knownThrough(resolution, cursor, FX_GRID))
      expect(conservative).toBeLessThan(knownThrough(resolution, cursor, gridOf({ timezone: 'UTC', day: CONTINUOUS_DAY })))
    }
  })
})
