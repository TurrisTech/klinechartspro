// Book points from tiles.
//
// The mirror of `client/tiles/` for the books: immutable Parquet the browser fetches once
// and caches forever, written by wmarketdata's `bin/build_book_tiles.py`. Read that
// script's docstring for the format; what matters here is the shape of the answer.
//
// A book tile is **per interval** and holds the snapshot each *bar* serves, already
// selected: the newest instant knowable by the bar's close, gap fallback walked,
// consecutive repeats dropped. So this module does no session arithmetic and no
// knowability arithmetic -- it decodes and trims a window. That is deliberate. The rules
// live once, in `wmarketdata.apps.bookclock`, where the builder and the server plugin
// both read them; a second copy over here would drift and the drift would be invisible,
// because both would draw *a* book on every bar.
//
// Two files per period, because two panes want different things: `.s` is one row per
// served snapshot (the sentiment pane's whole answer, ~2 KiB a month) and `.p` is one row
// per bucket within +/-40 of the price (the depth overlay and hover viewer, ~100 KiB a
// month). A pane fetches only its own.
//
// What tiles cannot answer stays on the API and that is not a fallback so much as a
// division: the still-forming period, and the `near` metric at any radius, which is a sum
// over a window the tile does not carry.

import { parquetRead } from 'hyparquet'
import { objectStoreFetch } from '../objectstore'
import { bucketBase, tileBytes } from '../tiles/cachestore'
import type { Tiled } from '../tiles/join'
import { tilesUpTo } from '../tiles/manifest'
import type { BookBucket, BookKind, BookProfilePoint, BookTotalsPoint } from './api'

/** Bumped when the tile layout changes: a closed tile is served `immutable` for a year, so
 * refiling has to change the URL rather than the bytes under a cached one. */
export const LAYOUT_VERSION = 'v1'

const CACHE_NAME = 'book-tiles-v1'

export interface BookTileEntry {
  name: string
  /** First and last `date` in the tile -- the wire clock, already session-shifted where
   * that applies, so these compare directly against a chart's window. Inclusive. */
  from: number
  to: number
  rows: number
  bytes: number
  profileRows: number
  profileBytes: number
}

export interface BookTileManifest {
  kind: BookKind
  vendor: string
  symbol: string
  interval: string
  granularity: 'week' | 'month' | 'quarter' | 'year'
  /** Prices and widths are integers scaled by 10**priceScale; percentages by 10**pctScale. */
  priceScale: number
  pctScale: number
  /** Buckets either side of the price the profile file carries. */
  depth: number
  gridMs: number
  knowableMs: number
  sessionDated: boolean
  /** Half-open window [coveredFrom, coveredTo) these tiles answer in full. */
  coveredFrom: number
  coveredTo: number
  tiles: BookTileEntry[]
}

const base = bucketBase(() => `${(window.BOOK_TILES_BASE_URL ?? `${window.location.origin}/tiles`).replace(/\/+$/, '')}/books`)
function bookTilesBaseUrl(): string {
  return base.get()
}

function seriesUrl(kind: string, vendor: string, symbol: string, interval: string): string {
  return `${bookTilesBaseUrl()}/${LAYOUT_VERSION}/${kind}/${vendor}/${symbol}/${interval}`
}

const manifests = new Map<string, Promise<BookTileManifest | null>>()

async function loadManifest(
  kind: BookKind,
  vendor: string,
  symbol: string,
  interval: string
): Promise<BookTileManifest | null> {
  try {
    const response = await objectStoreFetch(`${seriesUrl(kind, vendor, symbol, interval)}/manifest.json`)
    // No manifest is the normal case for a series nobody has tiled, not an error: the
    // caller reads the API, which answers every series regardless.
    if (!response.ok) return null
    const body = (await response.json()) as BookTileManifest
    if (!Array.isArray(body?.tiles) || typeof body?.pctScale !== 'number') return null
    return body
  } catch {
    return null
  }
}

export function manifestFor(
  kind: BookKind,
  vendor: string,
  symbol: string,
  interval: string
): Promise<BookTileManifest | null> {
  const id = `${kind}:${vendor}:${symbol}:${interval}`
  let pending = manifests.get(id)
  if (pending === undefined) {
    pending = loadManifest(kind, vendor, symbol, interval)
    manifests.set(id, pending)
  }
  return pending
}

