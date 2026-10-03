// Two caches, because the two costs are different.
//
//  1. **Cache API** holds the raw tile bytes. They survive a reload, which is the point: a
//     tile is immutable, so a browser that has fetched one never needs the network for that
//     span again. At ~4.3 bytes/bar the whole of EURUSD 1m history is ~37 MB, well inside
//     any storage quota.
//  2. **An in-memory map** holds the decoded bars, so panning across a tile boundary and
//     back does not re-parse. This one is per-page-load by design — decoded bars are ~10x
//     the size of the tile they came from, and are cheap to rebuild from (1). It is bounded
//     by bar count, least recently used out first: a weekly 5s tile is ~70k bars, so panning
//     back through months of 5s would otherwise hold every week ever decoded until reload.
//
// Storage access is wrapped throughout: `caches` is undefined on an insecure origin and
// throws outright in some privacy modes, and a chart that cannot cache must still draw.

import type { KLineData } from 'klinecharts'
import { decodeTile } from './decode'
import { type TileEntry, type TileManifest, tileUrl } from './manifest'

const CACHE_NAME = 'ohlcv-tiles-v1'

// ~14 weekly 5s tiles or ~30 monthly 1m tiles, at roughly 100 bytes a decoded bar.
const MAX_DECODED_BARS = 1_000_000

/** Decoded tiles by URL, bounded by total bar count, least recently used out first. */
export class DecodedTiles {
  // Insertion order is recency: a hit is moved to the end, and eviction takes from the front.
  private readonly tiles = new Map<string, KLineData[]>()
  private held = 0

  constructor(readonly maxBars: number) {}

  get bars(): number {
    return this.held
  }

  get(url: string): KLineData[] | undefined {
    const hit = this.tiles.get(url)
    if (hit !== undefined) this.set(url, hit)
    return hit
  }

  set(url: string, bars: KLineData[]): void {
    const previous = this.tiles.get(url)
    if (previous !== undefined) {
      this.tiles.delete(url)
      this.held -= previous.length
    }
    this.tiles.set(url, bars)
    this.held += bars.length
    // Never the entry just added: a single tile larger than the bound is still worth keeping
    // while it is the one in use.
    while (this.held > this.maxBars && this.tiles.size > 1) {
      const [oldest, evicted] = this.tiles.entries().next().value as [string, KLineData[]]
      this.tiles.delete(oldest)
      this.held -= evicted.length
    }
  }

  has(url: string): boolean {
    return this.tiles.has(url)
  }
}

const decoded = new DecodedTiles(MAX_DECODED_BARS)

const inflight = new Map<string, Promise<KLineData[] | null>>()

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
  // Read the body before caching: cache.put() consumes the response, and we need the bytes
  // in hand either way.
  const bytes = await response.arrayBuffer()
  if (cache !== null) {
    try {
      await cache.put(url, new Response(bytes.slice(0), { headers: response.headers }))
    } catch {
      // Quota exceeded, or a storage-blocked origin. The bars are already in hand.
    }
  }
  return bytes
}

async function load(manifest: TileManifest, entry: TileEntry): Promise<KLineData[] | null> {
  const url = tileUrl(manifest, entry)
  const bytes = await bytesFor(url)
  if (bytes === null) return null
  const started = performance.now()
  const bars = await decodeTile(bytes, manifest.precision)
  performance.measure?.(`tile-decode ${entry.name} (${bars.length} bars)`, { start: started })
  return bars
}

/** Bars for one tile, from memory, then the Cache API, then the network. */
export function barsForTile(
  manifest: TileManifest,
  entry: TileEntry
): Promise<KLineData[] | null> {
  const url = tileUrl(manifest, entry)
  const hit = decoded.get(url)
  if (hit !== undefined) return Promise.resolve(hit)

  let pending = inflight.get(url)
  if (pending === undefined) {
    pending = load(manifest, entry)
      .then((bars) => {
        if (bars !== null) decoded.set(url, bars)
        return bars
      })
      .finally(() => inflight.delete(url))
    inflight.set(url, pending)
  }
  return pending
}
