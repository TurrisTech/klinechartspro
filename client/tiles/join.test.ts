import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { KLineData } from 'klinecharts'
import type { Page, Range } from '../plugins/types'
import { decodeTile } from './decode'
import type { Tiled, TiledRead } from './join'
import { LAYOUT_VERSION, type TileManifest } from './manifest'

// The one join every tile family makes (`join.ts`): tiles for what they hold of a window, the
// API for the rest. The chart's bars read the LAST n of a window, the plugins page the FIRST n
// forwards; under a bar replay the tiles stop at the bar forming at the clock.

// `window` does not exist under bun, and client/config.ts reads it at MODULE LOAD.
const hadWindow = 'window' in globalThis
if (!hadWindow) (globalThis as { window?: unknown }).window = { location: { href: 'http://tiles.test/', origin: 'http://tiles.test' } }
const originalFetch = globalThis.fetch

const { readTiled } = await import('./join')
const { setReadClock } = await import('../config')

afterAll(() => {
  globalThis.fetch = originalFetch
  setReadClock(null)
  if (!hadWindow) delete (globalThis as { window?: unknown }).window
})

interface Point {
  date: number
  from: 'tiles' | 'api'
}

const DATES = Array.from({ length: 20 }, (_, i) => (i + 1) * 10)

/** Tiles holding every date below `coveredTo`, an API holding every date at all -- keeping the
 * end of a window `keep` names, as `/getbars` keeps the last n -- and what each was asked. */
function fake(coveredTo: number | null, keep: 'first' | 'last' = 'first') {
  const asked: Array<Range & { limit: number | null }> = []
  const tileLimits: Array<number | null> = []
  const tiles = async (range: Range, limit: number | null): Promise<Tiled<Point> | null> => {
    tileLimits.push(limit)
    if (coveredTo === null || range.from >= coveredTo) return null
    const end = Math.min(range.to, coveredTo)
    return { items: DATES.filter((d) => d >= range.from && d < end).map((date) => ({ date, from: 'tiles' })), coveredTo }
  }
  const api = async (range: Range, limit: number | null): Promise<Page<Point>> => {
    asked.push({ ...range, limit })
    const all = DATES.filter((d) => d >= range.from && d < range.to).map((date): Point => ({ date, from: 'api' }))
    return { points: limit === null ? all : keep === 'first' ? all.slice(0, limit) : all.slice(-limit), nextFrom: null }
  }
  return { asked, tileLimits, tiles, api }
}

const read = (f: ReturnType<typeof fake>, over: Partial<TiledRead<Point>>): TiledRead<Point> => ({
  range: { from: 0, to: 1000 },
  limit: null,
  keep: 'first',
  date: (p) => p.date,
  tiles: f.tiles,
  api: f.api,
  ...over
})
const dates = (page: Page<Point>) => page.points.map((p) => `${p.from}:${p.date}`)

