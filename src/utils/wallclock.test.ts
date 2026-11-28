import { describe, expect, test } from 'bun:test'

import { zoneReading } from './wallclock'

const H = 3_600_000

describe('zoneReading', () => {
  test('is what the zone clock reads, as a UTC instant, to the second', () => {
    const at = Date.UTC(2024, 6, 1, 12, 34, 56, 789)
    expect(zoneReading('UTC', at)).toBe(Date.UTC(2024, 6, 1, 12, 34, 56))
    expect(zoneReading('America/New_York', at)).toBe(Date.UTC(2024, 6, 1, 8, 34, 56))
    expect(zoneReading('Europe/Istanbul', at)).toBe(Date.UTC(2024, 6, 1, 15, 34, 56))
  })

  test('follows a zone across its transitions', () => {
    // New York springs forward at 02:00 EST on 10 March 2024 (07:00Z) and falls back at 02:00
    // EDT on 3 November (06:00Z): the offset either side, a second apart.
    const spring = Date.UTC(2024, 2, 10, 7)
    expect(zoneReading('America/New_York', spring - 1000) - (spring - 1000)).toBe(-5 * H)
    expect(zoneReading('America/New_York', spring) - spring).toBe(-4 * H)
    const fall = Date.UTC(2024, 10, 3, 6)
    expect(zoneReading('America/New_York', fall - 1000) - (fall - 1000)).toBe(-4 * H)
    expect(zoneReading('America/New_York', fall) - fall).toBe(-5 * H)
  })

  test('midnight reads as hour 0 of the day, never 24 of the one before', () => {
    expect(zoneReading('UTC', Date.UTC(2024, 0, 2))).toBe(Date.UTC(2024, 0, 2))
    expect(zoneReading('America/New_York', Date.UTC(2024, 0, 2, 5))).toBe(Date.UTC(2024, 0, 2))
  })

  test('keeps a local mean time to the second', () => {
    // Istanbul kept its mean time, UTC+1:56:56, until October 1910.
    const at = Date.UTC(1900, 0, 1, 12)
    expect(zoneReading('Europe/Istanbul', at) - at).toBe(H + 56 * 60_000 + 56_000)
  })
})
