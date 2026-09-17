// The dev server's `/tiles/*` route (client/serve.ts), kept out of that file so the decisions
// in it -- where tiles come from, which paths are allowed, which headers go back -- can be
// tested without binding a port. serve.ts cannot be imported by a test: loading it starts
// the server.
//
// Both tile families go through this one route: the bar tiles under `v2/...` and the book
// tiles under `books/v1/...`. The client never names a bucket; `/tiles/<path>` is all it asks
// for, deployed and here alike.
//
// Three sources, chosen once at startup from the environment:
//
//  - `TILES_UPSTREAM` -- an HTTP base URL of a tiles bucket, e.g.
//    `http://127.0.0.1:18493/marketdata-tiles-dev` over
//    `kubectl -n seaweedfs port-forward svc/seaweedfs-s3 18493:8333`. `/tiles/<path>` is
//    proxied to `<TILES_UPSTREAM>/<path>`, which is exactly what client/nginx.conf does in
//    the cluster.
//  - `TILES_ROOT` -- a local directory laid out like the bucket. For fixtures and hand-built
//    trees only; there is deliberately no default, because the directory that default used to
//    name (`/mnt/d/marketdata/dev/tiles`) is a damaged, ephemeral volume being retired.
//  - neither -- every `/tiles/*` answers 404, which the client already treats as "no tiles
//    for this window" and falls back to /getbars for.
//
// If both are set the upstream wins: it is the real data.

export type TileSource =
  | { kind: 'upstream'; base: string }
  | { kind: 'root'; root: string }
  | { kind: 'none' }

type Env = Record<string, string | undefined>
type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** The tile source the environment asks for. Throws on an unusable `TILES_UPSTREAM`, so a
 * typo fails the server at startup instead of turning every tile into a 502. */
export function tileSourceFromEnv(env: Env): TileSource {
  const upstream = env.TILES_UPSTREAM?.trim()
  if (upstream) {
    let url: URL
    try {
      url = new URL(upstream)
    } catch {
      throw new Error(`TILES_UPSTREAM is not a URL: ${upstream}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`TILES_UPSTREAM must be http(s), got ${url.protocol} (${upstream})`)
    }
    if (url.search || url.hash) {
      throw new Error(`TILES_UPSTREAM must be a bare base URL, no ?query or #hash: ${upstream}`)
    }
    return { kind: 'upstream', base: upstream.replace(/\/+$/, '') }
  }
  const root = env.TILES_ROOT?.trim()
  if (root) return { kind: 'root', root: root.replace(/\/+$/, '') }
  return { kind: 'none' }
}

/** One line for the startup log saying where tiles will come from. */
export function describeTileSource(source: TileSource, env: Env = {}): string {
  switch (source.kind) {
    case 'upstream': {
      const ignored = env.TILES_ROOT?.trim() ? ' (TILES_ROOT ignored: TILES_UPSTREAM wins)' : ''
      return `tiles proxied from ${source.base}${ignored}`
    }
    case 'root':
      return `tiles served from local directory ${source.root}`
    case 'none':
      return (
        'tiles disabled: /tiles/* answers 404 and the client reads /getbars ' +
        '(set TILES_UPSTREAM to a tiles bucket URL to enable)'
      )
  }
}

/** The path below `/tiles/` as segments, or null for one that must not be served.
 *
 * Decoded BEFORE it is split, so an encoded `%2F..%2F` becomes real segments and is caught
 * here rather than decoded again further along. Both sources need the same refusal: the
 * directory is read by raw path, and the upstream base path must not be escaped either --
 * `..` against the gateway would leave the bucket, and an empty path would ask it for a
 * listing. */
export function tileSegments(pathname: string): string[] | null {
  // A request URL is normalised before it gets here, so `/tiles/../x` arrives as `/x`; anything
  // not still under /tiles/ is refused rather than served from the root of the source.
  if (!pathname.startsWith('/tiles/')) return null
  let rest: string
  try {
    rest = decodeURIComponent(pathname.slice('/tiles/'.length))
  } catch {
    return null
  }
  const segments = rest.split('/')
  const bad = (segment: string) =>
    segment === '' || segment === '.' || segment === '..' || segment.includes('\0')
  return segments.some(bad) ? null : segments
}

/** Where a proxied tile is fetched from. Every segment is re-encoded, so nothing in one --
 * `?`, `#`, a decoded `/` -- can add a query (an S3 sub-resource such as `?acl`) or a path
 * level the base does not already have. */
export function upstreamTileUrl(base: string, segments: string[]): string {
  return `${base}/${segments.map(encodeURIComponent).join('/')}`
}

/** Content type and cache policy for a tile served from a local directory: the same split
 * wmarketdata's tile publisher (`tiles/publish.py` `object_headers`) sets on each object at
 * upload, so a local tree answers the way the bucket would.
 *
 * Tiles are immutable by construction -- build_chart_tiles.py (bars) and build_book_tiles.py
 * (books) only write a period once the source holds a row at or past its end, and everything
 * still growing is content-addressed -- so they get a year of `immutable`, which is what makes
 * a scroll-back cost no network at all. The manifest is the mutable index that points at
 * them, so it must never be cached: it is how the client learns that a new tile exists. */
export function localTileHeaders(segments: string[]): Record<string, string> {
  const manifest = segments[segments.length - 1].endsWith('.json')
  return {
    'content-type': manifest ? 'application/json' : 'application/vnd.apache.parquet',
    'cache-control': manifest ? 'no-cache' : 'public, max-age=31536000, immutable',
    // Parquet is already Snappy-compressed internally; gzipping it again costs CPU at both
    // ends for ~2% (129.4 KB snappy vs 127.0 KB gzipped).
    'content-encoding': 'identity'
  }
}

// Only what a conditional or partial read needs. Not the browser's whole header set: a
// cookie or an Authorization for localhost has no business reaching the object store, and
// Accept-Encoding is the fetch engine's to negotiate since it decodes the body itself.
const FORWARDED_REQUEST_HEADERS = ['range', 'if-range', 'if-none-match', 'if-modified-since']

/** Headers sent back for a proxied tile.
 *
 * Content-Type and Cache-Control pass through untouched, as client/nginx.conf passes them:
 * the bucket carries them per object (no-cache for a manifest, a year `immutable` for a tile),
 * and overriding them here would let dev behave differently from the deployed chart -- the
 * one place able to hide a publish that forgot them.
 *
 * Content-Encoding and Content-Length are dropped because the fetch engine transparently
 * decodes the upstream body, so they would describe a payload that no longer exists (the same
 * trap serve.ts's /ohlcv proxy documents). Hop-by-hop headers are the connection's, not the
 * object's. */
export function proxiedTileHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream)
  for (const name of [
    'content-encoding',
    'content-length',
    'connection',
    'keep-alive',
    'transfer-encoding'
  ]) {
    headers.delete(name)
  }
  return headers
}

