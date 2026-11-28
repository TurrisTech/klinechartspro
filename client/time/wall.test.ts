import { describe, expect, test } from 'bun:test'
import { zoneOffsetMinutes } from '../../src/indicators/sessions'
import { zoneReading } from '../../src/utils/wallclock'
import { toWall } from './timeframes'

// The app's wall clock (`toWall`, exact to the millisecond) and the library's zone offset
// (`zoneOffsetMinutes`, whole minutes resolved per quarter hour) read the zone through one
// function, src/utils/wallclock.ts. Each used to carry its own `Intl` reader; these hold both to
// what those readers returned, and the two to each other, on New York, UTC and Istanbul across
// every transition they have had.

const MINUTE = 60_000
const ZONES = ['America/New_York', 'UTC', 'Europe/Istanbul']

const offsetAt = (tz: string, ms: number): number => zoneReading(tz, ms) - (ms - (((ms % 1000) + 1000) % 1000))

/** Every instant a zone's offset changed in [from, to): a weekly scan, then a bisection to the
 * millisecond. */
function transitions(tz: string, from: number, to: number): number[] {
  const out: number[] = []
  const WEEK = 7 * 86_400_000
  for (let t = from; t < to; t += WEEK) {
    if (offsetAt(tz, t) === offsetAt(tz, t + WEEK)) continue
    let lo = t
    let hi = t + WEEK
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (offsetAt(tz, mid) === offsetAt(tz, lo)) lo = mid
      else hi = mid
    }
    out.push(hi)
  }
  return out
}

/** The instants swept: every 7.5 minutes (and a second and a millisecond either side of that)
 * for an hour either side of each transition, and every eleven days or so across the rest. */
function sweep(tz: string, from: number, to: number): number[] {
  const out: number[] = []
  for (const at of transitions(tz, from, to)) {
    for (let k = -8; k <= 8; k++) out.push(at + k * 7.5 * MINUTE, at + k * 7.5 * MINUTE + 1_234, at + k * 7.5 * MINUTE - 1)
  }
  for (let t = from; t < to; t += 11 * 86_400_000 + 3_723_457) out.push(t)
  return out
}

const SINCE_1910 = Date.UTC(1910, 9, 2)
const UNTIL = Date.UTC(2040, 0, 1)
const SINCE_1850 = Date.UTC(1850, 0, 1)

// -- as they were at f0b1a1d ------------------------------------------------------------------

const clientFormatters = new Map<string, Intl.DateTimeFormat>()
function toWallBefore(ms: number, tz: string): number {
  let f = clientFormatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    clientFormatters.set(tz, f)
  }
  const parts = f.formatToParts(new Date(ms))
  let y = 0
  let mo = 0
  let d = 0
  let h = 0
  let mi = 0
  let s = 0
  for (const p of parts) {
    if (p.type === 'year') y = Number(p.value)
    else if (p.type === 'month') mo = Number(p.value)
    else if (p.type === 'day') d = Number(p.value)
    else if (p.type === 'hour') h = Number(p.value)
    else if (p.type === 'minute') mi = Number(p.value)
    else if (p.type === 'second') s = Number(p.value)
  }
  const sub = ((ms % 1000) + 1000) % 1000
  return Date.UTC(y, mo - 1, d, h, mi, s) + sub
}

const libraryFormatters = new Map<string, Intl.DateTimeFormat>()
function zoneOffsetMinutesBefore(timezone: string, ms: number): number {
  let formatter = libraryFormatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    libraryFormatters.set(timezone, formatter)
  }
  const at = Math.floor(ms / (15 * MINUTE)) * 15 * MINUTE
  const parts = formatter.formatToParts(new Date(at))
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour') % 24, part('minute'), part('second'))
  return Math.round((asUtc - at) / MINUTE)
}

describe('one wall-clock reader for the app and the library', () => {
  for (const tz of ZONES) {
    const instants = sweep(tz, SINCE_1850, UNTIL)

    test(`${tz}: each reads what it read before, at every instant since 1850`, () => {
      expect(instants.length).toBeGreaterThan(5_000)
      for (const ms of instants) {
        expect([ms, toWall(ms, tz)]).toEqual([ms, toWallBefore(ms, tz)])
        expect([ms, zoneOffsetMinutes(tz, ms)]).toEqual([ms, zoneOffsetMinutesBefore(tz, ms)])
      }
    })

    test(`${tz}: the two agree at every instant since 1910`, () => {
      for (const ms of instants.filter((at) => at >= SINCE_1910)) expect([ms, ms + zoneOffsetMinutes(tz, ms) * MINUTE]).toEqual([ms, toWall(ms, tz)])
    })
  }

  test('before that they part by the seconds of a local mean time, which only the app keeps', () => {
    // Istanbul's mean time was UTC+1:56:56, New York's UTC-4:56:02 until November 1883.
    const istanbul = Date.UTC(1900, 0, 1, 12)
    expect(toWall(istanbul, 'Europe/Istanbul') - istanbul).toBe(116 * MINUTE + 56_000)
    expect(zoneOffsetMinutes('Europe/Istanbul', istanbul)).toBe(117)
    const newYork = Date.UTC(1880, 0, 1, 12)
    expect(toWall(newYork, 'America/New_York') - newYork).toBe(-(296 * MINUTE + 2_000))
    expect(zoneOffsetMinutes('America/New_York', newYork)).toBe(-296)
  })
})
