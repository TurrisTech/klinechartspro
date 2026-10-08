import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { decodeTile } from './decode'
import { LAYOUT_VERSION, type TileManifest } from './manifest'

// AN INTERVAL THE SERVER DOES NOT LIST AS TILED IS NEVER ASKED FOR ITS OWN TILES. Only the
// stored intervals have a tree (`baseIntervals` in /capabilities -- on prod oanda 5s 1m 1h 1D
// 1M, every other vendor likewise), so a 3m or 4h manifest is a certain 404: a round trip spent
// before the fold can start and a red console line, per series per page load. Measured on the
// prod wall, 2026-10-08: eight of them per instrument switch.
//
// Served over the committed XRPUSD monthly tile (see precision.test.ts) under the schedule
// fields prod's own coinbase manifest carries, so a quarter folds out of it. Each case uses its
// own symbol: the manifest cache is module-wide and keeps a 404 as well as a hit.

const TILE = `${import.meta.dir}/fixtures/coinbase-XRPUSD-1M-int64-volume.parquet`
const TILE_NAME = 'all-1bdf00cf.parquet'
const COINBASE = ['1m', '1h', '1D', '1M']

let barsFromTiles: typeof import('./index').barsFromTiles
let monthly: TileManifest
const requested: string[] = []
const originalFetch = globalThis.fetch
const hadWindow = 'window' in globalThis

function bytes(): ArrayBuffer {
  const b = readFileSync(TILE)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

/** Every manifest this test's symbols were asked for, as `<symbol>/<interval>`. */
function manifestsAsked(symbol: string): string[] {
  return requested.filter((path) => path.includes(`/${symbol}/`) && path.endsWith('/manifest.json')).map((path) => path.split('/').slice(-3, -1).join('/'))
}

beforeAll(async () => {
  const bars = await decodeTile(bytes(), 4)
  const from = bars[0].timestamp
  const to = bars[bars.length - 1].timestamp
  monthly = {
    vendor: 'coinbase',
    symbol: 'XRPUSD',
    interval: '1M',
    granularity: 'all',
    precision: 4,
    sessionDated: false,
    tz: 'UTC',
    schedule: 'continuous',
    day: { open: 0, close: 24, everyDay: true },
    coveredFrom: from,
    coveredTo: to + 1,
    tiles: [{ name: TILE_NAME, from, to, rows: bars.length, bytes: bytes().byteLength }]
  }
  if (!hadWindow) (globalThis as { window?: unknown }).window = { location: { origin: 'http://tiles.test' } }
  // Only the monthly tree exists, for any symbol; everything else is the 404 a bucket answers.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname
    requested.push(path)
    const match = new RegExp(`/${LAYOUT_VERSION}/coinbase/([^/]+)/1M/(.+)$`).exec(path)
    if (match?.[2] === 'manifest.json') return Response.json({ ...monthly, symbol: match[1] })
    if (match?.[2] === TILE_NAME) return new Response(bytes(), { status: 200 })
    return new Response('not found', { status: 404 })
  }) as typeof globalThis.fetch
  ;({ barsFromTiles } = await import('./index'))
})

afterAll(() => {
  // The exact function captured before stubbing -- see isolation.test.ts.
  globalThis.fetch = originalFetch
  if (!hadWindow) delete (globalThis as { window?: unknown }).window
})

describe('barsFromTiles asks only for the trees the server says exist', () => {
  test('an untiled interval goes straight to its source’s tiles', async () => {
    const quarters = await barsFromTiles('coinbase:XRPQ', '3M', monthly.coveredFrom, monthly.coveredTo, () => COINBASE)
    expect(manifestsAsked('XRPQ')).toEqual(['XRPQ/1M'])
    // Still answered, folded: every bar opens a calendar quarter.
    const bars = quarters?.bars ?? []
    expect(bars.length).toBeGreaterThan(15)
    for (const bar of bars) {
      const at = new Date(bar.timestamp)
      expect([at.getUTCMonth() % 3, at.getUTCDate(), at.getUTCHours()]).toEqual([0, 1, 0])
    }
  })

  test('a server that lists nothing is still asked, and the answer is the same', async () => {
    const listed = await barsFromTiles('coinbase:XRPL', '3M', monthly.coveredFrom, monthly.coveredTo, () => COINBASE)
    const unlisted = await barsFromTiles('coinbase:XRPN', '3M', monthly.coveredFrom, monthly.coveredTo, () => null)
    expect(manifestsAsked('XRPN')).toEqual(['XRPN/3M', 'XRPN/1M'])
    expect(unlisted).toEqual(listed)
  })

  test('a tiled interval reads its own tree and nothing else', async () => {
    const months = await barsFromTiles('coinbase:XRPM', '1M', monthly.coveredFrom, monthly.coveredTo, () => COINBASE)
    expect(manifestsAsked('XRPM')).toEqual(['XRPM/1M'])
    expect(months?.bars.length).toBe(62)
  })
})
