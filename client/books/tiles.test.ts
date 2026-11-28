import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { PluginFacilities } from '../plugins/types'
import { nearSource, totalsSource } from './api'
import { tilesUpTo } from '../tiles/manifest'
import { LAYOUT_VERSION, type BookTileManifest } from './tiles'

// Two halves. The coverage arithmetic is pure and always runs -- it is where both of the
// bar tiles' off-by-ones lived (chart-tiles.md, trap 2) and neither is visible to a check
// that only asks whether the API's points appear in the tiles. The decode half needs a
// store named by TILES_BASE_URL (anything serving the bucket's layout, `<base>/books/v1/...`)
// and is skipped without one, the same way client/tiles/parity.test.ts is.

const BASE = process.env.TILES_BASE_URL?.trim().replace(/\/+$/, '') || undefined
const SERIES = `${BASE}/books/${LAYOUT_VERSION}/position/oanda/EURUSD/1h`

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

// At module load, not in beforeAll: `skipIf` is evaluated while the file is being collected.
const built =
  BASE !== undefined &&
  (await Bun.fetch(`${SERIES}/manifest.json`)
    .then((r) => r.ok)
    .catch(() => false))
if (!built) {
  console.warn(
    BASE === undefined
      ? 'tiles.test: TILES_BASE_URL unset; skipping the decode cases'
      : `tiles.test: no book tiles at ${SERIES}; skipping the decode cases`
  )
}

describe.skipIf(!built)('decode', () => {
  test('a built tile decodes to points whose buckets sit on the vendor grid', async () => {
    const { pointsFromTiles, resetBookTileCaches } = await import('./tiles')
    resetBookTileCaches()
    // The module fetches by URL, under the page's own origin; point it at the store.
    const realFetch = Bun.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      realFetch(
        String(input).replace(/^https?:\/\/[^/]+\/tiles\/books/, `${BASE}/books`)
      )) as typeof fetch
    globalThis.window = { location: { origin: 'http://localhost' } } as unknown as Window &
      typeof globalThis

    try {
      const man = (await (await realFetch(`${SERIES}/manifest.json`)).json()) as BookTileManifest
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
      const points = answer?.items ?? []
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
    const real = (await (await Bun.fetch(`${SERIES}/manifest.json`)).json()) as BookTileManifest
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
      return realFetch(url.replace(/^https?:\/\/[^/]+\/tiles\/books/, `${BASE}/books`))
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

// -- the decoded tiles a page holds -----------------------------------------------------------
//
// A tile is decoded once and its rows held, so a window read again -- panning back across a tile,
// a replay re-reading the period it stands in -- is not decoded again. Until 2026-11-28 nothing
// ever let one go (`resetBookTileCaches` is a test seam): every tile a page read stayed decoded
// until reload, ~60k bucket rows for a month of 1h profile, for every month, instrument and kind
// panned through. Now they are held under one budget, least recently used out first.

describe('the decoded tiles held', () => {
  test('a tile held counts what it carries, and the least recently used goes past the budget', async () => {
    const { DecodedBookTiles } = await import('./tiles')
    const tiles = new DecodedBookTiles(100)
    tiles.set('a', [1, 2], 40)
    tiles.set('b', [1, 2], 40)
    // Read, `a` is the most recently used: `b` goes when `c` is held.
    expect(tiles.get('a')).toEqual([1, 2])
    tiles.set('c', [1], 40)
    expect(tiles.get('b')).toBeUndefined()
    expect(tiles.get('a')).toEqual([1, 2])
    expect(tiles.get('c')).toEqual([1])
    expect(tiles.values).toBe(80)
    // Held again, a tile's count replaces the old one.
    tiles.set('c', [1], 10)
    expect(tiles.values).toBe(50)
  })

  test('a single tile over the budget is kept while it is the one in use', async () => {
    const { DecodedBookTiles } = await import('./tiles')
    const tiles = new DecodedBookTiles(100)
    tiles.set('a', [], 30)
    tiles.set('big', [], 250)
    expect(tiles.get('a')).toBeUndefined()
    expect(tiles.get('big')).toEqual([])
    expect(tiles.values).toBe(250)
  })

  test('over many tiles read, the first is decoded again while one read all along is not', async () => {
    // A month of 1h position profile in the builder's own encoding (wmarketdata
    // bin/build_book_tiles.py `encode`), real in size -- 730 served snapshots of 80 buckets -- and
    // synthetic in value: no book tile has been published to either environment's bucket. Every
    // tile of the manifest below serves these same bytes under its own name.
    const fixture = (suffix: string): ArrayBuffer => {
      const b = readFileSync(`${import.meta.dir}/fixtures/position-1h-month.${suffix}.parquet`)
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
    }
    const bytes = { s: fixture('s'), p: fixture('p') }
    const H = 3_600_000
    const START = Date.UTC(2026, 0, 1)
    const MONTH = 730 * H
    const TILES = 40
    const series: BookTileManifest = manifest({
      symbol: 'TSTBOOK',
      coveredFrom: START,
      coveredTo: START + TILES * MONTH,
      tiles: Array.from({ length: TILES }, (_, i) => ({
        name: `t${i}`,
        from: START + i * MONTH,
        to: START + (i + 1) * MONTH - 1,
        rows: 730,
        bytes: 999,
        profileRows: 58_400,
        profileBytes: 19_896
      }))
    })

    const { pointsFromTiles, resetBookTileCaches } = await import('./tiles')
    resetBookTileCaches()
    const fetched = new Map<string, number>()
    const realFetch = globalThis.fetch
    const realWindow = globalThis.window
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const name = String(input).split('/').at(-1) as string
      fetched.set(name, (fetched.get(name) ?? 0) + 1)
      if (name === 'manifest.json') return new Response(JSON.stringify(series))
      return new Response(name.endsWith('.p.parquet') ? bytes.p : bytes.s)
    }) as typeof fetch
    globalThis.window = { location: { origin: 'http://localhost' } } as unknown as Window &
      typeof globalThis
    const read = (i: number) =>
      pointsFromTiles('profile', 'position', 'oanda', 'TSTBOOK', '1h', START + i * MONTH, START + (i + 1) * MONTH)

    try {
      expect((await read(0))?.items.length).toBe(730)
      for (let i = 2; i < TILES; i++) {
        await read(i)
        // A pane standing in tile 1 -- a replay's period -- reads it again at every step.
        await read(1)
      }
      expect(fetched.get('t1.p.parquet')).toBe(1)
      // Tile 0 was let go long ago: read again, it is decoded again (from the Cache API's bytes
      // in a browser; from the network here, where there is none).
      await read(0)
      expect(fetched.get('t0.p.parquet')).toBe(2)
      expect(fetched.get('t1.p.parquet')).toBe(1)
      expect(fetched.get('manifest.json')).toBe(1)
    } finally {
      globalThis.fetch = realFetch
      globalThis.window = realWindow
      resetBookTileCaches()
    }
  }, 30_000)
})
