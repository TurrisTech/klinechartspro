import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { LAYOUT_VERSION, type TileManifest } from './manifest'
import type { MarketHours } from '../symbols'

// A FOLD OF INTRADAY TILES ASKS WHICH ROWS COUNT, AND DECLINES WITHOUT AN ANSWER. The manifest
// carries the grid (`day`) and not the trading week, so `barsFromTiles` asks `/instrument` for it
// (`hours`) before folding an intraday source -- and only then: a daily source keeps the boundary
// rule and needs nothing. With no answer the fold is refused (null: `/getbars` answers the whole
// window) rather than run on the grid, which is what put schwab's pre-market into every bar
// folded across 09:00. The tile itself 404s here: what is asserted is which requests are made.

const SCHWAB = ['1m', '30m', '1D']
const requested: string[] = []
const originalFetch = globalThis.fetch
const hadWindow = 'window' in globalThis
let barsFromTiles: typeof import('./index').barsFromTiles

const FROM = Date.UTC(2026, 9, 19, 4)
const TO = Date.UTC(2026, 9, 24, 4)

function manifest(symbol: string, interval: string): TileManifest {
  return {
    vendor: 'schwab',
    symbol,
    interval,
    granularity: 'month',
    precision: 2,
    sessionDated: interval === '1D',
    tz: 'America/New_York',
    schedule: 'session',
    day: { open: 9, close: 16, everyDay: false },
    coveredFrom: FROM,
    coveredTo: TO,
    tiles: [{ name: 'm.parquet', from: FROM, to: TO - 1, rows: 1, bytes: 1 }]
  }
}

const SPY_HOURS: MarketHours = {
  timezone: 'America/New_York',
  sessions: ['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => ({ openDay: d, openTime: '09:30', closeDay: d, closeTime: '16:00' })),
  trading: null
}

const tilesAsked = (symbol: string): string[] => requested.filter((p) => p.includes(`/${symbol}/`) && p.endsWith('.parquet'))

beforeAll(async () => {
  if (!hadWindow) (globalThis as { window?: unknown }).window = { location: { origin: 'http://tiles.test' } }
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname
    requested.push(path)
    const match = new RegExp(`/${LAYOUT_VERSION}/schwab/([^/]+)/([^/]+)/manifest.json$`).exec(path)
    if (match) return Response.json(manifest(match[1], match[2]))
    return new Response('not found', { status: 404 })
  }) as typeof globalThis.fetch
  ;({ barsFromTiles } = await import('./index'))
})

afterAll(() => {
  globalThis.fetch = originalFetch
  if (!hadWindow) delete (globalThis as { window?: unknown }).window
})

describe('a fold of intraday tiles reads the trading week', () => {
  test('without one it declines before reading a tile', async () => {
    const asked: string[] = []
    const answer = await barsFromTiles('schwab:NOWEEK', '1h', FROM, TO, () => SCHWAB, async (vs) => {
      asked.push(vs)
      return null
    })
    expect(answer).toBeNull()
    expect(asked).toEqual(['schwab:NOWEEK'])
    expect(tilesAsked('NOWEEK')).toEqual([])
  })

  test('with one it goes on to the tiles', async () => {
    const asked: string[] = []
    await barsFromTiles('schwab:WEEK', '1h', FROM, TO, () => SCHWAB, async (vs) => {
      asked.push(vs)
      return SPY_HOURS
    })
    expect(asked).toEqual(['schwab:WEEK'])
    expect(tilesAsked('WEEK').length).toBeGreaterThan(0)
  })

  test('a fold of daily tiles does not ask', async () => {
    const asked: string[] = []
    await barsFromTiles('schwab:DAILY', '1W', FROM, TO, () => SCHWAB, async (vs) => {
      asked.push(vs)
      return null
    })
    expect(asked).toEqual([])
    expect(tilesAsked('DAILY').length).toBeGreaterThan(0)
  })
})
