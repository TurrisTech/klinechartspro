import { describe, expect, test } from 'bun:test'
import type { KLineData } from 'klinecharts'
import { installWindow } from '../plugins/testing'
import type { TileColumns } from '../tiles/decode'
import type { TileEntry, TileManifest } from '../tiles/manifest'
import type { BarSource, Columns, ReplayBar } from './cache'
import type { CandleGrid } from './timeframes'

// THE REPLAY'S BARS FROM TILES: a read inside the tiles is answered from whole tiles held in
// memory (bid and ask joined row for row), the next tile starts loading as one is read, what lies
// past the tiles comes from the server, and anything the tiles cannot answer goes to the server
// whole. The fake layer is two 1m tiles of one Tuesday and Wednesday, and the server holds both
// days and Thursday besides -- the period the tiles do not cover yet.

installWindow()
const { TiledBarSource, barsBetween, pairColumns } = await import('./tiled')
const { FX_GRID } = await import('./timeframes')

const M = 60_000
const DAY = 86_400_000
const T0 = Date.parse('2024-03-05T00:00Z') // a Tuesday, inside the FX week
const minutes = (from: number, n: number): KLineData[] => Array.from({ length: n }, (_, i) => ({ timestamp: from + i * M, open: 1 + i, high: 2 + i, low: i, close: 1.5 + i, volume: i }))
const col = (bars: KLineData[], f: (b: KLineData) => number) => Float64Array.from(bars, f)
const midColumns = (bars: KLineData[]): TileColumns => ({ ts: col(bars, (b) => b.timestamp), o: col(bars, (b) => b.open), h: col(bars, (b) => b.high), l: col(bars, (b) => b.low), c: col(bars, (b) => b.close), v: col(bars, (b) => b.volume ?? 0) })
const quotes = (bars: KLineData[]): TileColumns => ({ ts: col(bars, (b) => b.timestamp), bo: col(bars, (b) => b.open - 0.1), bh: col(bars, (b) => b.high - 0.1), bl: col(bars, (b) => b.low - 0.1), bc: col(bars, (b) => b.close - 0.1), ao: col(bars, (b) => b.open + 0.1), ah: col(bars, (b) => b.high + 0.1), al: col(bars, (b) => b.low + 0.1), ac: col(bars, (b) => b.close + 0.1) })
const day1 = minutes(T0, 1440)
const day2 = minutes(T0 + DAY, 1440)
const day3 = minutes(T0 + 2 * DAY, 1440)
const entry = (name: string, bars: KLineData[]): TileEntry => ({ name, from: bars[0].timestamp, to: bars[bars.length - 1].timestamp, rows: bars.length, bytes: 1 })
const MANIFEST = { vendor: 'oanda', symbol: 'EURUSD', interval: '1m', coveredFrom: T0, coveredTo: T0 + 2 * DAY, tiles: [entry('d1', day1), entry('d2', day2)], precision: 5 } as unknown as TileManifest

class FakeLayer {
  pairs: string[] = []
  mids: Array<[number, number]> = []
  broken = new Set<string>()
  misaligned = new Set<string>()
  async mid(_vs: string, _iv: string, from: number, to: number) {
    this.mids.push([from, to])
    return { items: [...day1, ...day2].filter((b) => b.timestamp >= from && b.timestamp < Math.min(to, MANIFEST.coveredTo)), coveredTo: MANIFEST.coveredTo }
  }
  async manifest() {
    return MANIFEST
  }
  async pair(_m: TileManifest, e: TileEntry) {
    this.pairs.push(e.name)
    if (this.broken.has(e.name)) return null
    const bars = e.name === 'd1' ? day1 : day2
    const quote = quotes(bars)
    if (this.misaligned.has(e.name)) quote.ts[3] += 1
    return pairColumns(midColumns(bars), quote)
  }
}

/** The server: all three days, every call recorded. */
class FakeApi implements BarSource {
  calls: Array<{ from: number; to: number; columns: Columns }> = []
  async fetch(_s: string, interval: string, from: number, to: number, columns: Columns, grid: CandleGrid): Promise<ReplayBar[]> {
    this.calls.push({ from, to, columns })
    return [...day1, ...day2, ...day3]
      .filter((b) => b.timestamp >= from && b.timestamp < to)
      .map((b) => ({ open: b.timestamp, end: grid.end(interval, b.timestamp), date: b.timestamp, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume ?? 0, ...(columns === 'all' ? { bid: { o: b.open - 0.1, h: b.high - 0.1, l: b.low - 0.1, c: b.close - 0.1 }, ask: { o: b.open + 0.1, h: b.high + 0.1, l: b.low + 0.1, c: b.close + 0.1 } } : {}) }))
  }
}

