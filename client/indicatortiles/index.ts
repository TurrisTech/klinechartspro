// Indicator tiles: a tiered server indicator's closed partitions, read straight from the bucket.
//
// wmarketdata's `TieredSeriesStorageManager` writes them (`wmarketdata/seriestiles/`), and the
// layout is the one this module reads:
//
//   <path>/manifest.json        coverage, version, the wire shift, which year shards exist
//   <path>/tiles-<year>.json    that year's tiles: partition key, bounds, first/last row
//   <path>/<key>.parquet        one closed partition: `ts` + the indicator's own columns
//
// Every instant in those files is epoch ms on the STORE clock (the candle's open, UTC). The
// chart works on the WIRE clock, which for a daily-and-coarser interval is session-dated, so
// `wireShiftMs` from the manifest is added on the way out -- the same shift the server applies.
//
// `<path>` is not something the client can build: it carries the producer's parameters. The
// server names it in its values envelope (`tiles.path`) once a series is tiered, and until then
// every read goes to the server as it always has. Past the manifest's `coveredTo` the partition
// is still open and lives in the database, so that part of a window is always the server's.
//
// A closed tile is cached forever in the Cache API. A recompute overwrites a tile in place and a
// browser holding the old bytes may keep showing them -- accepted for these series (see
// notes/architecture/tiered-indicator-storage.md); the manifest itself is never cached.

import { parquetRead } from 'hyparquet'

export interface SeriesManifest {
  format: number
  series: string
  granularity: string
  tz: string
  wireShiftMs: number
  columns: { name: string; type: string }[]
  /** First row in any tile; store clock. */
  coveredFrom: number | null
  /** Exclusive: the tiles answer `[coveredFrom, coveredTo)` completely; store clock. */
  coveredTo: number | null
  version: number
  /** year -> tiles in that shard. */
  shards: Record<string, number>
  staleFrom: number | null
}

export interface SeriesTileEntry {
  key: string
  /** The partition's own bounds, `[start, end)`, store clock. */
  start: number
  end: number
  first: number
  last: number
  rows: number
  bytes: number
  lineage: string | null
  state: boolean
}

/** Rows in columns: `ts` on the store clock, then every other column by name. */
export interface SeriesRows {
  ts: number[]
  columns: Record<string, unknown[]>
}

/** What the server puts in a tiered series' values envelope. */
export interface TileHint {
  path: string
  /** Which point shape the tile rows become (`arev`). */
  point: string
  signalConfidence?: number
  minNeighbours?: number
}

const FORMAT = 1
/** How long a manifest read is trusted before it is asked for again. It changes when a
 * partition closes -- once a day for the finest series -- and revalidating is a 304. */
const MANIFEST_TTL_MS = 60_000
const CACHE_NAME = 'indicator-tiles-v1'
const DECODED_LIMIT = 32

let baseUrl: string | null = null
export function indicatorTilesBaseUrl(): string {
  if (baseUrl === null) {
    baseUrl = (window.INDICATOR_TILES_BASE_URL ?? `${window.location.origin}/indicator-tiles`).replace(
      /\/+$/,
      ''
    )
  }
  return baseUrl
}

/** For tests: point the module at a base and forget everything it cached. */
export function resetIndicatorTiles(base: string | null = null): void {
  baseUrl = base
  manifests.clear()
  shards.clear()
  decoded.clear()
}

const manifests = new Map<string, { at: number; value: Promise<SeriesManifest | null> }>()
const shards = new Map<string, Promise<SeriesTileEntry[] | null>>()
const decoded = new Map<string, Promise<SeriesRows | null>>()

async function json<T>(url: string): Promise<T | null> {
  const response = await fetch(url, { cache: 'no-cache' })
  if (!response.ok) return null
  return (await response.json()) as T
}

/** A series' manifest, or `null` when it has none (or one this client cannot read). */
export function manifestFor(path: string, now: number = Date.now()): Promise<SeriesManifest | null> {
  const hit = manifests.get(path)
  if (hit !== undefined && now - hit.at < MANIFEST_TTL_MS) return hit.value
  const value = json<SeriesManifest>(`${indicatorTilesBaseUrl()}/${path}/manifest.json`)
    .then((m) => (m !== null && m.format === FORMAT ? m : null))
    .catch(() => null)
  manifests.set(path, { at: now, value })
  return value
}

/** The shard years that can hold a partition overlapping `[fromMs, toMs)`. A key's shard is
 * its first four characters, and a partition keyed in one year can start in the previous one
 * (a session-dated day starts the evening before) -- so the window is widened by a year each
 * way, and a decade shard ("2020") is taken for any year up to the next shard. The same rule
 * as wmarketdata's `_years_overlapping`. */