describe('readTiled', () => {
  test('tiles reaching the end answer alone', async () => {
    const f = fake(500)
    const page = await readTiled(read(f, { range: { from: 0, to: 75 } }))
    expect(page.points.map((p) => p.date)).toEqual([10, 20, 30, 40, 50, 60, 70])
    expect(page.points.every((p) => p.from === 'tiles')).toBe(true)
    expect(page.nextFrom).toBeNull()
    expect(f.asked).toEqual([])
  })

  test('a window across the edge is split exactly there: nothing twice, nothing dropped', async () => {
    const f = fake(55)
    const page = await readTiled(read(f, { range: { from: 0, to: 85 } }))
    expect(dates(page)).toEqual(['tiles:10', 'tiles:20', 'tiles:30', 'tiles:40', 'tiles:50', 'api:60', 'api:70', 'api:80'])
    expect(f.asked).toEqual([{ from: 55, to: 85, limit: null }])
  })

  test('no tiles: the API answers the whole window', async () => {
    const f = fake(null)
    const page = await readTiled(read(f, { range: { from: 0, to: 35 } }))
    expect(dates(page)).toEqual(['api:10', 'api:20', 'api:30'])
    expect(f.asked).toEqual([{ from: 0, to: 35, limit: null }])
  })

  test('a forward page full from the tiles continues from its last point, asking nothing', async () => {
    const f = fake(500)
    const page = await readTiled(read(f, { limit: 3 }))
    expect(dates(page)).toEqual(['tiles:10', 'tiles:20', 'tiles:30'])
    expect(page.nextFrom).toBe(31)
    expect(f.asked).toEqual([])
    // The tiles may stop reading once they have that many.
    expect(f.tileLimits).toEqual([3])
  })

  test('a forward page across the edge asks the API only for what the page still lacks', async () => {
    const f = fake(25)
    const page = await readTiled(read(f, { limit: 5 }))
    expect(dates(page)).toEqual(['tiles:10', 'tiles:20', 'api:30', 'api:40', 'api:50'])
    expect(f.asked).toEqual([{ from: 25, to: 1000, limit: 3 }])
  })

  test('a chart window keeps its LAST n, from both halves', async () => {
    const f = fake(55, 'last')
    const page = await readTiled(read(f, { range: { from: 0, to: 85 }, limit: 4, keep: 'last' }))
    expect(dates(page)).toEqual(['tiles:50', 'api:60', 'api:70', 'api:80'])
    expect(f.asked).toEqual([{ from: 55, to: 85, limit: 4 }])
    expect(f.tileLimits).toEqual([null])
  })

  test('under a replay the tiles stop at the horizon and the API answers from there', async () => {
    const forwards = fake(500)
    const page = await readTiled(read(forwards, { range: { from: 0, to: 75 }, horizon: Promise.resolve(45) }))
    expect(dates(page)).toEqual(['tiles:10', 'tiles:20', 'tiles:30', 'tiles:40', 'api:50', 'api:60', 'api:70'])
    expect(forwards.asked).toEqual([{ from: 45, to: 75, limit: null }])

    const chart = fake(500, 'last')
    const window = await readTiled(read(chart, { range: { from: 0, to: 75 }, limit: 2, keep: 'last', horizon: 65 }))
    expect(dates(window)).toEqual(['tiles:60', 'api:70'])
    expect(chart.asked).toEqual([{ from: 65, to: 75, limit: 2 }])

    // A horizon at or before the window's start leaves the tiles nothing.
    const early = fake(500)
    await readTiled(read(early, { range: { from: 50, to: 75 }, horizon: 50 }))
    expect(early.asked).toEqual([{ from: 50, to: 75, limit: null }])
  })

  test('`admit` refuses items from both halves before `limit` is applied', async () => {
    const odd = (p: Point) => (p.date / 10) % 2 === 1
    const chart = fake(55, 'last')
    const window = await readTiled(read(chart, { range: { from: 0, to: 105 }, limit: 4, keep: 'last', admit: Promise.resolve(odd) }))
    expect(dates(window)).toEqual(['tiles:30', 'tiles:50', 'api:70', 'api:90'])

    const forwards = fake(500)
    const page = await readTiled(read(forwards, { limit: 3, admit: Promise.resolve(odd) }))
    expect(dates(page)).toEqual(['tiles:10', 'tiles:30', 'tiles:50'])
    expect(page.nextFrom).toBe(51)
    // Not told to stop early: the first n rows read might not hold n admitted ones.
    expect(forwards.tileLimits).toEqual([null])
  })
})

