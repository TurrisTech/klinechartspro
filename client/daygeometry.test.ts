import { describe, expect, test } from 'bun:test'

import { dayGeometryOf, tradingWeekOf } from './daygeometry'

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

// wmarkettypes' `trading_hours`: the schedule's `trading` block where it has one, its own sessions
// otherwise -- never the grid's geometry, which floors a 09:30 open to 09:00.
describe('tradingWeekOf', () => {
  const fxGrid = [session('sun', '17:00', 'fri', '17:00')]

  test('a US equity trades its own sessions: 09:30, not the 09:00 its grid anchors on', () => {
    const days = ['mon', 'tue', 'wed', 'thu', 'fri']
    const hours = { timezone: 'America/New_York', sessions: days.map((d) => session(d, '09:30', d, '16:00')), trading: null }
    expect(tradingWeekOf(hours)).toEqual({ timezone: 'America/New_York', sessions: hours.sessions })
  })

  test('a lira cross trades its `trading` block, on its own clock', () => {
    const trading = { timezone: 'Europe/Istanbul', sessions: [session('mon', '09:00', 'mon', '18:00')] }
    expect(tradingWeekOf({ timezone: 'America/New_York', sessions: fxGrid, trading })).toEqual(trading)
    // The grid is still the FX week: the two questions have two answers.
    expect(dayGeometryOf({ timezone: 'America/New_York', sessions: fxGrid, trading })).toEqual({ openOffset: -7, closeOffset: 17, everyDayTrades: false })
  })

  test('no schedule, or one this port cannot read, is no trading week -- never a guess', () => {
    expect(tradingWeekOf(undefined)).toBeNull()
    expect(tradingWeekOf({ timezone: 'UTC', sessions: [] })).toBeNull()
    expect(tradingWeekOf({ timezone: 'UTC', sessions: [session('monday', '00:00', 'mon', '00:00')] })).toBeNull()
    expect(tradingWeekOf({ timezone: 'America/New_York', sessions: fxGrid, trading: { timezone: 'UTC', sessions: [] } })).toBeNull()
  })
})
