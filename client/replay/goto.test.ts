import { describe, expect, test } from 'bun:test'
import { goToInstant, isTradingDay, onBaseBoundary } from './clock'
import { CONTINUOUS_DAY, FX_GRID, fromWall, gridOf, toWall } from './timeframes'

// GO TO: a time of day on the instrument's own clock, on its next trading day, at its next
// occurrence, or on a chosen date -- the target a Go to advance runs to (session.ts `goTo`).

const NY = 'America/New_York'
const wall = (iso: string, tz = NY): number => fromWall(Date.parse(`${iso}Z`), tz)
const SIX = 6 * 60
const day = (iso: string): number => Date.parse(`${iso}T00:00Z`)

describe('goToInstant on the FX week', () => {
  test('"6am of the next trading day" is the next weekday after the cursor\'s own day', () => {
    // Wednesday 05:05 and Wednesday 20:00 (already Thursday's session): both go to Thursday.
    expect(goToInstant(wall('2026-10-21T05:05'), { mode: 'day', minute: SIX }, FX_GRID)).toBe(wall('2026-10-22T06:00'))
    expect(goToInstant(wall('2026-10-21T20:00'), { mode: 'day', minute: SIX }, FX_GRID)).toBe(wall('2026-10-22T06:00'))
    // From Friday, and from the weekend, Monday: Saturday and Sunday do not trade at 06:00.
    expect(goToInstant(wall('2026-10-23T10:00'), { mode: 'day', minute: SIX }, FX_GRID)).toBe(wall('2026-10-26T06:00'))
    expect(goToInstant(wall('2026-10-25T18:00'), { mode: 'day', minute: SIX }, FX_GRID)).toBe(wall('2026-10-26T06:00'))
  })

  test('the next occurrence may be today', () => {
    expect(goToInstant(wall('2026-10-21T05:05'), { mode: 'next', minute: SIX }, FX_GRID)).toBe(wall('2026-10-21T06:00'))
    expect(goToInstant(wall('2026-10-21T06:00'), { mode: 'next', minute: SIX }, FX_GRID)).toBe(wall('2026-10-22T06:00'))
    expect(goToInstant(wall('2026-10-23T20:00'), { mode: 'next', minute: SIX }, FX_GRID)).toBe(wall('2026-10-26T06:00'))
  })

  test('a chosen date, and none at or before the clock', () => {
    expect(goToInstant(wall('2026-10-21T05:05'), { mode: 'date', minute: 9 * 60 + 30, day: day('2026-10-28') }, FX_GRID)).toBe(wall('2026-10-28T09:30'))
    expect(goToInstant(wall('2026-10-21T05:05'), { mode: 'date', minute: SIX, day: day('2026-10-20') }, FX_GRID)).toBeNull()
    expect(goToInstant(wall('2026-10-21T05:05'), { mode: 'date', minute: SIX }, FX_GRID)).toBeNull()
  })

  test('across the DST change the time stays on the wall clock', () => {
    // New York leaves daylight time on 2026-11-01: 06:00 is 10:00Z before and 11:00Z after.
    expect(goToInstant(wall('2026-10-30T07:00'), { mode: 'day', minute: SIX }, FX_GRID)).toBe(Date.parse('2026-11-02T11:00Z'))
    expect(toWall(Date.parse('2026-11-02T11:00Z'), NY)).toBe(Date.parse('2026-11-02T06:00Z'))
  })

  test('trading days are Monday to Friday', () => {
    const days = ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-30'].map((d) => isTradingDay(day(d), FX_GRID))
    expect(days).toEqual([false, false, true, true])
  })
})

describe('goToInstant on other schedules', () => {
  test('a continuous schedule trades every day, on its own zone', () => {
    const crypto = gridOf({ timezone: 'UTC', day: CONTINUOUS_DAY })
    expect(goToInstant(Date.parse('2026-10-23T10:00Z'), { mode: 'day', minute: SIX }, crypto)).toBe(Date.parse('2026-10-24T06:00Z'))
  })

  test('US equities: 06:00 before the bell on the next weekday', () => {
    const equities = gridOf({ timezone: NY, day: { openOffset: 9, closeOffset: 16, everyDayTrades: false } })
    expect(goToInstant(wall('2026-10-23T12:00'), { mode: 'day', minute: SIX }, equities)).toBe(wall('2026-10-26T06:00'))
  })
})

describe('onBaseBoundary', () => {
  test('a boundary is itself; inside a candle, its close; nothing trading, itself', () => {
    expect(onBaseBoundary(wall('2026-10-21T06:00'), '3m', FX_GRID)).toBe(wall('2026-10-21T06:00'))
    expect(onBaseBoundary(wall('2026-10-21T06:01'), '3m', FX_GRID)).toBe(wall('2026-10-21T06:03'))
    expect(onBaseBoundary(wall('2026-10-21T06:01'), '1h', FX_GRID)).toBe(wall('2026-10-21T07:00'))
    expect(onBaseBoundary(wall('2026-10-24T06:00'), '1m', FX_GRID)).toBe(wall('2026-10-24T06:00'))
  })
})
