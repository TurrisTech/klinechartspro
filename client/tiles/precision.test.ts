import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { decodeTile } from './decode'
import { LAYOUT_VERSION, type TileManifest } from './manifest'

// A TILE'S PRICES ARE UNSCALED BY ITS OWN MANIFEST'S PRECISION, through the whole read path:
// manifest -> tile fetch -> decode -> KLineData, the same `barsFromTiles` the chart calls.
//
// A tile holds integers scaled by 10**precision and nothing that says what the power was, so
// the manifest is the only place the scale can come from -- a reader that fell back to a
// global (oanda's 5) would draw a 3-decimal yen cross at a thousandth of its price and a
// 4-decimal crypto at a tenth, with nothing on the chart to say so.
//
// This was the job of e2e.test.ts's USDJPY case, which reads the workstation's tile store and
// so only ran when that store happened to hold USDJPY under the current layout -- it did not
// (2026-09-15), and the case failed instead of skipping. Here the same claim is pinned over the
// committed XRPUSD fixture (a real published tile, see int64volume.test.ts), served under two
// manifests that differ ONLY in precision. The bars must differ by exactly that power of ten,
// and match the vendor's price under the true one.

const TILE = `${import.meta.dir}/fixtures/coinbase-XRPUSD-1M-int64-volume.parquet`
const TILE_NAME = 'all-1bdf00cf.parquet'

let barsFromTiles: typeof import('./index').barsFromTiles
let manifests: Map<string, TileManifest>
const originalFetch = globalThis.fetch
const hadWindow = 'window' in globalThis

function bytes(): ArrayBuffer {
  const b = readFileSync(TILE)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

/** A manifest for the fixture tile under `symbol`, claiming `precision`. Its coverage is the
 * tile's own first and last bar, so the tile is the whole answer for any window inside it. */
async function manifest(symbol: string, precision: number): Promise<TileManifest> {
  const bars = await decodeTile(bytes(), precision)
  const from = bars[0].timestamp
  const to = bars[bars.length - 1].timestamp
  return {
    vendor: 'coinbase',
    symbol,
    interval: '1M',
    granularity: 'all',
    precision,
    sessionDated: false,
    coveredFrom: from,
    coveredTo: to + 1,
    tiles: [{ name: TILE_NAME, from, to, rows: bars.length, bytes: bytes().byteLength }]
  }
}

beforeAll(async () => {
  // XRPUSD's true precision is 4 (its manifest's, not coinbase's display precision of 2).
  // XRPUSD5 is the same bytes under a manifest that claims 5.
  manifests = new Map([
    ['XRPUSD', await manifest('XRPUSD', 4)],
    ['XRPUSD5', await manifest('XRPUSD5', 5)]
  ])
  if (!hadWindow) (globalThis as { window?: unknown }).window = { location: { origin: 'http://tiles.test' } }
  // Serves `<layout>/coinbase/<symbol>/1M/manifest.json` from the map and the tile from the
  // fixture, whatever origin the module resolved its base URL to.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname
    const match = new RegExp(`/${LAYOUT_VERSION}/coinbase/([^/]+)/1M/(.+)$`).exec(path)
    const found = match ? manifests.get(match[1]) : undefined
    if (!match || !found) return new Response('not found', { status: 404 })
    if (match[2] === 'manifest.json') return Response.json(found)
    if (match[2] === TILE_NAME) return new Response(bytes(), { status: 200 })
    return new Response('not found', { status: 404 })
  }) as typeof globalThis.fetch
  ;({ barsFromTiles } = await import('./index'))
})

afterAll(() => {
  // The exact function captured before stubbing -- see isolation.test.ts for why neither
  // `Bun.fetch` nor "whatever was installed on entry" will do.
  globalThis.fetch = originalFetch
  if (!hadWindow) delete (globalThis as { window?: unknown }).window
})

describe('barsFromTiles unscales by the manifest’s precision', () => {
  const window = (m: TileManifest): [number, number] => [m.coveredFrom, m.coveredTo]

  test('under the true precision the prices are the vendor’s', async () => {
    const m = manifests.get('XRPUSD') as TileManifest
    const tiled = await barsFromTiles('coinbase:XRPUSD', '1M', ...window(m))
    expect(tiled).not.toBeNull()
    const bars = tiled?.bars ?? []
    expect(bars.length).toBe(62)
    const december2020 = bars.find((b) => new Date(b.timestamp).toISOString().startsWith('2020-12'))
    // The same figure int64volume.test.ts reads straight off decodeTile: the read path adds
    // nothing and loses nothing.
    expect(december2020?.open).toBeCloseTo(0.6649, 4)
    expect(bars[0].open).toBeCloseTo(0.338, 4)
  })

  test('the same bytes under a manifest claiming another precision come back scaled by it', async () => {
    const four = await barsFromTiles('coinbase:XRPUSD', '1M', ...window(manifests.get('XRPUSD') as TileManifest))
    const five = await barsFromTiles('coinbase:XRPUSD5', '1M', ...window(manifests.get('XRPUSD5') as TileManifest))
    const a = four?.bars ?? []
    const b = five?.bars ?? []
    expect(b.length).toBe(a.length)
    expect(a.length).toBeGreaterThan(0)
    // Exactly one power of ten apart on every price, and untouched on what is not a price.
    for (let i = 0; i < a.length; i++) {
      expect(b[i].timestamp).toBe(a[i].timestamp)
      expect(b[i].open * 10).toBeCloseTo(a[i].open, 9)
      expect(b[i].high * 10).toBeCloseTo(a[i].high, 9)
      expect(b[i].low * 10).toBeCloseTo(a[i].low, 9)
      expect(b[i].close * 10).toBeCloseTo(a[i].close, 9)
      expect(b[i].volume).toBe(a[i].volume)
    }
  })
})
