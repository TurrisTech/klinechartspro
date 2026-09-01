import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import type { PluginFacilities } from '../plugins/types'
import { nearSource, totalsSource } from './api'
import { LAYOUT_VERSION, type BookTileManifest, tilesUpTo } from './tiles'

// Two halves. The coverage arithmetic is pure and always runs -- it is where both of the
// bar tiles' off-by-ones lived (chart-tiles.md, trap 2) and neither is visible to a check
// that only asks whether the API's points appear in the tiles. The decode half needs a
// built store and is skipped without one, the same way client/tiles/parity.test.ts is.

const ROOT = process.env.TILES_ROOT ?? '/mnt/d/marketdata/tiles'
const SERIES = `${ROOT}/books/${LAYOUT_VERSION}/position/oanda/EURUSD/1h`

function manifest(over: Partial<BookTileManifest> = {}): BookTileManifest {
  return {
    kind: 'position',
    vendor: 'oanda',
    symbol: 'EURUSD',
    interval: '1h',
    granularity: 'month',
    priceScale: 5,
    pctScale: 4,
    depth: 40,
    gridMs: 1_200_000,
    knowableMs: 300_000,
    sessionDated: false,
    coveredFrom: 1000,
    coveredTo: 3000,
    tiles: [
      { name: 'a', from: 1000, to: 1900, rows: 10, bytes: 1, profileRows: 80, profileBytes: 9 },
      { name: 'b', from: 2000, to: 2900, rows: 10, bytes: 1, profileRows: 80, profileBytes: 9 }
    ],
    ...over
  }
}

describe('coverage', () => {
  test('a window inside the tiles takes only the tiles that overlap it', () => {
    expect(tilesUpTo(manifest(), 1500, 1800)?.entries.map((e) => e.name)).toEqual(['a'])
    expect(tilesUpTo(manifest(), 1500, 2500)?.entries.map((e) => e.name)).toEqual(['a', 'b'])
  })

  test('`to` is exclusive, so a tile starting exactly at it is the next window', () => {
    // The bar tiles' second off-by-one: an inclusive right edge yields one point too many,
    // and every "are the API's points present?" check passes with the extra one there.
    expect(tilesUpTo(manifest(), 1000, 2000)?.entries.map((e) => e.name)).toEqual(['a'])
  })

  test('coverage stops at coveredTo, never at the last point', () => {
    // The first off-by-one. `coveredTo` is a period boundary: a window reaching past it is
    // answered by the tiles up to there and by the API beyond, and a reader that split at
    // the last point instead would hand the API a range starting inside a tiled period.
    const span = tilesUpTo(manifest(), 1500, 9999)
    expect(span?.coveredTo).toBe(3000)
    expect(span?.coveredTo).toBeGreaterThan(2900)
  })

  test('a window entirely past coverage cannot be helped', () => {
    expect(tilesUpTo(manifest(), 3000, 4000)).toBeNull()
    expect(tilesUpTo(manifest(), 5000, 6000)).toBeNull()
  })

  test('an empty overlap INSIDE coverage is an answer, not a miss', () => {
    // The gap between the two tiles is a weekend or an outage: the tiles have settled it
    // and the answer is "no books". Returning null would send every such probe to the API
    // for a range it will answer with nothing -- which is most of the pagination widener's
    // traffic while panning.
    const span = tilesUpTo(manifest(), 1950, 1990)
    expect(span).not.toBeNull()
    expect(span?.entries).toEqual([])
  })

  test('a window starting before coverage falls back for the whole of it', () => {
    expect(tilesUpTo(manifest(), 500, 900)).toBeNull()
  })
})

const built = existsSync(`${SERIES}/manifest.json`)
if (!built) console.warn(`tiles.test: no book tiles at ${SERIES}; skipping the decode cases`)

describe.skipIf(!built)('decode', () => {
  test('a built tile decodes to points whose buckets sit on the vendor grid', async () => {
    const { pointsFromTiles, resetBookTileCaches } = await import('./tiles')
    resetBookTileCaches()
    // The module fetches by URL; point it at the local tree through a file-reading fetch,
    // which is what the dev server does for the bar tiles too.
    const realFetch = Bun.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      const path = url.replace(/^https?:\/\/[^/]+\/tiles\/books/, `${ROOT}/books`)
      if (!existsSync(path)) return new Response(null, { status: 404 })
      return new Response(await Bun.file(path).arrayBuffer())
    }) as typeof fetch
    globalThis.window = { location: { origin: 'http://localhost' } } as unknown as Window &
      typeof globalThis

    try {
      const man = (await Bun.file(`${SERIES}/manifest.json`).json()) as BookTileManifest
      const first = man.tiles[0]
      const answer = await pointsFromTiles(
        'profile',
        'position',
        'oanda',
        'EURUSD',
        '1h',
        first.from,
        first.to + 1
      )
      expect(answer).not.toBeNull()
      const points = answer?.points ?? []
      expect(points.length).toBeGreaterThan(0)
      for (const point of points.slice(0, 20) as {
        price: number
        width: number
        buckets: [number, number, number][]
      }[]) {
        expect(point.width).toBeGreaterThan(0)
        for (const [price] of point.buckets) {
          // n*width, reconstructed: every bucket lands exactly on a multiple of the width,
          // which is the invariant the integer bucket index exists to preserve.
          const index = price / point.width
          expect(Math.abs(index - Math.round(index))).toBeLessThan(1e-6)
        }
      }
      // Points are ascending on the bar clock and each bar appears once.
      const dates = points.map((p) => p.date)
      expect([...dates].sort((a, b) => a - b)).toEqual(dates)
      expect(new Set(dates).size).toBe(dates.length)
    } finally {
      globalThis.fetch = realFetch
      resetBookTileCaches()
    }
  })
})

