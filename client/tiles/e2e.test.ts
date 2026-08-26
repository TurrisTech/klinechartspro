import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'

// End-to-end over the real tiles bin/build_chart_tiles.py wrote: manifest -> fetch -> decode
// -> KLineData, through the same code the browser runs. The positive half of the contract;
// manifest.test.ts pins where tiles stop and parity.test.ts pins that the join is exact.
//
// Skipped when no tile store is present, so a checkout without /mnt/d still runs green.

const ROOT = process.env.TILES_ROOT ?? '/mnt/d/marketdata/tiles'
const ready = existsSync(`${ROOT}/v1/oanda/EURUSD/1m/manifest.json`)

let barsFromTiles: typeof import('./index').barsFromTiles
let realFetch: typeof globalThis.fetch

// Narrows away the null that means "tiles cannot answer this", so assertions read as plain
// values rather than non-null assertions.
function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}, got ${value}`)
  return value
}

beforeAll(async () => {
  // The modules read window.location on first use and fetch over HTTP; both are stubbed to
  // the local tile directory so this needs no server.
  ;(globalThis as { window?: unknown }).window = { location: { origin: 'http://tiles.test' } }
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    const file = Bun.file(`${ROOT}${new URL(url).pathname.replace(/^\/tiles/, '')}`)
    if (!(await file.exists())) return new Response('no such tile', { status: 404 })
    return new Response(await file.arrayBuffer(), { status: 200 })
  }) as typeof globalThis.fetch
  ;({ barsFromTiles } = await import('./index'))
})

afterAll(() => {
  globalThis.fetch = realFetch
})

describe.skipIf(!ready)('barsFromTiles over the real tile store', () => {
  test('serves a historical 1m window with correctly unscaled prices', async () => {
    const from = Date.UTC(2024, 2, 4, 0, 0)
    const to = Date.UTC(2024, 2, 4, 8, 0)
    const { bars } = present(await barsFromTiles('oanda:EURUSD', '1m', from, to), 'tiled bars')
    expect(bars.length).toBeGreaterThan(400)

    // In the window, ordered, with sane OHLC relationships and a price magnitude only a
    // correct 1e5 unscaling produces.
    expect(bars.every((b) => b.timestamp >= from && b.timestamp < to)).toBe(true)
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].timestamp).toBeGreaterThan(bars[i - 1].timestamp)
    }
    for (const b of bars) {
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close))
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close))
      expect(b.open).toBeGreaterThan(0.5)
      expect(b.open).toBeLessThan(2)
    }
  })

  test('unscales a 3-decimal instrument by its own precision, not a global one', async () => {
    const { bars } = present(
      await barsFromTiles('oanda:USDJPY', '1m', Date.UTC(2024, 2, 4, 0), Date.UTC(2024, 2, 4, 4)),
      'tiled bars'
    )
    // ~150, not ~0.0015 (1e5) and not ~150000 (unscaled).
    expect(bars[0].open).toBeGreaterThan(80)
    expect(bars[0].open).toBeLessThan(300)
  })

  test('joins consecutive tiles across a month boundary without a gap or duplicate', async () => {
    const { bars } = present(
      await barsFromTiles('oanda:EURUSD', '1m', Date.UTC(2024, 1, 29, 20), Date.UTC(2024, 2, 1, 4)),
      'tiled bars'
    )
    expect(new Set(bars.map((b) => b.timestamp)).size).toBe(bars.length)
    expect(bars.some((b) => b.timestamp < Date.UTC(2024, 2, 1))).toBe(true)
    expect(bars.some((b) => b.timestamp >= Date.UTC(2024, 2, 1))).toBe(true)
  })

  test('reports where tiles stop so the caller can fetch the rest', async () => {
    const now = Date.now()
    const tiled = await barsFromTiles('oanda:EURUSD', '1m', now - 30 * 86_400_000, now)
    // A window reaching the live edge is answered in part, not refused: tiles carry the
    // closed periods and coveredTo says where /getbars must pick up.
    const { bars, coveredTo } = present(tiled, 'a partial tiled answer')
    expect(bars.length).toBeGreaterThan(0)
    expect(coveredTo).toBeLessThanOrEqual(now)
    expect(Math.max(...bars.map((b) => b.timestamp))).toBeLessThan(coveredTo)
  })

  test('contributes nothing when the window is entirely in the forming period', async () => {
    const now = Date.now()
    expect(await barsFromTiles('oanda:EURUSD', '1m', now - 500 * 60_000, now)).toBeNull()
  })

  test('returns null for an interval that has no tiles', async () => {
    expect(await barsFromTiles('oanda:EURUSD', '15', Date.UTC(2024, 2, 4), Date.UTC(2024, 2, 5))).toBeNull()
  })
})
