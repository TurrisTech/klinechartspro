import { afterAll, describe, expect, test } from 'bun:test'

// A plugin's own bars under a bar replay: only what the replay has seen close. The tiles are
// read straight from the bucket, so nothing on the server clamps them to the cursor; a bar
// forming at the cursor used to come back whole -- its final high, low and close -- and a
// window past the cursor read the future.

const hadWindow = 'window' in globalThis
;(globalThis as Record<string, unknown>).window = {
  location: { href: 'http://localhost/', origin: 'http://localhost' }
}
const pristineFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = pristineFetch
  if (!hadWindow) delete (globalThis as Record<string, unknown>).window
})

const H = 3_600_000
// Wednesday 2026-09-23, New York on EDT (UTC-4).
const nyHour = (day: number, hour: number) => Date.UTC(2026, 8, day, hour + 4)
const HOURLY = [6, 7, 8, 9, 10, 11, 12].map((hour) => nyHour(23, hour))
// Daily bars are dated by session: 00:00 New York of the session's date.
const DAILY = [21, 22, 23, 24].map((day) => nyHour(day, 0))

// No tiles; the instrument trades the FX week; /getbars hands back whatever the window holds,
// as the tiles do, whatever the clock.
globalThis.fetch = (async (input: URL | RequestInfo) => {
  const url = input instanceof URL ? input : new URL(String(input))
  if (url.pathname.endsWith('/instrument')) {
    const sessions = [{ openDay: 'sun', openTime: '17:00', closeDay: 'fri', closeTime: '17:00' }]
    return Response.json({ vendor: 'oanda', symbol: 'ZZZBARS', marketHours: { timezone: 'America/New_York', sessions } })
  }
  if (!url.pathname.endsWith('/getbars')) return new Response('not found', { status: 404 })
  const from = Number(url.searchParams.get('from'))
  const to = Number(url.searchParams.get('to'))
  const dates = url.searchParams.get('resolution') === '1D' ? DAILY : HOURLY
  const inside = dates.filter((date) => date >= from && date < to)
  return Response.json(inside.length === 0 ? { s: 'no_data' } : inside.map((date) => ({ date, open: 1, high: 1, low: 1, close: 1, volume: 1 })))
}) as typeof fetch

const { setReadClock } = await import('../config')
const { closedBarPage, closedBy, fetchClosedBars } = await import('./bars')
const { FX_DAY, gridFor } = await import('../replay/timeframes')

describe('fetchClosedBars', () => {
  test('live, everything fetchBars returns', async () => {
    setReadClock(null)
    const bars = await fetchClosedBars('oanda:ZZZBARS', '1h', HOURLY[0], HOURLY.at(-1) as number + H)
    expect(bars.map((bar) => bar.timestamp)).toEqual(HOURLY)
  })

  test('under a replay, only the bars closed by the cursor: not the one forming at it', async () => {
    setReadClock(nyHour(23, 10) + 15 * 60_000)
    try {
      const hourly = await fetchClosedBars('oanda:ZZZBARS', '1h', HOURLY[0], HOURLY.at(-1) as number + H)
      expect(hourly.map((bar) => bar.timestamp)).toEqual([6, 7, 8, 9].map((hour) => nyHour(23, hour)))
      // Wednesday's session opened Tuesday 17:00 and is forming at the cursor.
      const daily = await fetchClosedBars('oanda:ZZZBARS', '1D', DAILY[0], DAILY.at(-1) as number + 1)
      expect(daily.map((bar) => bar.timestamp)).toEqual([nyHour(21, 0), nyHour(22, 0)])
    } finally {
      setReadClock(null)
    }
  })

  test('a page is bounded in nominal bars and says where the next starts', async () => {
    const page = await closedBarPage('oanda:ZZZBARS', '1h', { from: HOURLY[0], to: HOURLY[0] + 5000 * H })
    expect(page.nextFrom).toBe(HOURLY[0] + 4000 * H)
    expect(page.bars).toHaveLength(HOURLY.length)
  })
})

describe('closedBy', () => {
  const fx = gridFor({ timezone: 'America/New_York', dayGeometry: FX_DAY })
  test('an intraday bar is in once it has closed, with or without a schedule', () => {
    expect(closedBy('1m', 0, 60_000, null)).toBe(true)
    expect(closedBy('1m', 0, 59_999, null)).toBe(false)
    const open = Date.UTC(2026, 8, 16, 14)
    expect(closedBy('1h', open, open + H, fx)).toBe(true)
    expect(closedBy('1h', open, open + H - 1, fx)).toBe(false)
  })

  test('a daily bar is in once the session forming at the clock is a later one', () => {
    // Wednesday 2026-09-16 12:00 New York (16:00Z): Wednesday's session is forming, Tuesday's
    // has closed. Wire dates are the sessions' New York midnights. Without a schedule a
    // session-dated bar cannot be placed, and none is admitted.
    const clock = Date.UTC(2026, 8, 16, 16)
    const tuesday = Date.UTC(2026, 8, 15, 4)
    const wednesday = Date.UTC(2026, 8, 16, 4)
    expect(closedBy('1D', tuesday, clock, fx)).toBe(true)
    expect(closedBy('1D', wednesday, clock, fx)).toBe(false)
    expect(closedBy('1D', tuesday, clock, null)).toBe(false)
  })
})
