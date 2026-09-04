// The tile index.
//
// A *tile* is a small immutable Parquet file holding one calendar period of bars, written by
// wmarketdata's `bin/build_chart_tiles.py`. The manifest is the mutable index that names
// them — it is the only thing the client must not cache, because it is how a new tile
// becomes visible. See that script's docstring for the format and why it exists.

// Resolved on first use rather than at module load: the pure functions here (coverage
// arithmetic) are unit-tested outside a DOM, where touching `window` at import time
// would throw before any test ran.
let baseUrl: string | null = null
export function tilesBaseUrl(): string {
  if (baseUrl === null) {
    baseUrl = (window.TILES_BASE_URL ?? `${window.location.origin}/tiles`).replace(/\/+$/, '')
  }
  return baseUrl
}

/** The tile layout this client reads. Bumped v1 -> v2 when the builder moved candles from
 * calendar filing to canonical-date filing: a closed tile is served `immutable` for a year,
 * so refiling had to change the URL rather than the bytes under a cached one. Exported so a
 * test probing the store cannot drift from what the client actually requests. */
export const LAYOUT_VERSION = 'v2'

export interface TileEntry {
  name: string
  /** First bar's wire timestamp, epoch ms — already session-shifted where that applies. */
  from: number
  /** Last bar's wire timestamp, epoch ms. Inclusive. */
  to: number
  rows: number
  bytes: number
}

export interface TileManifest {
  vendor: string
  symbol: string
  interval: string
  /** Every period length the builder emits (`GRANULARITY` in build_chart_tiles.py).
   * `quarter` was missing here while 2h/4h/8h have been quarter-granular all along — the
   * field is only ever read back off a JSON cast, so nothing caught it. */
  granularity: 'week' | 'month' | 'quarter' | 'year' | '5y' | 'all'
  /** Prices in a tile are integers scaled by 10**precision. */
  precision: number
  sessionDated: boolean
  /** The instrument's own timezone, and which trading week it keeps. Published because a
   * DERIVED timeframe is folded out of these tiles by the reader (`derive.ts`), and every
   * candle boundary in that fold is a wall clock in `tz` -- a continuous (crypto) schedule
   * buckets on calendar boundaries instead, and this client's boundary port implements only
   * the FX week. Both are absent on a manifest written before the fold existed, which reads
   * as "do not fold": the base tiles still serve their own interval, and a derived one falls
   * back to /getbars until the tree is next built. */
  tz?: string
  schedule?: 'fx-week' | 'continuous' | 'session'
  /** The schedule's DAY, as the two offsets every candle boundary is built from: hours from
   * the midnight that dates a session to that day's open and close, and whether every
   * calendar day is a market day. Forex is (-7, 17), crypto (0, 24, everyDay), US equities
   * (9, 16) -- a 09:00 anchor on a market that opens at 09:30. Carried as numbers rather
   * than as an asset-class name so a market with another anchor needs no client change. */
  day?: { open: number; close: number; everyDay: boolean }
  /** Half-open window [coveredFrom, coveredTo) these tiles answer in full. */
  coveredFrom: number
  coveredTo: number
  tiles: TileEntry[]
}

// One in-flight promise per series, not one per call: a 12-pane wall asks for the same
// manifest a dozen times within a frame of the cold load.
const cache = new Map<string, Promise<TileManifest | null>>()

function key(vendor: string, symbol: string, interval: string): string {
  return `${vendor}:${symbol}:${interval}`
}

export function tileUrl(manifest: TileManifest, entry: TileEntry): string {
  const { vendor, symbol, interval } = manifest
  return `${tilesBaseUrl()}/${LAYOUT_VERSION}/${vendor}/${symbol}/${interval}/${entry.name}`
}

async function load(vendor: string, symbol: string, interval: string): Promise<TileManifest | null> {
  const url = `${tilesBaseUrl()}/${LAYOUT_VERSION}/${vendor}/${symbol}/${interval}/manifest.json`
  try {
    const response = await fetch(url)
    // A series with no tiles is the normal case for most symbols, not an error: the caller
    // falls back to /getbars, which serves every interval for every symbol regardless.
    if (!response.ok) return null
    const body = (await response.json()) as TileManifest
    if (!Array.isArray(body?.tiles) || typeof body?.precision !== 'number') return null
    return body
  } catch {
    return null
  }
}

export function manifestFor(
  vendor: string,
  symbol: string,
  interval: string
): Promise<TileManifest | null> {
  const id = key(vendor, symbol, interval)
  let pending = cache.get(id)
  if (pending === undefined) {
    pending = load(vendor, symbol, interval)
    cache.set(id, pending)
  }
  return pending
}

/**
 * Tiles answering as much of `[from, to]` as the tiled history reaches, in order.
 *
 * Tiles hold every closed calendar period, so they answer any historical window in full.
 * What they never hold is the *current, unfinished* period — the caller takes that from
 * `/getbars` and joins it on, which is why this returns the boundary alongside the tiles
 * rather than refusing a window that crosses it.
 *
 * Null means tiles can contribute nothing: no manifest overlap, or a window that lies
 * entirely inside the unfinished period.
 *
 * Neither edge is clamped to a bar timestamp. `coveredTo` is the *period* boundary, and the
 * split has to happen there: splitting at the last bar instead would hand the API a range
 * starting inside an already-tiled period, and the join would double-count every bar
 * between that bar and the period end.
 *
 * `to` is **exclusive**, matching `/getbars` — a bar stamped exactly `to` belongs to the next
 * window. Getting this wrong is invisible in any check that only asks whether the API's bars
 * are present in the tiles: the tiles simply carry one bar more than the API would return.
 */
export function tilesUpTo(
  manifest: TileManifest,
  from: number,
  to: number
): { entries: TileEntry[]; coveredTo: number } | null {
  if (from >= manifest.coveredTo) return null
  const tileEnd = Math.min(to, manifest.coveredTo)
  const entries = manifest.tiles.filter((t) => t.to >= from && t.from < tileEnd)
  if (entries.length > 0) return { entries, coveredTo: manifest.coveredTo }
  // No tile overlaps the window. That is "tiles cannot help" only when the window reaches
  // outside their coverage -- INSIDE it the tiles are the whole answer, and the answer is
  // that there are no bars. Almost every such window is a market gap: a request landing in
  // the FX weekend, which is two days out of every seven and which the pagination widener
  // probes constantly while panning through history. Returning null there sent each probe
  // to /getbars for a range the tiles had already settled, and the API agreed with them
  // every time (`no_data`). `coveredFrom` is published for exactly this and was never read.
  return from >= manifest.coveredFrom ? { entries: [], coveredTo: manifest.coveredTo } : null
}

declare global {
  interface Window {
    TILES_BASE_URL?: string
  }
}
