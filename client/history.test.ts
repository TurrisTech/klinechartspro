import { afterAll, describe, expect, test } from 'bun:test'

// `window` does not exist under bun, and client/config.ts reads it at MODULE LOAD. Installed
// before the dynamic import, as client/layout.test.ts does.
const hadWindow = 'window' in globalThis
;(globalThis as Record<string, unknown>).window = {
  location: { href: 'http://localhost/', origin: 'http://localhost' }
}

// Captured so afterAll restores exactly what was here (see client/levels/levels.test.ts).
const pristineFetch = globalThis.fetch

const FIVE_S = 5_000
// The last hour before the FX week closes: Friday 2026-09-25 16:00-17:00 New York.
const FRIDAY_CLOSE = Date.UTC(2026, 8, 25, 21, 0)
const LAST_HOUR = Array.from({ length: 720 }, (_, i) => FRIDAY_CLOSE - 3_600_000 + i * FIVE_S)
// Sunday's open, 48 hours later.
const SUNDAY_OPEN = FRIDAY_CLOSE + 48 * 3_600_000

const getbars: URL[] = []

// No tiles and no instrument config (both 404), so every window goes to /getbars, which
// holds one hour of 5s bars ending at the Friday close and nothing after it.
globalThis.fetch = (async (input: URL | RequestInfo) => {
  const url = input instanceof URL ? input : new URL(String(input))
  if (!url.pathname.endsWith('/getbars')) return new Response('not found', { status: 404 })
  getbars.push(url)
  const from = Number(url.searchParams.get('from'))
  const to = Number(url.searchParams.get('to'))
  const limit = Number(url.searchParams.get('limit') ?? Number.POSITIVE_INFINITY)
  const inside = LAST_HOUR.filter((t) => t >= from && t < to).slice(-limit)
  const body =
    inside.length === 0
      ? { s: 'no_data' }
      : inside.map((date) => ({ date, open: 1, high: 1, low: 1, close: 1, volume: 1 }))
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}) as typeof fetch

const { fetchBarsWidened } = await import('./history')

afterAll(() => {
  globalThis.fetch = pristineFetch
  if (!hadWindow) delete (globalThis as Record<string, unknown>).window
})

describe('fetchBarsWidened at 5s', () => {
  test('a window opened at the Sunday open reaches back across the 48h weekend', async () => {
    // 500 bars of 5s is ~42 minutes; 64x that is ~44h, short of the weekend. The one-week
    // reach floor is what finds Friday's bars instead of reporting history exhausted.
    getbars.length = 0
    const bars = await fetchBarsWidened(
      'oanda:EURUSD',
      '5s',
      SUNDAY_OPEN - 500 * FIVE_S,
      SUNDAY_OPEN,
      500
    )
    expect(bars.length).toBe(500)
    expect(bars.at(-1)?.timestamp).toBe(FRIDAY_CLOSE - FIVE_S)
    expect(getbars.length).toBe(8)
  })

  test('paging forward from Friday crosses the weekend the same way', async () => {
    getbars.length = 0
    const from = FRIDAY_CLOSE + FIVE_S
    const bars = await fetchBarsWidened('oanda:EURUSD', '5s', from, from + 500 * FIVE_S, null, 'newer')
    // Nothing after the close in this fixture: the reach floor makes it look a full week
    // ahead before it gives up, instead of stopping ~44h in.
    expect(bars).toEqual([])
    const last = getbars.at(-1)
    expect(Number(last?.searchParams.get('to')) - from).toBeGreaterThanOrEqual(7 * 86_400_000)
  })
})
