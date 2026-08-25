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

const LAYOUT_VERSION = 'v1'

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
  granularity: 'week' | 'month' | '5y' | 'all'
  /** Prices in a tile are integers scaled by 10**precision. */
  precision: number
  sessionDated: boolean
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
 * Tiles overlapping `[from, to]`, in order, or null if they do not cover the whole window.
 *
 * Partial coverage deliberately yields null rather than a partial answer. Tiles stop at the
 * last closed period, so any window touching the live edge is only partly tiled — and a
 * caller handed those bars would render a chart that silently ends early. /getbars covers
 * the whole window instead.
 *
 * The right edge is checked against `coveredTo` — the *period* boundary — and not against
 * the last bar's timestamp. Those differ, and the difference is the whole bug: comparing
 * against the last bar is vacuously true for any window reaching past it, which served a
 * seam-straddling window from tiles alone and dropped every bar after the seam.
 *
 * The left edge needs no check. `coveredFrom` is where the series itself begins, so a
 * window starting earlier is asking for bars that do not exist in any source — the chart
 * requests a fixed bar count, which at 1m reaches back further than some series go.
 */
export function tilesCovering(
  manifest: TileManifest,
  from: number,
  to: number
): TileEntry[] | null {
  if (!(to < manifest.coveredTo)) return null
  const hits = manifest.tiles.filter((t) => t.to >= from && t.from <= to)
  return hits.length > 0 ? hits : null
}

declare global {
  interface Window {
    TILES_BASE_URL?: string
  }
}