const make = (maxBars?: number) => {
  const layer = new FakeLayer()
  const api = new FakeApi()
  return { layer, api, source: new TiledBarSource(api, layer, maxBars) }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('TiledBarSource', () => {
  test("a read inside the tiles is the server's answer, from a whole tile held in memory", async () => {
    const { layer, api, source } = make()
    const from = T0 + 600 * M
    const bars = await source.fetch('oanda:EURUSD', '1m', from, from + 30 * M, 'all', FX_GRID)
    expect(bars).toEqual(await api.fetch('oanda:EURUSD', '1m', from, from + 30 * M, 'all', FX_GRID))
    api.calls.length = 0
    // The rest of the day is already decoded: the next reads ask nothing of anyone.
    await settle()
    const pairs = layer.pairs.length
    const later = await source.fetch('oanda:EURUSD', '1m', from + 30 * M, T0 + DAY, 'all', FX_GRID)
    expect(later).toHaveLength(1440 - 630)
    expect(layer.pairs.length).toBe(pairs)
    expect(api.calls).toEqual([])
  })

  test('loading a tile starts the next one, so a walk reaching its end finds the next decoded', async () => {
    const { layer, source } = make()
    await source.fetch('oanda:EURUSD', '1m', T0, T0 + 10 * M, 'all', FX_GRID)
    await settle()
    expect(layer.pairs).toEqual(['d1', 'd2'])
    expect(source.size).toBe(2880)
  })

  test('past the tiles, the rest comes from the server', async () => {
    const { api, source } = make()
    const bars = await source.fetch('oanda:EURUSD', '1m', T0 + DAY + 1380 * M, T0 + 2 * DAY + 120 * M, 'all', FX_GRID)
    expect(bars).toHaveLength(60 + 120)
    expect(api.calls).toEqual([{ from: T0 + 2 * DAY, to: T0 + 2 * DAY + 120 * M, columns: 'all' }])
  })

  test('a tile that will not load, or a quote half from another build, sends the window to the server whole', async () => {
    for (const fault of ['broken', 'misaligned'] as const) {
      const { layer, api, source } = make()
      layer[fault].add('d1')
      const bars = await source.fetch('oanda:EURUSD', '1m', T0, T0 + 60 * M, 'all', FX_GRID)
      expect(bars).toHaveLength(60)
      expect(api.calls).toEqual([{ from: T0, to: T0 + 60 * M, columns: 'all' }])
    }
  })

  test('a tile that would not load is asked for once, not at every read', async () => {
    const { layer, api, source } = make()
    layer.broken.add('d1')
    await source.fetch('oanda:EURUSD', '1m', T0, T0 + 60 * M, 'all', FX_GRID)
    await source.fetch('oanda:EURUSD', '1m', T0 + 60 * M, T0 + 120 * M, 'all', FX_GRID)
    expect(layer.pairs.filter((name) => name === 'd1')).toHaveLength(1)
    expect(api.calls).toHaveLength(2)
  })

  test('mid-only reads take the tiles the chart reads, and the server for the rest', async () => {
    const { layer, api, source } = make()
    const bars = await source.fetch('oanda:EURUSD', '1m', T0 + DAY + 1430 * M, T0 + 2 * DAY + 10 * M, 'core', FX_GRID)
    expect(bars).toHaveLength(20)
    expect(bars[0].bid).toBeUndefined()
    expect(layer.mids).toEqual([[T0 + DAY + 1430 * M, T0 + 2 * DAY + 10 * M]])
    expect(api.calls).toEqual([{ from: T0 + 2 * DAY, to: T0 + 2 * DAY + 10 * M, columns: 'core' }])
  })

  test('held tiles are bounded, least recently used out first', async () => {
    const { layer, source } = make(2000)
    await source.fetch('oanda:EURUSD', '1m', T0, T0 + M, 'all', FX_GRID)
    await settle()
    // Both loaded (the second ahead of need); over the bound, the older one went.
    expect(source.size).toBe(1440)
    layer.pairs.length = 0
    await source.fetch('oanda:EURUSD', '1m', T0 + DAY, T0 + DAY + M, 'all', FX_GRID)
    expect(layer.pairs).toEqual([])
  })

  test('a quote half is paired row for row, or not at all', () => {
    expect(pairColumns(midColumns(day1.slice(0, 2)), quotes(day1.slice(0, 2)))).not.toBeNull()
    expect(pairColumns(midColumns(day1.slice(0, 2)), quotes(day1.slice(0, 1)))).toBeNull()
    const moved = quotes(day1.slice(0, 2))
    moved.ts[1] += 1
    expect(pairColumns(midColumns(day1.slice(0, 2)), moved)).toBeNull()
  })

  test('a held tile builds bars only for the rows a read asks for', () => {
    const tile = pairColumns(midColumns(day1), quotes(day1))
    if (!tile) throw new Error('unpaired')
    const bars = barsBetween(tile, T0 + M, T0 + 3 * M, '1m', FX_GRID)
    expect(bars).toHaveLength(2)
    expect(bars[0]).toEqual({ open: T0 + M, end: T0 + 2 * M, date: T0 + M, o: 2, h: 3, l: 1, c: 2.5, v: 1, bid: { o: 1.9, h: 2.9, l: 0.9, c: 2.4 }, ask: { o: 2.1, h: 3.1, l: 1.1, c: 2.6 } })
    expect(barsBetween(tile, T0 - DAY, T0, '1m', FX_GRID)).toEqual([])
  })
})