// -- bytes -------------------------------------------------------------------------------

const bytesFor = tileBytes(CACHE_NAME)

async function columns(url: string, names: string[]): Promise<Record<string, number[]> | null> {
  const bytes = await bytesFor(url)
  if (bytes === null) return null
  const out: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]))
  await parquetRead({
    file: bytes,
    columns: names,
    onChunk: (chunk: { columnName: string; columnData: ArrayLike<unknown> }) => {
      const target = out[chunk.columnName]
      if (target === undefined) return
      for (let i = 0; i < chunk.columnData.length; i++) target.push(Number(chunk.columnData[i]))
    }
  })
  return out
}

// -- decoding one tile into points ---------------------------------------------------------

/** How much decoded book a page holds, in values: a row, and each bucket a profile row carries. A
 * profile tile is 370-730 served snapshots of ~80 buckets (30-60k values; a totals tile under a
 * thousand), and a pane's 500-bar window spans one to three tiles of its interval, so this holds
 * two tiles of profile for each of eight panes at once -- at ~70 bytes a value, the same order as
 * the bar tiles' bound (tiles/cache.ts). What goes is decoded again from the Cache API's bytes,
 * never fetched again; and what a pane shows of a tile held costs little more, as its store holds
 * the same point objects. */
const MAX_DECODED_VALUES = 1_000_000

interface HeldTile {
  rows: unknown[]
  weight: number
}

/** Decoded tiles by URL, under a budget of values, least recently used out first -- the bar
 * tiles' `DecodedTiles` (tiles/cache.ts), counted by what a book row carries rather than by rows,
 * as a profile row holds ~80 buckets and a totals row none. Until 2026-11-28 this was a plain map
 * nothing ever cleared, so every tile a page read stayed decoded until reload. Exported for its
 * test. */
export class DecodedBookTiles {
  // Insertion order is recency: a hit is moved to the end, and eviction takes from the front.
  private readonly tiles = new Map<string, HeldTile>()
  private held = 0

  constructor(readonly maxValues: number) {}

  /** The values held. */
  get values(): number {
    return this.held
  }

  get(url: string): unknown[] | undefined {
    const hit = this.tiles.get(url)
    if (hit === undefined) return undefined
    this.tiles.delete(url)
    this.tiles.set(url, hit)
    return hit.rows
  }

  /** Hold `rows`, counted as `weight` values. */
  set(url: string, rows: unknown[], weight: number): void {
    const previous = this.tiles.get(url)
    if (previous !== undefined) {
      this.tiles.delete(url)
      this.held -= previous.weight
    }
    this.tiles.set(url, { rows, weight })
    this.held += weight
    // Never the tile just held: one larger than the budget is still worth keeping while it is the
    // one in use.
    while (this.held > this.maxValues && this.tiles.size > 1) {
      const [oldest, evicted] = this.tiles.entries().next().value as [string, HeldTile]
      this.tiles.delete(oldest)
      this.held -= evicted.weight
    }
  }

  clear(): void {
    this.tiles.clear()
    this.held = 0
  }
}

const decoded = new DecodedBookTiles(MAX_DECODED_VALUES)
const inflight = new Map<string, Promise<unknown[] | null>>()

/** A tile's rows, decoded once and held while the budget allows; `weigh` counts their values. */
function once<T>(
  url: string,
  load: () => Promise<T[] | null>,
  weigh: (rows: T[]) => number
): Promise<T[] | null> {
  const hit = decoded.get(url)
  if (hit !== undefined) return Promise.resolve(hit as T[])
  let pending = inflight.get(url)
  if (pending === undefined) {
    pending = load()
      .then((rows) => {
        if (rows !== null) decoded.set(url, rows, weigh(rows))
        return rows as unknown[] | null
      })
      .finally(() => inflight.delete(url))
    inflight.set(url, pending)
  }
  return pending as Promise<T[] | null>
}

