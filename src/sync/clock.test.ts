import { describe, expect, test } from 'bun:test'
import { paneClock, translateTimestamp } from './clock'

// A daily-or-coarser bar is labelled by its session date, an intraday one by its open, and the
// wall carries instants between them. The day geometries are the three the store holds
// (wmarkettypes' day_geometry): forex opens 7h before the midnight that dates its session, crypto
// at that midnight, US equities 9h after it.

const FX = { dayGeometry: { openOffset: -7, closeOffset: 17, everyDayTrades: false } }
const CRYPTO = { dayGeometry: { openOffset: 0, closeOffset: 24, everyDayTrades: true } }
const EQUITY = { dayGeometry: { openOffset: 9, closeOffset: 16, everyDayTrades: false } }

const DAY = { timespan: 'day' }
const HOUR = { timespan: 'hour' }

const at = (iso: string): number => Date.parse(iso)

describe('paneClock', () => {
  test('a session-dated pane is shifted by its instrument; an intraday one never is', () => {
    expect(paneClock(DAY, FX)).toEqual({ sessionDated: true, labelShiftMs: 7 * 3_600_000 })
    expect(paneClock(DAY, EQUITY)).toEqual({ sessionDated: true, labelShiftMs: -9 * 3_600_000 })
    expect(paneClock(HOUR, FX)).toEqual({ sessionDated: false, labelShiftMs: 0 })
    expect(paneClock({ timespan: 'minute' }, EQUITY).labelShiftMs).toBe(0)
  })

  test('week, month and year are session-dated like day', () => {
    for (const timespan of ['week', 'month', 'year']) {
      expect(paneClock({ timespan }, FX)).toEqual({ sessionDated: true, labelShiftMs: 7 * 3_600_000 })
    }
  })

  test('a crypto day is dated by its open: a shift of 0, not -0', () => {
    expect(paneClock(DAY, CRYPTO).labelShiftMs).toBe(0)
  })

  test('an instrument with no resolved schedule reads its labels as opens', () => {
    expect(paneClock(DAY, {})).toEqual({ sessionDated: true, labelShiftMs: 0 })
    expect(paneClock(DAY, undefined)).toEqual({ sessionDated: true, labelShiftMs: 0 })
  })
})

describe('translateTimestamp', () => {
  test('an FX daily bar reaches an hourly pane at 17:00 New York the evening before', () => {
    // EURUSD 1D 2026-10-09 is labelled 00:00 EDT on the 9th and opens 17:00 EDT on the 8th.
    expect(translateTimestamp(at('2026-10-09T04:00:00Z'), paneClock(DAY, FX), paneClock(HOUR, FX))).toBe(
      at('2026-10-08T21:00:00Z')
    )
    // Under EST the same rule: 00:00 EST on 2026-01-15 -> 17:00 EST on the 14th.
    expect(translateTimestamp(at('2026-01-15T05:00:00Z'), paneClock(DAY, FX), paneClock(HOUR, FX))).toBe(
      at('2026-01-14T22:00:00Z')
    )
  })

  test('an hourly instant after 17:00 reaches the daily pane on the NEXT session date', () => {
    // 18:00 EDT on 10-08 is inside the session dated 10-09; restated on the daily axis it is
    // 01:00 on the 9th, which klinecharts floors onto that session's bar.
    const daily = translateTimestamp(at('2026-10-08T22:00:00Z'), paneClock(HOUR, FX), paneClock(DAY, FX))
    expect(daily).toBe(at('2026-10-09T05:00:00Z'))
    expect(daily).toBeGreaterThan(at('2026-10-09T04:00:00Z'))
    expect(daily).toBeLessThan(at('2026-10-10T04:00:00Z'))
  })

  test('weekly and monthly FX bars open at 17:00 before their first market day', () => {
    // The week dated Monday 2026-10-05 opens Sunday 17:00; October 2026 opens Wednesday
    // 2026-09-30 17:00, the evening before its first market day.
    const week = paneClock({ timespan: 'week' }, FX)
    const month = paneClock({ timespan: 'month' }, FX)
    expect(translateTimestamp(at('2026-10-05T04:00:00Z'), week, paneClock(HOUR, FX))).toBe(at('2026-10-04T21:00:00Z'))
    expect(translateTimestamp(at('2026-10-01T04:00:00Z'), month, paneClock(HOUR, FX))).toBe(at('2026-09-30T21:00:00Z'))
  })

  test('an equity day reaches an intraday pane at its 09:00 anchor; a crypto day at midnight', () => {
    expect(translateTimestamp(at('2026-10-09T04:00:00Z'), paneClock(DAY, EQUITY), paneClock(HOUR, EQUITY))).toBe(
      at('2026-10-09T13:00:00Z')
    )
    expect(translateTimestamp(at('2026-10-09T00:00:00Z'), paneClock(DAY, CRYPTO), paneClock(HOUR, CRYPTO))).toBe(
      at('2026-10-09T00:00:00Z')
    )
  })

  test('between two session-dated panes the date passes unchanged, whatever the instruments', () => {
    const label = at('2026-10-09T04:00:00Z')
    expect(translateTimestamp(label, paneClock(DAY, FX), paneClock(DAY, CRYPTO))).toBe(label)
    expect(translateTimestamp(label, paneClock(DAY, FX), paneClock({ timespan: 'week' }, EQUITY))).toBe(label)
  })

  test('between two intraday panes nothing moves', () => {
    const t = at('2026-10-08T21:00:00Z')
    expect(translateTimestamp(t, paneClock(HOUR, FX), paneClock({ timespan: 'minute' }, CRYPTO))).toBe(t)
  })

  test('an intraday instant reaches another instrument\'s daily pane on that instrument\'s session', () => {
    // 22:00 UTC on 10-08 is 18:00 EDT: EURUSD's session dated 10-09 has opened, BTCUSD is
    // still in its 10-08.
    const t = at('2026-10-08T22:00:00Z')
    expect(translateTimestamp(t, paneClock(HOUR, CRYPTO), paneClock(DAY, FX))).toBe(at('2026-10-09T05:00:00Z'))
    expect(translateTimestamp(t, paneClock(HOUR, FX), paneClock(DAY, CRYPTO))).toBe(t)
  })
})