// -- the join --------------------------------------------------------------------------
//
// What a source actually does: tiles for the closed part, the API for the rest, joined at
// coveredTo. The split has to be exact in both directions -- a point served twice is as
// wrong as one dropped, and neither shows up as an error.

function facilitiesStub(calls: { from: number; to: number }[]): PluginFacilities {
  return {
    points: async (request: { from: number; to: number }) => {
      calls.push({ from: request.from, to: request.to })
      return { points: [{ date: request.from, ts: request.from, long: 1, short: 2 }], nextFrom: null }
    }
  } as unknown as PluginFacilities
}

function stubTiles(manifestBody: BookTileManifest | null): () => void {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('manifest.json')) {
      return manifestBody === null
        ? new Response(null, { status: 404 })
        : new Response(JSON.stringify(manifestBody))
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch
  globalThis.window = { location: { origin: 'http://localhost' } } as unknown as Window &
    typeof globalThis
  return () => {
    globalThis.fetch = realFetch
  }
}

describe('the tile/API join', () => {
  test('a series with no tiles is served entirely by the API', async () => {
    const { resetBookTileCaches } = await import('./tiles')
    resetBookTileCaches()
    const restore = stubTiles(null)
    const calls: { from: number; to: number }[] = []
    try {
      const source = totalsSource(facilitiesStub(calls), 'position', 'oanda', 'EURUSD', '1h')
      await source.fetch({ from: 1500, to: 2500 }, 500)
      expect(calls).toEqual([{ from: 1500, to: 2500 }])
    } finally {
      restore()
      resetBookTileCaches()
    }
  })

  test('a tile that will not load falls back for the whole window, not part of it', async () => {
    // A half-served window would render as a chart that simply stops, and nothing would
    // report an error. Better one redundant API call.
    const { resetBookTileCaches } = await import('./tiles')
    resetBookTileCaches()
    const restore = stubTiles(manifest())
    const calls: { from: number; to: number }[] = []
    try {
      const source = totalsSource(facilitiesStub(calls), 'position', 'oanda', 'EURUSD', '1h')
      await source.fetch({ from: 1500, to: 5000 }, 500)
      expect(calls).toEqual([{ from: 1500, to: 5000 }])
    } finally {
      restore()
      resetBookTileCaches()
    }
  })

  test('the near metric never reads tiles', async () => {
    // `near` is a sum over a radius the tile does not carry. Half-answering it from tiles
    // would be a silently wrong number rather than a missing one.
    const { resetBookTileCaches } = await import('./tiles')
    resetBookTileCaches()
    let manifestFetches = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/tiles/')) manifestFetches++
      return new Response(null, { status: 404 })
    }) as typeof fetch
    const calls: { from: number; to: number }[] = []
    try {
      const source = nearSource(facilitiesStub(calls), 'order', 'oanda', 'EURUSD', '1h', 2)
      await source.fetch({ from: 1500, to: 2500 }, 500)
      expect(manifestFetches).toBe(0)
      expect(calls).toEqual([{ from: 1500, to: 2500 }])
    } finally {
      globalThis.fetch = realFetch
      resetBookTileCaches()
    }
  })
})

describe.skipIf(!built)('the tile/API join, against real tiles', () => {
  test('a window past coveredTo asks the API from coveredTo, not from its own start', async () => {
    // The whole point of publishing coveredTo. Asking from the window's own start would
    // serve every tiled point twice; asking from the last tiled POINT would leave the span
    // between that point and the period boundary to nobody. Neither raises anything.
    const { resetBookTileCaches } = await import('./tiles')
    resetBookTileCaches()
    const real = (await Bun.file(`${SERIES}/manifest.json`).json()) as BookTileManifest
    // Cut coverage off mid-history so the window genuinely straddles the seam.
    const cut = real.tiles[3]
    const trimmed: BookTileManifest = {
      ...real,
      tiles: real.tiles.slice(0, 4),
      coveredTo: cut.to + 1
    }
    const realFetch = Bun.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('manifest.json')) return new Response(JSON.stringify(trimmed))
      const path = url.replace(/^https?:\/\/[^/]+\/tiles\/books/, `${ROOT}/books`)
      if (!existsSync(path)) return new Response(null, { status: 404 })
      return new Response(await Bun.file(path).arrayBuffer())
    }) as typeof fetch
    globalThis.window = { location: { origin: 'http://localhost' } } as unknown as Window &
      typeof globalThis
    const calls: { from: number; to: number }[] = []
    try {
      const source = totalsSource(facilitiesStub(calls), 'position', 'oanda', 'EURUSD', '1h')
      const to = real.coveredTo
      const page = await source.fetch({ from: real.coveredFrom, to }, 100_000)
      expect(calls).toEqual([{ from: trimmed.coveredTo, to }])
      // Every tiled point is strictly below the seam, and the API's one is at it: the two
      // halves meet exactly once, with nothing between them and nothing shared.
      const tiled = page.points.filter((p) => p.date < trimmed.coveredTo)
      expect(tiled.length).toBe(page.points.length - 1)
      expect(Math.max(...tiled.map((p) => p.date))).toBeLessThan(trimmed.coveredTo)
    } finally {
      globalThis.fetch = realFetch
      resetBookTileCaches()
    }
  })
})