async function totalsOf(
  manifest: BookTileManifest,
  entry: BookTileEntry
): Promise<BookTotalsPoint[] | null> {
  const url = `${seriesUrl(manifest.kind, manifest.vendor, manifest.symbol, manifest.interval)}/${entry.name}.s.parquet`
  return once(url, async () => {
    const cols = await columns(url, ['date', 'ts', 'l', 's'])
    if (cols === null) return null
    const pct = 10 ** manifest.pctScale
    return cols.date.map((date, i) => ({
      date,
      ts: cols.ts[i],
      long: cols.l[i] / pct,
      short: cols.s[i] / pct
    }))
  }, (rows) => rows.length)
}

async function profilesOf(
  manifest: BookTileManifest,
  entry: BookTileEntry
): Promise<BookProfilePoint[] | null> {
  const series = seriesUrl(manifest.kind, manifest.vendor, manifest.symbol, manifest.interval)
  const url = `${series}/${entry.name}.p.parquet`
  return once(url, async () => {
    const [head, body] = await Promise.all([
      columns(`${series}/${entry.name}.s.parquet`, ['date', 'ts', 'p', 'w']),
      columns(url, ['ts', 'n', 'l', 's'])
    ])
    if (head === null || body === null) return null
    const price = 10 ** manifest.priceScale
    const pct = 10 ** manifest.pctScale
    // The bucket rows are grouped by snapshot and ordered within it (the builder's ORDER
    // BY), so one forward walk pairs them with their snapshot without a sort.
    const buckets = new Map<number, BookBucket[]>()
    for (let i = 0; i < body.ts.length; i++) {
      let list = buckets.get(body.ts[i])
      if (list === undefined) {
        list = []
        buckets.set(body.ts[i], list)
      }
      // `n` is the bucket's index on the vendor's own grid, so the price is n*width
      // exactly -- never the snapshot price plus an offset, which the snapshot price is
      // not aligned to.
      list.push([(body.n[i] * head.w[0]) / price, body.l[i] / pct, body.s[i] / pct])
    }
    return head.date.map((date, i) => ({
      date,
      ts: head.ts[i],
      price: head.p[i] / price,
      width: head.w[i] / price,
      buckets: buckets.get(head.ts[i]) ?? []
    }))
  }, (rows) => rows.reduce((values, row) => values + 1 + row.buckets.length, 0))
}

// -- the public read -------------------------------------------------------------------------

/** Which metrics tiles can answer. `near` is a sum over a radius the tile does not carry,
 * so it stays on the API -- and says so here rather than failing quietly somewhere. */
type TiledMetric = 'totals' | 'profile'

export function isTiledMetric(metric: string): metric is TiledMetric {
  return metric === 'totals' || metric === 'profile'
}

/**
 * Book points from tiles for as much of `[from, to)` as tiled history reaches.
 *
 * Null means tiles can contribute nothing to this window -- never "no data".
 */
export async function pointsFromTiles<P extends BookTotalsPoint | BookProfilePoint>(
  metric: TiledMetric,
  kind: BookKind,
  vendor: string,
  symbol: string,
  interval: string,
  from: number,
  to: number
): Promise<Tiled<P> | null> {
  const manifest = await manifestFor(kind, vendor, symbol, interval)
  if (manifest === null) return null
  const span = tilesUpTo(manifest, from, to)
  if (span === null) return null

  const loaded = await Promise.all(
    span.entries.map((entry) =>
      metric === 'totals' ? totalsOf(manifest, entry) : profilesOf(manifest, entry)
    )
  )
  // A tile that will not load is not a gap to paper over: fall back for the whole window
  // rather than return a series with a hole in the middle of it.
  if (loaded.some((rows) => rows === null)) return null

  const end = Math.min(to, span.coveredTo)
  const points: P[] = []
  for (const rows of loaded) {
    for (const point of rows as P[]) {
      if (point.date >= from && point.date < end) points.push(point)
    }
  }
  return { items: points, coveredTo: span.coveredTo }
}

/** Test seam: the manifests and the decoded tiles are held per page load by design (the decoded
 * ones under `MAX_DECODED_VALUES`). */
export function resetBookTileCaches(): void {
  manifests.clear()
  decoded.clear()
  inflight.clear()
  base.set(null)
}

declare global {
  interface Window {
    BOOK_TILES_BASE_URL?: string
  }
}
