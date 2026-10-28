import type { KLineData } from 'klinecharts'
import { advertisedBaseIntervals } from '../capabilities'
import { barsFromTiles } from '../tiles'
import { barsForTile } from '../tiles/cache'
import { tileBytes } from '../tiles/cachestore'
import { decodeQuoteTile, type QuoteColumns } from '../tiles/decode'
import { LAYOUT_VERSION, manifestFor, type TileEntry, type TileManifest, tilesBaseUrl, tilesUpTo } from '../tiles/manifest'
import type { BarSource, Columns, ReplayBar } from './cache'
import { HttpBarSource } from './source'
import { type CandleGrid, nominalMs } from './timeframes'

// THE REPLAY'S BARS, FROM TILES WHERE THERE ARE TILES (user, 2026-10-28: "bar replay should cache
// future data. the base timeframe should be pulled, so a whole tile from the current replay time
// to the end of the tile should be in memory"). A `BarSource` over the same immutable Parquet
// tiles the chart's history reads (client/tiles), read straight from the bucket and kept in
// memory a whole tile at a time; `/getbars` only for what no tile covers -- the period still
// forming, an interval with no tiles.
//
// Until then every replay read was `/getbars`: the walk, the skim's daily and hourly candles, the
// quote probe and every pane's catch-up asked the server again at every advance, a page of 4,000
// base bars at a time -- and one replay with a busy base could hold the server up for every tab.
// A tile is fetched once (the browser keeps the bytes, `Cache-Control: immutable`) and decoded
// once, so a walk through the rest of a week of 5s bars, and the skim's candles above it, are
// memory reads.
//
// Two kinds of read:
// - with bid and ask (`'all'`: the walk, the skim, the quote): a STORED interval's tile and its
//   `side=bidask` half, row for row (`HTTP_TILES.pair`), joined into `ReplayBar`s and held here,
//   least recently used out first. Loading one starts the next in the background, so a walk that
//   reaches the end of a tile finds the next one decoded.
// - mid only (`'core'`: the panes, the alerts): `barsFromTiles`, which also folds an interval the
//   store does not hold (3m, 4h) out of one it does, through the chart's own decoded-tile cache.
//
// The answer is the server's: for a closed period `/getbars` serves these same tiles, and every
// field of both halves was compared against it on prod -- EURGBP 5s, 1m, 1h and 1D and EURUSD
// 5s, 9,708 bars, no difference.

/** What a TiledBarSource reads tiles with -- the bucket by default, a fake in a test. */
export interface TileLayer {
  /** Mid bars, wire-dated, for as much of `[from, to)` (wire) as tiles cover -- folded out of a
   * stored interval's tiles where `interval` has none of its own; null when tiles cannot help. */
  mid(vendorSymbol: string, interval: string, from: number, to: number): Promise<{ items: KLineData[]; coveredTo: number } | null>
  /** A stored interval's own manifest, or null where it is not tiled. */
  manifest(vendor: string, symbol: string, interval: string): Promise<TileManifest | null>
  /** One tile's mid bars and its quote half, or null when either will not load. */
  pair(manifest: TileManifest, entry: TileEntry): Promise<{ mid: KLineData[]; quote: QuoteColumns } | null>
}

const quoteBytes = tileBytes('ohlcv-tiles-bidask-v1')

export const HTTP_TILES: TileLayer = {
  mid: (vendorSymbol, interval, from, to) => barsFromTiles(vendorSymbol, interval, from, to),
  manifest: (vendor, symbol, interval) => {
    // Only what the server lists as tiled has a tree; anything else is a certain 404.
    const tiled = advertisedBaseIntervals(vendor)
    return tiled === null || tiled.includes(interval) ? manifestFor(vendor, symbol, interval) : Promise.resolve(null)
  },
  pair: async (manifest, entry) => {
    const url = `${tilesBaseUrl()}/${LAYOUT_VERSION}/side=bidask/${manifest.vendor}/${manifest.symbol}/${manifest.interval}/${entry.name}`
    const [mid, bytes] = await Promise.all([barsForTile(manifest, entry), quoteBytes(url)])
    if (mid === null || bytes === null) return null
    return { mid, quote: await decodeQuoteTile(bytes, manifest.precision) }
  }
}

/** How many bid/ask bars are held decoded, least recently used tile out first: a 5s week of an
 * FX major is 55-85k, so a few weeks of 5s, or years of 1m and coarser. */
export const MAX_HELD_BARS = 250_000

export class TiledBarSource implements BarSource {
  private readonly held = new Map<string, ReplayBar[]>()
  private heldBars = 0
  private readonly loading = new Map<string, Promise<ReplayBar[] | null>>()
  /** Tiles that would not load: asked once, then left to the server -- a missing quote half is
   * answered 404 every time, and asking again at every read would put that round trip on each. */
  private readonly failed = new Set<string>()

  constructor(
    private readonly api: BarSource = new HttpBarSource(),
    private readonly tiles: TileLayer = HTTP_TILES,
    private readonly maxBars = MAX_HELD_BARS
  ) {}

