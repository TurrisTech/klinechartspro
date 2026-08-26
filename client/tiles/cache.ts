// Two caches, because the two costs are different.
//
//  1. **Cache API** holds the raw tile bytes. They survive a reload, which is the point: a
//     tile is immutable, so a browser that has fetched one never needs the network for that
//     span again. At ~4.3 bytes/bar the whole of EURUSD 1m history is ~37 MB, well inside
//     any storage quota.
//  2. **An in-memory map** holds the decoded bars, so panning across a tile boundary and
//     back does not re-parse. This one is per-page-load by design — decoded bars are ~10x
//     the size of the tile they came from, and are cheap to rebuild from (1).
//
// Storage access is wrapped throughout: `caches` is undefined on an insecure origin and
// throws outright in some privacy modes, and a chart that cannot cache must still draw.

import type { KLineData } from 'klinecharts'
import { decodeTile } from './decode'
import { type TileEntry, type TileManifest, tileUrl } from './manifest'

const CACHE_NAME = 'ohlcv-tiles-v1'

const decoded = new Map<string, KLineData[]>()
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
