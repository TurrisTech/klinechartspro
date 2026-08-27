import { describe, expect, test } from 'bun:test'
import { knownThrough } from './horizon'

// New York is UTC-5 on 2024-03-06 (EST), which is what every wall-clock time below is in.
const NY = (day: number, hour: number, minute = 0): number => Date.UTC(2024, 2, day, hour + 5, minute)

describe('knownThrough', () => {
  test('an intraday source is final through the bar it has forming, on its own grid', () => {
    const cursor = NY(6, 11, 15) // a 15m signal's effective instant: 11:15
    expect(knownThrough('15m', cursor)).toBe(NY(6, 11, 15))
    expect(knownThrough('1h', cursor)).toBe(NY(6, 11))
    // 4h and 8h are anchored on the 17:00 session open, so their grids read 09:00, not 08:00.
    expect(knownThrough('4h', cursor)).toBe(NY(6, 9))
    expect(knownThrough('8h', cursor)).toBe(NY(6, 9))
    expect(knownThrough('3m', cursor)).toBe(NY(6, 11, 15))
  })

  test('a daily source answers on the WIRE clock -- the canonical date, not the 17:00 open', () => {
    // Wednesday's candle opened Tuesday 17:00 and is dated Wednesday 00:00 (open + 7h).
    expect(knownThrough('1D', NY(6, 11, 15))).toBe(NY(6, 0))
    // Still Wednesday's candle a minute before it closes...
    expect(knownThrough('1D', NY(6, 16, 59))).toBe(NY(6, 0))
    // ...and Thursday's the minute after it opens.
    expect(knownThrough('1D', NY(6, 17, 1))).toBe(NY(7, 0))
  })

  test('a cursor exactly on a boundary belongs to the bar that opens there', () => {
    // 12:00 closed the 11:00 bar, so 11:00 is final and 12:00 is the one still forming.
    expect(knownThrough('1h', NY(6, 12))).toBe(NY(6, 12))
  })

  test('an undeclared or unparseable resolution falls back to the cursor itself', () => {
    expect(knownThrough(undefined, NY(6, 11, 15))).toBe(NY(6, 11, 15))
    expect(knownThrough('', NY(6, 11, 15))).toBe(NY(6, 11, 15))
    expect(knownThrough('banana', NY(6, 11, 15))).toBe(NY(6, 11, 15))
  })
})
