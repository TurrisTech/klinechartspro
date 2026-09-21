import { describe, expect, test } from 'bun:test'

import {
  currentOpenLabel,
  ema,
  groupPeriods,
  levelsForDay,
  mergeSessions,
  periodKey,
  periodMaps,
  priorLabel,
  sessionDay,
  sessionsFromBars,
  type SessionBar,
  type SessionClock,
  type Unit
} from './calendar'

const DAY = 86_400_000
const HOUR = 3_600_000

const FX: SessionClock = { timezone: 'America/New_York', openOffset: -7, sessionDated: false }
const CRYPTO: SessionClock = { timezone: 'UTC', openOffset: 0, sessionDated: false }
const EQUITY: SessionClock = { timezone: 'America/New_York', openOffset: 9, sessionDated: false }

const dayOf = (year: number, month: number, date: number): number => Date.UTC(year, month - 1, date) / DAY

describe('sessionDay', () => {
  test('the forex week opens on Sunday evening and that bar is Monday', () => {
    // 2026-09-20 is a Sunday; 17:00 New York is 21:00Z on EDT.
    expect(sessionDay(Date.UTC(2026, 8, 20, 21), FX)).toBe(dayOf(2026, 9, 21))
    // And the last bar before the week closed -- 16:59 on the Friday -- is still Friday's.
    expect(sessionDay(Date.UTC(2026, 8, 18, 20, 59), FX)).toBe(dayOf(2026, 9, 18))
  })

  test('a forex bar during the New York afternoon is that day', () => {
    expect(sessionDay(Date.UTC(2026, 8, 22, 18), FX)).toBe(dayOf(2026, 9, 22))
  })

  test('crypto dates by its own UTC midnight', () => {
    expect(sessionDay(Date.UTC(2026, 8, 22, 0), CRYPTO)).toBe(dayOf(2026, 9, 22))
    expect(sessionDay(Date.UTC(2026, 8, 22, 23, 59), CRYPTO)).toBe(dayOf(2026, 9, 22))
  })

  test('an equity bar in the regular session is that day; a pre-market bar dates to the session its anchor names', () => {
    // 09:30 New York = 13:30Z on EDT.
    expect(sessionDay(Date.UTC(2026, 8, 22, 13, 30), EQUITY)).toBe(dayOf(2026, 9, 22))
    // 04:00 New York is before the 09:00 anchor, so it falls on the previous session --
    // the same rule the SESSIONS week line uses, and the reason the overnight "belongs to
    // neither" day in the boundary rules.
    expect(sessionDay(Date.UTC(2026, 8, 22, 8), EQUITY)).toBe(dayOf(2026, 9, 21))
  })

  test('a daily bar is read on its canonical date, whatever the geometry', () => {
    const dated: SessionClock = { ...FX, sessionDated: true }
    expect(sessionDay(Date.UTC(2026, 8, 22, 4), dated)).toBe(dayOf(2026, 9, 22))
  })
})

describe('periodKey', () => {
  const monday = dayOf(2026, 9, 21)

  test('a week runs Monday to Sunday', () => {
    expect(periodKey(monday, 'W')).toBe(periodKey(monday + 6, 'W'))
    expect(periodKey(monday, 'W')).not.toBe(periodKey(monday - 1, 'W'))
    expect(periodKey(monday, 'W')).not.toBe(periodKey(monday + 7, 'W'))
  })

  test('months, quarters and years come off the calendar', () => {
    expect(periodKey(dayOf(2026, 9, 30), 'M')).toBe(periodKey(dayOf(2026, 9, 1), 'M'))
    expect(periodKey(dayOf(2026, 9, 30), 'M')).not.toBe(periodKey(dayOf(2026, 10, 1), 'M'))
    expect(periodKey(dayOf(2026, 7, 1), 'Q')).toBe(periodKey(dayOf(2026, 9, 30), 'Q'))
    expect(periodKey(dayOf(2026, 7, 1), 'Q')).not.toBe(periodKey(dayOf(2026, 6, 30), 'Q'))
    expect(periodKey(dayOf(2026, 1, 1), 'Y')).toBe(periodKey(dayOf(2026, 12, 31), 'Y'))
  })
})

const session = (day: number, open: number, high: number, low: number, close: number): SessionBar => ({ day, open, high, low, close })

