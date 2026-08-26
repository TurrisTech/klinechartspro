import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import type { KLineData } from 'klinecharts'

// The contract this whole layer has to hold: for any window, tiles-plus-API must return
// exactly what /getbars alone would have returned. Not a superset, not a prefix — the same
// bars, so a gap in the result is only ever a gap in the market.
//
// This is the check the cheaper ones cannot make. Asserting that every API bar appears in
// the tiles passes happily while the tiles carry an extra bar at the window edge, which is
// precisely the bug that /getbars' exclusive `to` bound produced here.
//
// Needs the dev stack (bin/dev-stack.sh) and a built tile store; skipped without either.

const ROOT = process.env.TILES_ROOT ?? '/mnt/d/marketdata/tiles'
const API = `http://localhost:${process.env.PORT0 ?? 25998}/ohlcv`
const FIELDS = ['timestamp', 'open', 'high', 'low', 'close', 'volume'] as const

let barsFromTiles: typeof import('./index').barsFromTiles
const realFetch = globalThis.fetch

// Probed at module load, not in beforeAll: `test.skipIf` is evaluated while the file is
// being collected, so a flag set later is always still false and every case silently skips.
const ready = existsSync(`${ROOT}/v1/oanda/EURUSD/1m/manifest.json`)
const serverUp = await realFetch(`${API}/capabilities`).then((r) => r.ok).catch(() => false)
if (ready && !serverUp) console.warn(`parity.test: no server at ${API}; skipping`)

async function getbars(symbol: string, resolution: string, from: number, to: number) {
  const url = `${API}/getbars?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${to}`
  const body = await (await realFetch(url)).json()
  if (!Array.isArray(body)) return [] as KLineData[]
  return body.map((b: Record<string, number>) => ({
    timestamp: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume
  })) as KLineData[]
}

/** What fetchBars does: tiles for the closed part, API for the forming part, joined. */
async function tiledThenApi(symbol: string, resolution: string, from: number, to: number) {
  const tiled = await barsFromTiles(symbol, resolution, from, to)
  if (tiled === null) return { bars: await getbars(symbol, resolution, from, to), tiles: 0 }
  if (tiled.coveredTo > to) return { bars: tiled.bars, tiles: tiled.bars.length }
  const tail = await getbars(symbol, resolution, tiled.coveredTo, to)
  return { bars: tiled.bars.concat(tail), tiles: tiled.bars.length }
}

beforeAll(async () => {
  ;(globalThis as { window?: unknown }).window = { location: { origin: 'http://tiles.test' } }
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (!url.includes('/tiles/')) return realFetch(input as Parameters<typeof fetch>[0])
    const file = Bun.file(`${ROOT}${new URL(url).pathname.replace(/^\/tiles/, '')}`)
    if (!(await file.exists())) return new Response('no such tile', { status: 404 })
    return new Response(await file.arrayBuffer(), { status: 200 })
  }) as typeof globalThis.fetch
  ;({ barsFromTiles } = await import('./index'))
})

afterAll(() => {
  globalThis.fetch = realFetch
})


describe.skipIf(!ready || !serverUp)('tiles + API == /getbars', () => {
  const cases: Array<[string, string, string, number, number]> = [
    ['wholly historical', 'oanda:EURUSD', '1m', Date.UTC(2026, 6, 20), Date.UTC(2026, 6, 22)],
    ['straddles the 1m month seam', 'oanda:EURUSD', '1m', Date.UTC(2026, 6, 30), Date.UTC(2026, 7, 2)],
    ['straddles, 3-decimal instrument', 'oanda:USDJPY', '1m', Date.UTC(2026, 6, 31), Date.UTC(2026, 7, 3)],
    ['spans a weekend', 'oanda:EURUSD', '1m', Date.UTC(2026, 6, 17, 12), Date.UTC(2026, 6, 20, 12)],
    ['straddles the 1h 5-year seam', 'oanda:EURUSD', '1h', Date.UTC(2024, 11, 30), Date.UTC(2025, 0, 3)],
    ['session-dated interval', 'oanda:EURUSD', '1D', Date.UTC(2024, 0, 1), Date.UTC(2024, 2, 1)],
    ['5s, one day', 'oanda:GBPUSD', '5s', Date.UTC(2024, 2, 4), Date.UTC(2024, 2, 4, 6)],
  ]

  for (const [label, symbol, resolution, from, to] of cases) {
    test(label, async () => {
      const expected = await getbars(symbol, resolution, from, to)
      const { bars } = await tiledThenApi(symbol, resolution, from, to)
      expect(bars.length).toBe(expected.length)
      for (let i = 0; i < expected.length; i++) {
        // `volume` is optional on KLineData. Compare presence first so a value missing on
        // one side only fails loudly instead of being coerced to a match.
        for (const f of FIELDS) {
          const got = bars[i][f]
          const want = expected[i][f]
          expect(got === undefined).toBe(want === undefined)
          if (got !== undefined && want !== undefined) expect(got).toBeCloseTo(want, 10)
        }
      }
      // A join that overlapped would duplicate bars rather than lose them, and a duplicate
      // renders as a spurious candle rather than an obvious hole.
      expect(new Set(bars.map((b) => b.timestamp)).size).toBe(bars.length)
    })
  }

  test('the weekend gap is a real gap, present in both', async () => {
    const from = Date.UTC(2026, 6, 17, 12)
    const to = Date.UTC(2026, 6, 20, 12)
    const expected = await getbars('oanda:EURUSD', '1m', from, to)
    const { bars } = await tiledThenApi('oanda:EURUSD', '1m', from, to)
    const biggestGap = (xs: KLineData[]) =>
      Math.max(...xs.slice(1).map((b, i) => b.timestamp - xs[i].timestamp))
    // FX closes ~48h; the point is that the tiled path reproduces the same discontinuity
    // the API has, rather than inventing one of its own.
    expect(biggestGap(bars)).toBe(biggestGap(expected))
    expect(biggestGap(bars)).toBeGreaterThan(24 * 3_600_000)
  })
})