  async fetch(symbol: string, interval: string, from: number, to: number, columns: Columns, grid: CandleGrid): Promise<ReplayBar[]> {
    if (to <= from) return []
    // Tiles are dated on the wire clock, as `/getbars` reads its window (`HttpBarSource`).
    const shift = grid.toWire(interval, from) - from
    const tiled = columns === 'all' ? await this.withQuotes(symbol, interval, from + shift, to + shift, grid) : await this.midOnly(symbol, interval, from + shift, to + shift, grid)
    if (tiled === null) return this.api.fetch(symbol, interval, from, to, columns, grid)
    const out = tiled.bars.filter((b) => b.open >= from && b.open < to)
    // Past the tiles: the period still forming, from the server.
    const coveredTo = tiled.coveredTo - shift
    if (coveredTo < to) out.push(...(await this.api.fetch(symbol, interval, Math.max(from, coveredTo), to, columns, grid)))
    return out
  }

  /** Load what a read at `at` would need of each interval -- the tile it falls in, and the next --
   * before anything asks: the base the walk takes, and the coarser ones the skim asks first. */
  async warm(symbol: string, intervals: readonly string[], at: number, grid: CandleGrid): Promise<void> {
    await Promise.all(intervals.map((interval) => this.fetch(symbol, interval, at, at + nominalMs(interval), 'all', grid).catch(() => [])))
  }

  /** How many bars are held decoded (for a test, and the curious). */
  get size(): number {
    return this.heldBars
  }

  private async midOnly(symbol: string, interval: string, from: number, to: number, grid: CandleGrid): Promise<{ bars: ReplayBar[]; coveredTo: number } | null> {
    const answer = await this.tiles.mid(symbol, interval, from, to).catch(() => null)
    if (answer === null) return null
    return { bars: answer.items.map((bar) => fromMid(interval, bar, grid)), coveredTo: answer.coveredTo }
  }

  private async withQuotes(symbol: string, interval: string, from: number, to: number, grid: CandleGrid): Promise<{ bars: ReplayBar[]; coveredTo: number } | null> {
    const [vendor, ticker] = symbol.includes(':') ? symbol.split(':', 2) : ['oanda', symbol]
    const manifest = await this.tiles.manifest(vendor, ticker, interval).catch(() => null)
    if (manifest === null) return null
    const span = tilesUpTo(manifest, from, to)
    if (span === null) return null
    const loaded = await Promise.all(span.entries.map((entry) => this.tile(manifest, entry, interval, grid)))
    // A tile that will not load sends the whole window to the server, rather than leave a hole.
    if (loaded.some((bars) => bars === null)) return null
    const last = span.entries.at(-1)
    const next = last ? manifest.tiles[manifest.tiles.indexOf(last) + 1] : undefined
    if (next) void this.tile(manifest, next, interval, grid)
    return { bars: (loaded as ReplayBar[][]).flat(), coveredTo: span.coveredTo }
  }

  /** One tile's bars with bid and ask: held, loading, or loaded now. */
  private tile(manifest: TileManifest, entry: TileEntry, interval: string, grid: CandleGrid): Promise<ReplayBar[] | null> {
    const key = `${manifest.vendor}:${manifest.symbol}:${interval}:${entry.name}`
    if (this.failed.has(key)) return Promise.resolve(null)
    const hit = this.held.get(key)
    if (hit) {
      this.held.delete(key)
      this.held.set(key, hit)
      return Promise.resolve(hit)
    }
    let pending = this.loading.get(key)
    if (!pending) {
      pending = this.tiles
        .pair(manifest, entry)
        .then((pair) => (pair === null ? null : joinQuotes(interval, pair.mid, pair.quote, grid)))
        .catch(() => null)
        .then((bars) => {
          if (bars !== null) this.hold(key, bars)
          else this.failed.add(key)
          return bars
        })
        .finally(() => this.loading.delete(key))
      this.loading.set(key, pending)
    }
    return pending
  }

  private hold(key: string, bars: ReplayBar[]): void {
    this.held.set(key, bars)
    this.heldBars += bars.length
    while (this.heldBars > this.maxBars && this.held.size > 1) {
      const [oldest, evicted] = this.held.entries().next().value as [string, ReplayBar[]]
      this.held.delete(oldest)
      this.heldBars -= evicted.length
    }
  }
}

/** A mid tile bar (wire-dated) as a `ReplayBar`, on the instrument's schedule. */
function fromMid(interval: string, bar: KLineData, grid: CandleGrid): ReplayBar {
  const open = grid.fromWire(interval, bar.timestamp)
  return { open, end: grid.end(interval, open), date: bar.timestamp, o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: bar.volume ?? 0 }
}

/** A mid tile and its quote half, row for row, as `ReplayBar`s -- or null when the two do not
 * line up (a pair from different builds), which no join can repair. */
export function joinQuotes(interval: string, mid: readonly KLineData[], quote: QuoteColumns, grid: CandleGrid): ReplayBar[] | null {
  if (quote.ts.length !== mid.length) return null
  const out: ReplayBar[] = new Array(mid.length)
  for (let i = 0; i < mid.length; i++) {
    if (quote.ts[i] !== mid[i].timestamp) return null
    const bar = fromMid(interval, mid[i], grid)
    bar.bid = { o: quote.bo[i], h: quote.bh[i], l: quote.bl[i], c: quote.bc[i] }
    bar.ask = { o: quote.ao[i], h: quote.ah[i], l: quote.al[i], c: quote.ac[i] }
    out[i] = bar
  }
  return out
}
