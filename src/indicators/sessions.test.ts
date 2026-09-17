import { describe, expect, test } from 'bun:test'

import type { KLineData } from 'klinecharts'

import sessions, {
  GLOBAL_SESSIONS,
  type TradingSession,
  US_EQUITY_SESSIONS,
  coveredRuns,
  sessionCoversBar,
  sessionsFor,
  wallClock,
  zoneOffsetMinutes
} from './sessions'

const utc = (iso: string): number => Date.parse(`${iso}Z`)
const MIN = 60_000
const HOUR = 60 * MIN

const byId = (list: readonly TradingSession[], id: string): TradingSession => {
  const found = list.find((s) => s.id === id)
  if (!found) throw new Error(id)
  return found
}
const tokyo = byId(GLOBAL_SESSIONS, 'tokyo')
const london = byId(GLOBAL_SESSIONS, 'london')
const newYork = byId(GLOBAL_SESSIONS, 'newyork')
const regular = byId(US_EQUITY_SESSIONS, 'regular')

describe('zoneOffsetMinutes', () => {
  test('follows each zone through its own DST rule', () => {
    expect(zoneOffsetMinutes('Europe/London', utc('2026-01-14T12:00:00'))).toBe(0)
    expect(zoneOffsetMinutes('Europe/London', utc('2026-07-15T12:00:00'))).toBe(60)
    expect(zoneOffsetMinutes('America/New_York', utc('2026-01-14T12:00:00'))).toBe(-300)
    expect(zoneOffsetMinutes('America/New_York', utc('2026-07-15T12:00:00'))).toBe(-240)
    expect(zoneOffsetMinutes('Asia/Tokyo', utc('2026-07-15T12:00:00'))).toBe(540)
  })

  test('the US spring transition is seen on the quarter hour it happens', () => {
    // 2026-03-08 07:00Z is 02:00 EST, when New York jumps to EDT.
    expect(zoneOffsetMinutes('America/New_York', utc('2026-03-08T06:59:00'))).toBe(-300)
    expect(zoneOffsetMinutes('America/New_York', utc('2026-03-08T07:00:00'))).toBe(-240)
  })
})

describe('wallClock', () => {
  test('reads the local weekday and minute', () => {
    // Wednesday 2026-07-15 07:30Z is 16:30 in Tokyo.
    const clock = wallClock('Asia/Tokyo', utc('2026-07-15T07:30:00'))
    expect(clock.weekday).toBe(3)
    expect(clock.minuteOfDay).toBe(16 * 60 + 30)
  })

  test('crossing local midnight advances the day and weekday', () => {
    const before = wallClock('Asia/Tokyo', utc('2026-07-15T14:59:00'))
    const after = wallClock('Asia/Tokyo', utc('2026-07-15T15:00:00'))
    expect(after.day).toBe(before.day + 1)
    expect(after.weekday).toBe(4)
    expect(after.minuteOfDay).toBe(0)
  })
})