// The chart under a bar replay, end to end over the committed XRPUSD monthly tile. A replay pane
// reloads with a window ending at the cursor; the tiles hold the month forming there, whole, and
// until 2026-10-11 they answered it -- the pane drew that month's final high, low and close at a
// cursor ten days into it. The server rebuilds the forming bar from the rows closed by the clock.
describe('fetchBars under a bar replay', () => {
  const TILE = `${import.meta.dir}/fixtures/coinbase-XRPUSD-1M-int64-volume.parquet`
  const TILE_NAME = 'all-1bdf00cf.parquet'
  const FORMING = -1
  let bars: KLineData[] = []
  let fetchBars: typeof import('../history').fetchBars
  const getbars: URL[] = []

  function bytes(): ArrayBuffer {
    const b = readFileSync(TILE)
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  }

  beforeAll(async () => {
    bars = await decodeTile(bytes(), 4)
    const monthly: TileManifest = {
      vendor: 'coinbase',
      symbol: 'XRPUSD',
      interval: '1M',
      granularity: 'all',
      precision: 4,
      sessionDated: false,
      tz: 'UTC',
      schedule: 'continuous',
      day: { open: 0, close: 24, everyDay: true },
      coveredFrom: bars[0].timestamp,
      coveredTo: bars[bars.length - 1].timestamp + 1,
      tiles: [{ name: TILE_NAME, from: bars[0].timestamp, to: bars[bars.length - 1].timestamp, rows: bars.length, bytes: bytes().byteLength }]
    }
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      const tile = new RegExp(`/${LAYOUT_VERSION}/coinbase/([^/]+)/1M/(.+)$`).exec(url.pathname)
      if (tile?.[2] === 'manifest.json') return Response.json({ ...monthly, symbol: tile[1] })
      if (tile?.[2] === TILE_NAME) return new Response(bytes(), { status: 200 })
      if (url.pathname.endsWith('/instrument')) {
        const sessions = [{ openDay: 'mon', openTime: '00:00', closeDay: 'mon', closeTime: '00:00' }]
        return Response.json({ vendor: 'coinbase', symbol: 'XRPUSD', marketHours: { timezone: 'UTC', sessions } })
      }
      if (url.pathname.endsWith('/getbars')) {
        // The server under `asof`: the closed bars of the window, and the bar forming at the
        // clock rebuilt -- marked here so the test can tell it from the tile's whole month.
        getbars.push(url)
        const from = Number(url.searchParams.get('from'))
        const to = Number(url.searchParams.get('to'))
        const asof = Number(url.searchParams.get('asof'))
        const answer = bars
          .filter((bar) => bar.timestamp >= from && bar.timestamp < to && bar.timestamp < asof)
          .map((bar, i, all) => {
            const forming = i === all.length - 1 && Number.isFinite(asof) && bar.timestamp + 28 * 86_400_000 > asof
            const price = forming ? FORMING : bar.close
            return { date: bar.timestamp, open: price, high: price, low: price, close: price, volume: 1 }
          })
        return Response.json(answer.length === 0 ? { s: 'no_data' } : answer)
      }
      return new Response('not found', { status: 404 })
    }) as typeof globalThis.fetch
    ;({ fetchBars } = await import('../history'))
  })

  test('live, the tiles answer a window they hold alone', async () => {
    setReadClock(null)
    getbars.length = 0
    const k = Math.floor(bars.length / 2)
    const window = await fetchBars('coinbase:XRPLIVE', '1M', bars[k - 5].timestamp, bars[k].timestamp + 10 * 86_400_000, 500)
    expect(window.map((bar) => bar.timestamp)).toEqual(bars.slice(k - 5, k + 1).map((bar) => bar.timestamp))
    expect(window.at(-1)?.close).toBe(bars[k].close)
    expect(getbars).toEqual([])
  })

  test('the month forming at the cursor comes from the server, not whole from the tiles', async () => {
    const k = Math.floor(bars.length / 2)
    const cursor = bars[k].timestamp + 10 * 86_400_000
    setReadClock(cursor)
    getbars.length = 0
    try {
      const window = await fetchBars('coinbase:XRPREPLAY', '1M', bars[k - 5].timestamp, cursor, 500)
      expect(window.map((bar) => bar.timestamp)).toEqual(bars.slice(k - 5, k + 1).map((bar) => bar.timestamp))
      expect(window.slice(0, -1).map((bar) => bar.close)).toEqual(bars.slice(k - 5, k).map((bar) => bar.close))
      expect(window.at(-1)?.close).toBe(FORMING)
      expect(getbars.map((url) => Number(url.searchParams.get('from')))).toEqual([bars[k].timestamp])
    } finally {
      setReadClock(null)
    }
  })
})