describe('groupPeriods', () => {
  test('a calendar candle is its sessions: first open, extremes, last close', () => {
    const sessions = [
      session(dayOf(2026, 8, 3), 10, 12, 9, 11),
      session(dayOf(2026, 8, 20), 11, 15, 8, 14),
      session(dayOf(2026, 9, 1), 14, 16, 13, 15)
    ]
    const months = groupPeriods(sessions, 'M')
    expect(months).toHaveLength(2)
    expect(months[0]).toMatchObject({ open: 10, high: 15, low: 8, close: 14, firstDay: dayOf(2026, 8, 3) })
    expect(months[1]).toMatchObject({ open: 14, high: 16, low: 13, close: 15 })
  })
})

describe('levelsForDay', () => {
  const units: Unit[] = ['M', 'W', 'D']
  const sessions = [
    session(dayOf(2026, 8, 31), 10, 12, 9, 11),
    session(dayOf(2026, 9, 1), 11, 14, 10, 13),
    session(dayOf(2026, 9, 2), 13, 15, 12, 14)
  ]
  const maps = periodMaps(sessions, units)
  const levels = levelsForDay(dayOf(2026, 9, 2), maps, units)
  const find = (label: string) => levels.find((level) => level.label === label)

  test('the period in progress contributes its open', () => {
    expect(find('Sep open')?.price).toBe(11)
    expect(find('day open')?.price).toBe(13)
  })

  test('the period before it contributes high, low and midpoint', () => {
    expect(find('prev day high')?.price).toBe(14)
    expect(find('prev day low')?.price).toBe(10)
    expect(find('prev day mid')?.price).toBe(12)
    expect(find('Aug high')?.price).toBe(12)
  })

  test('the developing high and low of the period in progress are NOT levels', () => {
    expect(levels.some((level) => level.label.includes('Sep high'))).toBe(false)
  })

  test('a unit with no earlier period contributes only its open', () => {
    const early = levelsForDay(dayOf(2026, 8, 31), maps, units)
    expect(early.filter((level) => level.unit === 'M').map((level) => level.kind)).toEqual(['open'])
  })
})

describe('labels', () => {
  test('a period in progress is named by what it is', () => {
    expect(currentOpenLabel('Y', dayOf(2026, 1, 2))).toBe('2026 open')
    expect(currentOpenLabel('Q', dayOf(2026, 8, 3))).toBe('Q3 open')
    expect(currentOpenLabel('M', dayOf(2026, 8, 3))).toBe('Aug open')
    expect(currentOpenLabel('W', dayOf(2026, 9, 21))).toBe('week open')
  })

  test('a month or quarter in another year carries the year', () => {
    expect(priorLabel('M', dayOf(2025, 12, 1), dayOf(2026, 1, 5), 'high')).toBe("Dec '25 high")
    expect(priorLabel('M', dayOf(2026, 8, 3), dayOf(2026, 9, 2), 'low')).toBe('Aug low')
    expect(priorLabel('Y', dayOf(2025, 1, 2), dayOf(2026, 1, 5), 'mid')).toBe('2025 mid')
  })
})

describe('ema', () => {
  test('nothing until the window is full, then the simple average', () => {
    const values = [1, 2, 3, 4, 5]
    const out = ema(values, 3)
    expect(out.slice(0, 2)).toEqual([undefined, undefined])
    expect(out[2]).toBeCloseTo(2, 10)
    expect(out[3]).toBeCloseTo(4 * 0.5 + 2 * 0.5, 10)
  })

  test('a series shorter than the window is all undefined', () => {
    expect(ema([1, 2], 3)).toEqual([undefined, undefined])
  })
})

describe('sessions from bars', () => {
  const bars = [
    { timestamp: 0, open: 1, high: 3, low: 0.5, close: 2 },
    { timestamp: HOUR, open: 2, high: 4, low: 1.5, close: 3 },
    { timestamp: DAY, open: 3, high: 5, low: 2.5, close: 4 }
  ]

  test('bars fold into the session they belong to', () => {
    expect(sessionsFromBars(bars, CRYPTO)).toEqual([
      { day: 0, open: 1, high: 4, low: 0.5, close: 3 },
      { day: 1, open: 3, high: 5, low: 2.5, close: 4 }
    ])
  })

  test('the feed wins, and the chart only extends past its last day', () => {
    const fed = [session(0, 9, 9, 9, 9)]
    expect(mergeSessions(fed, sessionsFromBars(bars, CRYPTO))).toEqual([
      { day: 0, open: 9, high: 9, low: 9, close: 9 },
      { day: 1, open: 3, high: 5, low: 2.5, close: 4 }
    ])
  })

  test('with no feed at all the chart bars are the sessions', () => {
    expect(mergeSessions([], sessionsFromBars(bars, CRYPTO))).toHaveLength(2)
  })
})