describe('sessionCoversBar', () => {
  test('London opens at 08:00 local in both halves of the year', () => {
    // Summer: 08:00 BST is 07:00Z.
    expect(sessionCoversBar(london, utc('2026-07-15T06:59:00'), MIN)).toBe(false)
    expect(sessionCoversBar(london, utc('2026-07-15T07:00:00'), MIN)).toBe(true)
    // Winter: 08:00 GMT is 08:00Z.
    expect(sessionCoversBar(london, utc('2026-01-14T07:59:00'), MIN)).toBe(false)
    expect(sessionCoversBar(london, utc('2026-01-14T08:00:00'), MIN)).toBe(true)
  })

  test('the close is exclusive', () => {
    expect(sessionCoversBar(london, utc('2026-01-14T16:59:00'), MIN)).toBe(true)
    expect(sessionCoversBar(london, utc('2026-01-14T17:00:00'), MIN)).toBe(false)
  })

  test('a bar is covered when any part of it is in session', () => {
    // A 4h bar closing exactly as London opens is not; one closing an hour later is.
    expect(sessionCoversBar(london, utc('2026-01-14T04:00:00'), 4 * HOUR)).toBe(false)
    expect(sessionCoversBar(london, utc('2026-01-14T05:00:00'), 4 * HOUR)).toBe(true)
    // A bar that opens inside and runs past the close still counts.
    expect(sessionCoversBar(london, utc('2026-01-14T16:00:00'), 4 * HOUR)).toBe(true)
  })

  test('a weekend hour in session time is never in session', () => {
    // Saturday 2026-07-18 00:00Z is 09:00 JST.
    expect(sessionCoversBar(tokyo, utc('2026-07-18T00:00:00'), MIN)).toBe(false)
    // Monday the same hour is.
    expect(sessionCoversBar(tokyo, utc('2026-07-20T00:00:00'), MIN)).toBe(true)
  })

  test('New York equity hours are read on New York time', () => {
    // 2026-03-10 is EDT: 09:30 is 13:30Z.
    expect(sessionCoversBar(regular, utc('2026-03-10T13:29:00'), MIN)).toBe(false)
    expect(sessionCoversBar(regular, utc('2026-03-10T13:30:00'), MIN)).toBe(true)
    expect(sessionCoversBar(regular, utc('2026-03-10T20:00:00'), MIN)).toBe(false)
    // A week earlier, still EST: 09:30 is 14:30Z.
    expect(sessionCoversBar(regular, utc('2026-03-03T13:30:00'), MIN)).toBe(false)
    expect(sessionCoversBar(regular, utc('2026-03-03T14:30:00'), MIN)).toBe(true)
  })

  test('London and New York overlap for four hours', () => {
    // Summer: London 08:00-17:00 BST is 07:00-16:00Z, New York 08:00-17:00 EDT is 12:00-21:00Z.
    const both = (iso: string) => sessionCoversBar(london, utc(iso), MIN) && sessionCoversBar(newYork, utc(iso), MIN)
    expect(both('2026-07-15T11:59:00')).toBe(false)
    expect(both('2026-07-15T12:00:00')).toBe(true)
    expect(both('2026-07-15T15:59:00')).toBe(true)
    expect(both('2026-07-15T16:00:00')).toBe(false)
  })

  test('a bar reaching the next local day sees that day\'s session, weekday only', () => {
    const early: TradingSession = { id: 'x', label: 'x', timezone: 'UTC', open: 0, close: 60, color: '#000' }
    // Sunday 23:30Z to Monday 00:30Z: Monday's session starts inside the bar.
    expect(sessionCoversBar(early, utc('2026-07-12T23:30:00'), HOUR)).toBe(true)
    // Friday 23:30Z to Saturday 00:30Z: Saturday has no session.
    expect(sessionCoversBar(early, utc('2026-07-17T23:30:00'), HOUR)).toBe(false)
  })
})

describe('sessionsFor', () => {
  test('equities get the New York day, everything else the three centres', () => {
    expect(sessionsFor('equity').map((s) => s.id)).toEqual(['premarket', 'regular', 'afterhours'])
    for (const assetClass of ['forex', 'metal', 'cfd', 'crypto', undefined]) {
      expect(sessionsFor(assetClass).map((s) => s.id)).toEqual(['tokyo', 'london', 'newyork'])
    }
  })
})

describe('coveredRuns', () => {
  test('merges consecutive covered bars into inclusive runs', () => {
    // 1h bars from Wednesday 2026-01-14 00:00Z; London (winter) is bars 8..16.
    const bars: KLineData[] = Array.from({ length: 24 }, (_, i) => {
      const t = utc('2026-01-14T00:00:00') + i * HOUR
      return { timestamp: t, open: 1, high: 1, low: 1, close: 1 }
    })
    expect(coveredRuns(london, bars, 0, 23, HOUR)).toEqual([[8, 16]])
    // A window clipped inside the session yields the clipped run.
    expect(coveredRuns(london, bars, 10, 12, HOUR)).toEqual([[10, 12]])
    expect(coveredRuns(london, bars, 18, 23, HOUR)).toEqual([])
  })
})

describe('SESSIONS template', () => {
  test('defaults to an 8% fill with the ribbon shown, on the price pane', () => {
    expect(sessions.name).toBe('SESSIONS')
    expect(sessions.series).toBe('price')
    expect(sessions.calcParams).toEqual([8, 1])
  })

  test('computes no values: one empty result per bar', () => {
    const bars: KLineData[] = [{ timestamp: 0, open: 1, high: 1, low: 1, close: 1 }, { timestamp: MIN, open: 1, high: 1, low: 1, close: 1 }]
    const indicator = { calcParams: [8, 1] } as unknown as Parameters<NonNullable<typeof sessions.calc>>[1]
    expect(sessions.calc?.(bars, indicator)).toEqual([{}, {}])
  })
})