export function shardYears(manifest: SeriesManifest, fromMs: number, toMs: number): string[] {
  const years = Object.keys(manifest.shards).sort()
  const lo = new Date(fromMs).getUTCFullYear() - 1
  const hi = new Date(toMs).getUTCFullYear() + 1
  return years.filter((year, i) => {
    const following = i + 1 < years.length ? Number(years[i + 1]) : 1e6
    return Number(year) <= hi && following > lo
  })
}

function shardFor(path: string, manifest: SeriesManifest, year: string): Promise<SeriesTileEntry[] | null> {
  const key = `${path}|${year}|${manifest.version}`
  let pending = shards.get(key)
  if (pending === undefined) {
    pending = json<{ format: number; tiles: SeriesTileEntry[] }>(`${indicatorTilesBaseUrl()}/${path}/tiles-${year}.json`)
      .then((body) => (body !== null && body.format === FORMAT ? body.tiles : null))
      .catch(() => null)
    shards.set(key, pending)
  }
  return pending
}

let cacheStore: Promise<Cache | null> | null = null
function tileCache(): Promise<Cache | null> {
  if (cacheStore === null) {
    cacheStore = (async () => {
      try {
        return typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME)
      } catch {
        return null
      }
    })()
  }
  return cacheStore
}

async function bytesFor(url: string): Promise<ArrayBuffer | null> {
  const cache = await tileCache()
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
      // quota or a storage-blocked origin: the rows are in hand either way
    }
  }
  return bytes
}

/** Every column of one tile, as numbers where they are numeric (hyparquet hands INT64 back as
 * BigInt, which no arithmetic downstream expects). */
export async function decodeSeriesTile(bytes: ArrayBuffer): Promise<SeriesRows> {
  const columns: Record<string, unknown[]> = {}
  await parquetRead({
    file: bytes,
    onChunk: (chunk: { columnName: string; columnData: ArrayLike<unknown> }) => {
      const target = columns[chunk.columnName] ?? []
      columns[chunk.columnName] = target
      for (let i = 0; i < chunk.columnData.length; i++) {
        const value = chunk.columnData[i]
        target.push(typeof value === 'bigint' ? Number(value) : value)
      }
    }
  })
  const ts = (columns.ts ?? []) as number[]
  delete columns.ts
  return { ts, columns }
}

function rowsFor(path: string, manifest: SeriesManifest, entry: SeriesTileEntry): Promise<SeriesRows | null> {
  const key = `${path}|${entry.key}|${manifest.version}`
  let pending = decoded.get(key)
  if (pending === undefined) {
    pending = bytesFor(`${indicatorTilesBaseUrl()}/${path}/${entry.key}.parquet`)
      .then((bytes) => (bytes === null ? null : decodeSeriesTile(bytes)))
      .catch(() => null)
    decoded.set(key, pending)
    while (decoded.size > DECODED_LIMIT) {
      const oldest = decoded.keys().next().value
      if (oldest === undefined) break
      decoded.delete(oldest)
    }
    // A failed read must not be remembered as the answer for the life of the page.
    void pending.then((rows) => {
      if (rows === null) decoded.delete(key)
    })
  }
  return pending
}

/**
 * Rows of `[fromMs, toMs)` (store clock) from the tiles, ascending, stopping once `limit`
 * rows are in hand. `null` when the tiles cannot answer the window in full -- a window
 * reaching past `coveredTo`, or an indexed tile that will not load -- and the caller asks the
 * server instead: a short answer here would look exactly like a gap in the data.
 */
export async function readSeries(
  path: string,
  manifest: SeriesManifest,
  fromMs: number,
  toMs: number,
  limit: number | null = null
): Promise<SeriesRows | null> {
  if (manifest.coveredTo === null || toMs > manifest.coveredTo) return null
  const out: SeriesRows = { ts: [], columns: {} }
  if (fromMs >= toMs) return out
  const entries: SeriesTileEntry[] = []
  for (const year of shardYears(manifest, fromMs, toMs)) {
    const shard = await shardFor(path, manifest, year)
    if (shard === null) return null
    for (const e of shard) if (e.end > fromMs && e.start < toMs) entries.push(e)
  }
  entries.sort((a, b) => a.start - b.start)
  for (const entry of entries) {
    const rows = await rowsFor(path, manifest, entry)
    if (rows === null) return null
    for (let i = 0; i < rows.ts.length; i++) {
      const ts = rows.ts[i]
      if (ts < fromMs || ts >= toMs) continue
      out.ts.push(ts)
      for (const [name, values] of Object.entries(rows.columns)) {
        const target = out.columns[name] ?? []
        out.columns[name] = target
        target.push(values[i])
      }
      if (limit !== null && out.ts.length >= limit) return out
    }
  }
  return out
}

declare global {
  interface Window {
    INDICATOR_TILES_BASE_URL?: string
  }
}
