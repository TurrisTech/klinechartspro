import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { LAYOUT_VERSION } from './manifest'

// End-to-end over the real tiles bin/build_chart_tiles.py wrote: manifest -> fetch -> decode
// -> KLineData, through the same code the browser runs. The positive half of the contract;
// manifest.test.ts pins where tiles stop and parity.test.ts pins that the join is exact.
//
// Opt-in: it reads a local tile tree only when TILES_ROOT names one (laid out like the bucket,
// `<root>/v2/<vendor>/<symbol>/<interval>/...`), and skips every case otherwise. There is no
// default directory -- the one there used to be, /mnt/d/marketdata/dev/tiles, is a damaged,
// ephemeral volume being retired.
//
// Every test is gated on the series IT reads, not on the store as a whole. A local store is
// routinely partial -- on 2026-09-15 this workstation's v2 tree held EURUSD and EURTRY and
// nothing else, the rest of it still v1 -- and a single EURUSD gate let the USDJPY test run
// against a manifest that did not exist, failing with `expected tiled bars, got null`. A
// missing series now skips its test by name; the precision rule that test was the only
// cover for is pinned against a committed fixture in `precision.test.ts`, which needs no
// store at all.
//
// Likewise nothing here keys off the wall clock. A local tree is built by hand and ages; a
// window measured back from `Date.now()` stopped overlapping it thirty days after the last
// build. The live-edge tests are measured from the manifest's own `coveredTo`.

const ROOT = process.env.TILES_ROOT?.trim().replace(/\/+$/, '') || undefined

function manifestPath(vendor: string, symbol: string, interval: string): string {
  return `${ROOT}/${LAYOUT_VERSION}/${vendor}/${symbol}/${interval}/manifest.json`
}

/** Whether the local store holds this series under the layout the client reads. */
function stored(vendor: string, symbol: string, interval: string): boolean {
  return ROOT !== undefined && existsSync(manifestPath(vendor, symbol, interval))
}

const eurusd = stored('oanda', 'EURUSD', '1m')
const usdjpy = stored('oanda', 'USDJPY', '1m')

/** Where the stored EURUSD 1m tiles stop, read from the manifest the client will read. */
function eurusdCoveredTo(): number {
  return (JSON.parse(readFileSync(manifestPath('oanda', 'EURUSD', '1m'), 'utf8')) as { coveredTo: number }).coveredTo
}

let barsFromTiles: typeof import('./index').barsFromTiles

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
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    const file = Bun.file(`${ROOT}${new URL(url).pathname.replace(/^\/tiles/, '')}`)
    if (!(await file.exists())) return new Response('no such tile', { status: 404 })
    return new Response(await file.arrayBuffer(), { status: 200 })
  }) as typeof globalThis.fetch
  ;({ barsFromTiles } = await import('./index'))
})

afterAll(() => {
  // Restore the engine's own fetch rather than whatever the global happened to hold on
  // entry: another file in this suite stubs it permanently at module load, and putting
  // that back would leak it onward to every later file.
  globalThis.fetch = Bun.fetch
})

describe('barsFromTiles over the real tile store', () => {
  test.skipIf(!eurusd)('serves a historical 1m window with correctly unscaled prices', async () => {
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

  test.skipIf(!usdjpy)('unscales a 3-decimal instrument by its own precision, not a global one', async () => {
    const { bars } = present(
      await barsFromTiles('oanda:USDJPY', '1m', Date.UTC(2024, 2, 4, 0), Date.UTC(2024, 2, 4, 4)),
      'tiled bars'
    )
    // ~150, not ~0.0015 (1e5) and not ~150000 (unscaled).
    expect(bars[0].open).toBeGreaterThan(80)
    expect(bars[0].open).toBeLessThan(300)
  })

  test.skipIf(!eurusd)('joins consecutive tiles across a month boundary without a gap or duplicate', async () => {
    const { bars } = present(
      await barsFromTiles('oanda:EURUSD', '1m', Date.UTC(2024, 1, 29, 20), Date.UTC(2024, 2, 1, 4)),
      'tiled bars'
    )
    expect(new Set(bars.map((b) => b.timestamp)).size).toBe(bars.length)
    expect(bars.some((b) => b.timestamp < Date.UTC(2024, 2, 1))).toBe(true)
    expect(bars.some((b) => b.timestamp >= Date.UTC(2024, 2, 1))).toBe(true)
  })

  test.skipIf(!eurusd)('reports where tiles stop so the caller can fetch the rest', async () => {
    const edge = eurusdCoveredTo()
    const to = edge + 7 * 86_400_000
    const tiled = await barsFromTiles('oanda:EURUSD', '1m', edge - 30 * 86_400_000, to)
    // A window reaching past the tiles is answered in part, not refused: tiles carry the
    // closed periods and coveredTo says where /getbars must pick up.
    const { bars, coveredTo } = present(tiled, 'a partial tiled answer')
    expect(bars.length).toBeGreaterThan(0)
    expect(coveredTo).toBe(edge)
    expect(coveredTo).toBeLessThan(to)
    expect(Math.max(...bars.map((b) => b.timestamp))).toBeLessThan(coveredTo)
  })

  test.skipIf(!eurusd)('contributes nothing when the window is entirely in the forming period', async () => {
    const edge = eurusdCoveredTo()
    expect(await barsFromTiles('oanda:EURUSD', '1m', edge, edge + 500 * 60_000)).toBeNull()
  })

  test.skipIf(!eurusd)('returns null for an interval that has no tiles', async () => {
    expect(await barsFromTiles('oanda:EURUSD', '15', Date.UTC(2024, 2, 4), Date.UTC(2024, 2, 5))).toBeNull()
  })
})
