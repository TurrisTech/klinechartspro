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
import type { BookBucket, BookKind, BookNearPoint, BookProfilePoint, BookTotalsPoint } from './api'

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

let baseUrl: string | null = null
export function bookTilesBaseUrl(): string {
  if (baseUrl === null) {
    // The same origin and the same nginx route as the bar tiles, under their own layout
    // prefix -- one bucket, one proxy, one cache policy. `BOOK_TILES_BASE_URL` exists for
    // a dev server serving a locally built tree.
    const root = window.BOOK_TILES_BASE_URL ?? `${window.location.origin}/tiles`
    baseUrl = `${root.replace(/\/+$/, '')}/books`
  }
  return baseUrl
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
    const response = await fetch(`${seriesUrl(kind, vendor, symbol, interval)}/manifest.json`)
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

/**
 * Tiles answering as much of `[from, to)` as tiled history reaches, in order.
 *
 * Null means tiles can contribute nothing and the caller should fetch the whole window.
 * A non-null answer may stop short of `to`, at `coveredTo` -- which is a *period*
 * boundary, never the last point. Splitting at the last point instead would hand the API
 * a range starting inside an already-tiled period, and the join would serve every point
 * between twice.
 *
 * `to` is exclusive, matching `/getbars` and the plugin routes.
 */
export function tilesUpTo(
  manifest: BookTileManifest,
  from: number,
  to: number
): { entries: BookTileEntry[]; coveredTo: number } | null {
  if (from >= manifest.coveredTo) return null
  const end = Math.min(to, manifest.coveredTo)
  const entries = manifest.tiles.filter((t) => t.to >= from && t.from < end)
  if (entries.length > 0) return { entries, coveredTo: manifest.coveredTo }
  // No tile overlaps. Inside the covered window that is a real answer -- a weekend, a
  // holiday, an outage the books have no snapshot for -- and returning null would send
  // every such probe to the API for a range the tiles have already settled.
  return from >= manifest.coveredFrom ? { entries: [], coveredTo: manifest.coveredTo } : null
}

// -- bytes -------------------------------------------------------------------------------

let store: Promise<Cache | null> | null = null

function cacheStore(): Promise<Cache | null> {
  if (store === null) {
    store = (async () => {
      try {
        return typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME)
      } catch {
        return null
      }
    })()
  }
  return store
}

async function bytesFor(url: string): Promise<ArrayBuffer | null> {
  const cache = await cacheStore()
  if (cache !== null) {
    try {
      const hit = await cache.match(url)
      if (hit !== undefined) return await hit.arrayBuffer()
    } catch {
      // fall through to the network
    }
  }
  const response = await fetch(url)
  if (!response.ok) return null
  const bytes = await response.arrayBuffer()
  if (cache !== null) {
    try {
      await cache.put(url, new Response(bytes.slice(0), { headers: response.headers }))
    } catch {
      // Quota exceeded or a storage-blocked origin; the bytes are already in hand.
    }
  }
  return bytes
}

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

const decoded = new Map<string, unknown[]>()
const inflight = new Map<string, Promise<unknown[] | null>>()

function once<T>(url: string, load: () => Promise<T[] | null>): Promise<T[] | null> {
  const hit = decoded.get(url)
  if (hit !== undefined) return Promise.resolve(hit as T[])
  let pending = inflight.get(url)
  if (pending === undefined) {
    pending = load()
      .then((rows) => {
        if (rows !== null) decoded.set(url, rows)
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
  })
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
  })
}

// -- the public read -------------------------------------------------------------------------

export interface TiledPoints<P> {
  points: P[]
  /** Exclusive instant the tiles run to; `[coveredTo, to)` is the caller's to fetch. */
  coveredTo: number
}

/** Which metrics tiles can answer. `near` is a sum over a radius the tile does not carry,
 * so it stays on the API -- and says so here rather than failing quietly somewhere. */
export type TiledMetric = 'totals' | 'profile'

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
): Promise<TiledPoints<P> | null> {
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
  return { points, coveredTo: span.coveredTo }
}

/** Test seam: the manifest and decoded-tile caches are per page load by design. */
export function resetBookTileCaches(): void {
  manifests.clear()
  decoded.clear()
  inflight.clear()
  store = null
  baseUrl = null
}

export type { BookNearPoint }

declare global {
  interface Window {
    BOOK_TILES_BASE_URL?: string
  }
}
