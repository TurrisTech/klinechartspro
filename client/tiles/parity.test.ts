import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import type { KLineData } from 'klinecharts'
import { LAYOUT_VERSION } from './manifest'

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
// `Bun.fetch`, not `globalThis.fetch`: another test file in this suite replaces the global
// at module load and never restores it, so by the time this module is evaluated the "real"
// fetch is already somebody's stub — which silently routed every server request here into
// their fixture and failed all 13 cases, but only when the whole suite ran. Taking the
// engine's own handle makes this file independent of what any other file does to the global.
const realFetch = Bun.fetch

// Probed at module load, not in beforeAll: `test.skipIf` is evaluated while the file is
// being collected, so a flag set later is always still false and every case silently skips.
const ready = existsSync(`${ROOT}/${LAYOUT_VERSION}/oanda/EURUSD/1m/manifest.json`)
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
  // `tiles` is how many bars came from the tile store. A case that names an interval whose
  // tiles are missing falls back to /getbars for the whole window and then compares the API
  // against itself -- green, and testing nothing. That is the same silent-pass this suite
  // already failed at once, so the seam cases below REQUIRE tiles to have contributed.
  const cases: Array<[string, string, string, number, number, boolean?]> = [
    ['wholly historical', 'oanda:EURUSD', '1m', Date.UTC(2026, 6, 20), Date.UTC(2026, 6, 22)],
    ['straddles the 1m month seam', 'oanda:EURUSD', '1m', Date.UTC(2026, 6, 30), Date.UTC(2026, 7, 2)],
    ['straddles, 3-decimal instrument', 'oanda:USDJPY', '1m', Date.UTC(2026, 6, 31), Date.UTC(2026, 7, 3)],
    ['spans a weekend', 'oanda:EURUSD', '1m', Date.UTC(2026, 6, 17, 12), Date.UTC(2026, 6, 20, 12)],
    ['straddles the 1h 5-year seam', 'oanda:EURUSD', '1h', Date.UTC(2024, 11, 30), Date.UTC(2025, 0, 3)],
    ['session-dated interval', 'oanda:EURUSD', '1D', Date.UTC(2024, 0, 1), Date.UTC(2024, 2, 1)],
    ['5s, one day', 'oanda:GBPUSD', '5s', Date.UTC(2024, 2, 4), Date.UTC(2024, 2, 4, 6)],
    // Derived intervals: nothing for these is tiled, so the client FOLDS them out of the
    // base interval's tiles as it draws them (client/tiles/derive.ts). These cases are the
    // whole proof of that fold — every candle boundary, the market-closed filter and the
    // coverage seam, checked against the answer /getbars gives for the same window.
    //
    // One way for these to fail that is NOT the fold: the tile and the API can be reading
    // two different ingests of the same bars. On this workstation the 1h tiles for June–July
    // 2026 were rebuilt with --from-postgres while the dev server reads the file store, and
    // six 1h rows in that window differ by 1–4 in volume — so an 8h or 4h case landing there
    // reports a volume difference of exactly that. The check that separates the two is
    // folding the API's OWN source bars: `fold('8h', '1h', await getbars(...,'1h'))` equals
    // the API's 8h answer exactly, which is what was measured when this was first seen.
    ['15m, derived from 1m', 'oanda:EURUSD', '15m', Date.UTC(2024, 2, 4), Date.UTC(2024, 2, 8)],
    ['5m, derived, across a weekend', 'oanda:EURUSD', '5m', Date.UTC(2026, 6, 17, 12), Date.UTC(2026, 6, 20, 12)],
    ['4h, derived from 1h', 'oanda:EURUSD', '4h', Date.UTC(2020, 8, 13), Date.UTC(2020, 8, 20)],
    // Quarter seams on the quarter-granular intervals. These are where a candle opening at
    // 17:00 runs past midnight into the next period, and filing it by the calendar date of
    // its open put it in BOTH tiles, each holding half of it -- two bars on one timestamp,
    // neither the real candle. Every case above missed it: the 4h one sits in mid-September,
    // and there was no 8h case at all.
    ['4h, straddles a quarter seam', 'oanda:EURUSD', '4h', Date.UTC(2026, 2, 30), Date.UTC(2026, 3, 2), true],
    ['8h, straddles a quarter seam', 'oanda:EURUSD', '8h', Date.UTC(2026, 2, 30), Date.UTC(2026, 3, 2), true],
    ['8h, straddles the mid-year seam', 'oanda:EURUSD', '8h', Date.UTC(2026, 5, 29), Date.UTC(2026, 6, 2), true],
    ['8h, a whole quarter', 'oanda:EURUSD', '8h', Date.UTC(2026, 0, 1), Date.UTC(2026, 3, 1), true],
    ['1W, derived from 1D', 'oanda:EURUSD', '1W', Date.UTC(2024, 0, 1), Date.UTC(2024, 5, 1)],
    ['1Y, derived from 1M', 'oanda:EURUSD', '1Y', Date.UTC(2010, 0, 1), Date.UTC(2020, 0, 1)],
  ]

  for (const [label, symbol, resolution, from, to, mustUseTiles] of cases) {
    test(label, async () => {
      const expected = await getbars(symbol, resolution, from, to)
      const { bars, tiles } = await tiledThenApi(symbol, resolution, from, to)
      if (mustUseTiles) expect(tiles).toBeGreaterThan(0)
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
