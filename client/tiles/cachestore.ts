// What the three tile families share -- the chart's bars (tiles/), the OANDA books
// (books/tiles.ts) and the stored indicators (indicatortiles/): the Cache Storage holding a
// tile's raw bytes across reloads, and where a family's bucket is. Each used to carry its own
// copy of both.
//
// A tile is immutable, so a browser that has fetched one never needs the network for that span
// again. Storage access is wrapped throughout: `caches` is undefined on an insecure origin and
// throws outright in some privacy modes, and a chart that cannot cache must still draw.

/** Reads a tile's bytes through the named cache: the cache first, the network otherwise, and
 * what the network returns is put in the cache. Null when the network answers non-OK. */
export function tileBytes(cacheName: string): (url: string) => Promise<ArrayBuffer | null> {
  let store: Promise<Cache | null> | null = null
  const open = (): Promise<Cache | null> => {
    store ??= (async () => {
      try {
        return typeof caches === 'undefined' ? null : await caches.open(cacheName)
      } catch {
        return null
      }
    })()
    return store
  }
  return async (url) => {
    const cache = await open()
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
    // Read the body before caching: cache.put() consumes the response, and the bytes are
    // needed in hand either way.
    const bytes = await response.arrayBuffer()
    if (cache !== null) {
      try {
        await cache.put(url, new Response(bytes.slice(0), { headers: response.headers }))
      } catch {
        // Quota exceeded, or a storage-blocked origin. The bytes are already in hand.
      }
    }
    return bytes
  }
}

/** A family's bucket base URL, resolved on first use rather than at module load -- the pure
 * functions beside it are unit-tested outside a DOM, where touching `window` at import would
 * throw before any test ran. Trailing slashes are dropped. */
export function bucketBase(resolve: () => string): { get(): string; set(base: string | null): void } {
  let base: string | null = null
  return {
    get: () => {
      base ??= resolve().replace(/\/+$/, '')
      return base
    },
    set: (next) => {
      base = next === null ? null : next.replace(/\/+$/, '')
    }
  }
}
