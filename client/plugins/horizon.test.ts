import { describe, expect, test } from 'bun:test'
import { CONTINUOUS_DAY, FX_GRID, gridOf } from '../replay/timeframes'
import { answerableTo, knownThrough } from './horizon'

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

// Where an answer under the clock holds nothing more: the bar dated at the horizon is the only one
// the server can still add, and none of it exists while the clock sits on its open. The chart's
// history read asks the API for nothing from there on (`tiles/join.ts`).
describe('answerableTo', () => {
  const equities = gridOf({ timezone: 'America/New_York', day: { openOffset: 9, closeOffset: 16, everyDayTrades: false } })
  const crypto = gridOf({ timezone: 'UTC', day: CONTINUOUS_DAY })

  test('a clock on the open of the bar forming at it: nothing past the horizon', () => {
    // Where a Step lands for every pane its own interval divides -- a 1h Step's 5s and 1m panes.
    for (const resolution of ['5s', '1m', '15m', '1h']) {
      expect(answerableTo(resolution, NY(6, 12), FX_GRID)).toBe(knownThrough(resolution, NY(6, 12), FX_GRID))
    }
  })

  test('a clock inside it: that bar, and nothing dated after it', () => {
    expect(knownThrough('1h', NY(6, 11, 15), FX_GRID)).toBe(NY(6, 11))
    expect(answerableTo('1h', NY(6, 11, 15), FX_GRID)).toBe(NY(6, 12))
    // 4h is anchored on 17:00, so the bar forming at 11:15 is 09:00's and the next opens 13:00.
    expect(answerableTo('4h', NY(6, 11, 15), FX_GRID)).toBe(NY(6, 13))
    // Five seconds into the hour the 5s bar of 12:00:00 has closed and 12:00:05's has not opened.
    expect(answerableTo('5s', NY(6, 12) + 5_000, FX_GRID)).toBe(NY(6, 12) + 5_000)
  })

  test('a forex day is tested on its OPEN, not on its date', () => {
    // Tuesday 17:00 opens the day dated Wednesday: nothing of it yet, though its date is after.
    expect(knownThrough('1D', NY(5, 17), FX_GRID)).toBe(NY(6, 0))
    expect(answerableTo('1D', NY(5, 17), FX_GRID)).toBe(NY(6, 0))
    // Two hours in it holds rows, dated Wednesday 00:00 -- still after the clock, and answerable.
    expect(answerableTo('1D', NY(5, 19), FX_GRID)).toBe(NY(7, 0))
    // Mid-session the same; and a week bounds at the next week's date -- Monday 00:00 New York,
    // which is EDT by 2024-03-11, an hour short of seven days after this week's.
    expect(answerableTo('1D', NY(6, 11, 15), FX_GRID)).toBe(NY(7, 0))
    expect(knownThrough('1W', NY(6, 11, 15), FX_GRID)).toBe(NY(4, 0))
    expect(answerableTo('1W', NY(6, 11, 15), FX_GRID)).toBe(Date.UTC(2024, 2, 11, 4))
  })

  test('inside the weekend the one bar left is the day that closed before it', () => {
    // Saturday 2024-03-02: Friday's day (dated Friday 00:00) closed at 17:00 and is answered
    // whole; Monday's opens Sunday 17:00, after the clock.
    expect(knownThrough('1D', NY(2, 12), FX_GRID)).toBe(NY(1, 0))
    expect(answerableTo('1D', NY(2, 12), FX_GRID)).toBe(NY(4, 0))
  })

  test('an equity day is dated 9h BEFORE its open, and a crypto day by it', () => {
    // 09:00 opens the day dated 00:00: the answer ends at a date before the clock.
    expect(answerableTo('1D', NY(6, 9), equities)).toBe(NY(6, 0))
    expect(answerableTo('1D', NY(6, 10), equities)).toBe(NY(7, 0))
    expect(answerableTo('1D', Date.UTC(2024, 2, 6), crypto)).toBe(Date.UTC(2024, 2, 6))
    expect(answerableTo('1D', Date.UTC(2024, 2, 6, 1), crypto)).toBe(Date.UTC(2024, 2, 7))
  })

  test('unbounded wherever the horizon is a guess', () => {
    for (const resolution of [undefined, '', 'banana']) expect(answerableTo(resolution, NY(6, 12), FX_GRID)).toBe(Number.POSITIVE_INFINITY)
    expect(answerableTo('1h', NY(6, 12), null)).toBe(Number.POSITIVE_INFINITY)
  })
})
