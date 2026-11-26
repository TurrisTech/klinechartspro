import { describe, expect, test } from 'bun:test'
import { describeQuiet, inWindow, parseHhmm, QuietWindow, ReplayQuiet, readQuiet } from './quiet'
import { fromWall, toWall } from './timeframes'

// Quiet hours: is an instant inside 22:00-06:00 on a clock. The window remembers how long its
// last answer holds, so these sweep it minute by minute against the plain wall-clock rule.

const NY = 'America/New_York'
const H = 3_600_000
const MIN = 60_000

/** The rule spelled out: the wall minute of `at`, inside [from, to). */
function plain(at: number, from: number, to: number, zone: string): boolean {
  const minute = Math.floor(toWall(at, zone) / MIN) % 1440
  return inWindow(minute, from, to)
}

describe('inWindow', () => {
  test('over midnight, within a day, and empty', () => {
    expect(inWindow(22 * 60, 22 * 60, 6 * 60)).toBe(true)
    expect(inWindow(23 * 60 + 59, 22 * 60, 6 * 60)).toBe(true)
    expect(inWindow(0, 22 * 60, 6 * 60)).toBe(true)
    expect(inWindow(6 * 60 - 1, 22 * 60, 6 * 60)).toBe(true)
    expect(inWindow(6 * 60, 22 * 60, 6 * 60)).toBe(false)
    expect(inWindow(12 * 60, 22 * 60, 6 * 60)).toBe(false)
    expect(inWindow(13 * 60, 12 * 60, 14 * 60)).toBe(true)
    expect(inWindow(14 * 60, 12 * 60, 14 * 60)).toBe(false)
    expect(inWindow(5, 600, 600)).toBe(false)
  })
})

describe('QuietWindow', () => {
  test('agrees with the wall clock at every minute of a week, across both DST changes', () => {
    for (const start of [Date.UTC(2024, 2, 7), Date.UTC(2024, 9, 31)]) {
      // 22:00-06:00 and a window ending inside the hour the clocks change (01:30).
      for (const [from, to] of [
        [22 * 60, 6 * 60],
        [23 * 60, 90]
      ]) {
        const window = new QuietWindow(from, to, NY)
        for (let at = start; at < start + 7 * 24 * H; at += MIN) {
          if (window.has(at) !== plain(at, from, to, NY)) throw new Error(`${new Date(at).toISOString()} ${from}-${to}`)
        }
      }
    }
  })

  test('asked out of order -- a bar, then one before it -- it still answers each', () => {
    const window = new QuietWindow(22 * 60, 6 * 60, NY)
    const night = fromWall(Date.UTC(2024, 2, 4, 23), NY)
    const day = fromWall(Date.UTC(2024, 2, 4, 12), NY)
    expect(window.has(night)).toBe(true)
    expect(window.has(day)).toBe(false)
    expect(window.has(night + 5_000)).toBe(true)
    expect(window.has(fromWall(Date.UTC(2024, 2, 5, 6), NY))).toBe(false)
    expect(window.has(fromWall(Date.UTC(2024, 2, 5, 6), NY) - 5_000)).toBe(true)
  })

  test('the same hours on another clock are other instants', () => {
    const utc = new QuietWindow(22 * 60, 6 * 60, 'UTC')
    const ny = new QuietWindow(22 * 60, 6 * 60, NY)
    // 23:00Z is 18:00 in New York (winter).
    const at = Date.UTC(2024, 0, 10, 23)
    expect(utc.has(at)).toBe(true)
    expect(ny.has(at)).toBe(false)
  })
})

describe('ReplayQuiet', () => {
  const memory = () => {
    const data = new Map<string, string>()
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
  }

  test('off silences nothing; on, the replay clock decides, and the setting is kept per browser', () => {
    const storage = memory()
    const zone = { now: NY }
    const quiet = new ReplayQuiet(() => zone.now, storage)
    const night = Date.UTC(2024, 0, 10, 5) // 00:00 New York, 05:00 UTC
    expect(quiet.value.on).toBe(false)
    expect(quiet.isQuiet(night)).toBe(false)
    let told = 0
    quiet.subscribe(() => told++)
    quiet.set({ ...quiet.value, on: true })
    expect(told).toBe(1)
    expect(quiet.isQuiet(night)).toBe(true)
    // The replay followed the chart to a UTC instrument: 05:00 there is quiet too, 07:00 is not.
    zone.now = 'UTC'
    expect(quiet.isQuiet(night)).toBe(true)
    expect(quiet.isQuiet(night + 2 * H)).toBe(false)
    expect(readQuiet(storage)).toEqual({ on: true, from: 22 * 60, to: 6 * 60, zone: 'replay' })
    expect(new ReplayQuiet(() => NY, storage).value.on).toBe(true)
  })

  test('a damaged setting reads as the default, off', () => {
    const storage = memory()
    storage.setItem('wd.replay.quiet', JSON.stringify({ on: true, from: 9999, to: 'six', zone: 'mars' }))
    expect(readQuiet(storage)).toEqual({ on: true, from: 22 * 60, to: 6 * 60, zone: 'replay' })
    storage.setItem('wd.replay.quiet', 'nope')
    expect(readQuiet(storage).on).toBe(false)
  })

  test('the hours read as a span', () => {
    expect(describeQuiet({ from: 22 * 60, to: 6 * 60 })).toBe('22:00–06:00')
    expect(parseHhmm('6:30')).toBe(390)
    expect(parseHhmm('22:00:00')).toBe(1320) // a time input's value with seconds
    expect(parseHhmm('22:00:59.5')).toBe(1320)
    expect(parseHhmm('24:00')).toBeNull()
    expect(parseHhmm('10:75')).toBeNull()
    expect(parseHhmm('22:00x')).toBeNull()
  })
})