function isBodyless(method: string, status: number): boolean {
  return method === 'HEAD' || status === 204 || status === 304
}

/** The `/tiles/*` handler for one source. `fetchImpl` is injectable for tests only. */
export function tileHandler(
  source: TileSource,
  fetchImpl: Fetch = fetch
): (req: Request) => Promise<Response> {
  return async (req) => {
    // A missing tile is a real answer, not an error: the client fetches /getbars for any
    // window the tiles do not cover. It must be a 404 and never the SPA's index.html.
    if (source.kind === 'none') return new Response('tiles disabled', { status: 404 })

    // Read-only. Nothing a browser asks of a tile writes, and a gateway that accepts an
    // anonymous PUT must never be reachable for one through this proxy.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('tiles are read-only', { status: 405, headers: { allow: 'GET, HEAD' } })
    }

    const segments = tileSegments(new URL(req.url).pathname)
    if (segments === null) return new Response('bad tile path', { status: 400 })

    if (source.kind === 'root') {
      const file = Bun.file(`${source.root}/${segments.join('/')}`)
      if (!(await file.exists())) return new Response('no such tile', { status: 404 })
      return new Response(req.method === 'HEAD' ? null : file, {
        headers: localTileHeaders(segments)
      })
    }

    const target = upstreamTileUrl(source.base, segments)
    const forwarded = new Headers()
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers.get(name)
      if (value !== null) forwarded.set(name, value)
    }
    try {
      const response = await fetchImpl(target, {
        method: req.method,
        headers: forwarded,
        redirect: 'manual'
      })
      return new Response(isBodyless(req.method, response.status) ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: proxiedTileHeaders(response.headers)
      })
    } catch (err) {
      console.error(`[tiles] ${req.method} ${target} failed:`, err)
      return new Response(`dev proxy could not reach ${source.base}`, { status: 502 })
    }
  }
}
