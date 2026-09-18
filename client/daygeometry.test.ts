import { describe, expect, test } from 'bun:test'

import { dayGeometryOf } from './daygeometry'

const session = (openDay: string, openTime: string, closeDay: string, closeTime: string) => ({
  openDay,
  openTime,
  closeDay,
  closeTime
})

// The three answers wmarkettypes' `day_geometry` gives for the schedules the store holds.
describe('dayGeometryOf', () => {
  test('forex: one Sunday-17:00-to-Friday-17:00 span', () => {
    const hours = { timezone: 'America/New_York', sessions: [session('sun', '17:00', 'fri', '17:00')] }
    expect(dayGeometryOf(hours)).toEqual({ openOffset: -7, closeOffset: 17, everyDayTrades: false })
  })

  test('crypto: a span covering the whole week', () => {
    const hours = { timezone: 'UTC', sessions: [session('mon', '00:00', 'mon', '00:00')] }
    expect(dayGeometryOf(hours)).toEqual({ openOffset: 0, closeOffset: 24, everyDayTrades: true })
  })

  test('US equities: five 09:30-16:00 days anchor on 09:00', () => {
    const days = ['mon', 'tue', 'wed', 'thu', 'fri']
    const hours = { timezone: 'America/New_York', sessions: days.map((d) => session(d, '09:30', d, '16:00')) }
    expect(dayGeometryOf(hours)).toEqual({ openOffset: 9, closeOffset: 16, everyDayTrades: false })
  })

  test('a close past the hour rounds up', () => {
    const hours = { timezone: 'America/New_York', sessions: [session('mon', '09:30', 'mon', '16:15')] }
    expect(dayGeometryOf(hours)?.closeOffset).toBe(17)
  })

  test('no schedule, no geometry', () => {
    expect(dayGeometryOf(undefined)).toBeNull()
    expect(dayGeometryOf({ timezone: 'UTC', sessions: [] })).toBeNull()
  })
})
