// Local dev server for the client.
//
// Two things the `bun --hot client/index.html` CLI form cannot do, which is why this is an
// explicit Bun.serve:
//
//  1. **Bind a reachable address.** The CLI form only ever listens on loopback, which is
//     unreachable from outside the container. `hostname` here is real config.
//  2. **Serve the API same-origin.** wdashboard-server's CORS allowlist is
//     `https://wdashboard.turris.app` (ohlcv.py CORS_ALLOW_ORIGINS) — it does not include
//     any localhost origin, so a browser on http://localhost:PORT is refused every
//     /ohlcv/* fetch. Proxying /ohlcv through this server makes the API same-origin, which
//     is also exactly how it is served in production (client at `/`, API at `/ohlcv` on the
//     same host). So the dev topology matches the deployed one instead of needing a
//     CORS-only code path.
import index from './index.html'

// Where build_chart_tiles.py (wmarketdata) wrote its output. Serving these here is a
// stand-in for the object store they will eventually live in: the bytes and the cache
// headers are the same either way, so the client path does not change when they move.
const TILES_ROOT = (process.env.TILES_ROOT ?? '/mnt/d/marketdata/tiles').replace(/\/+$/, '')

const PORT = Number(process.env.CLIENT_PORT ?? process.env.PORT0 ?? process.env.PORT ?? 3000)

// The upstream the /ohlcv proxy forwards to. Origin only — the /ohlcv prefix is preserved
// from the incoming request path.
const UPSTREAM = (process.env.OHLCV_UPSTREAM ?? 'https://wdashboard.dev.turris.app').replace(
  /\/+$/,
  ''
)
const UPSTREAM_WS = UPSTREAM.replace(/^http/, 'ws')

// Path prefix the upstream expects. Deployed, Traefik routes /ohlcv on the shared host and
// the app sees the prefix stripped — but the ingress keeps it in the URL, so proxying to
// https://wdashboard.dev.turris.app must preserve it. A wdashboard-server run directly
// (uvicorn on localhost) mounts its routes at the root instead, so point this at "" for it:
//   OHLCV_UPSTREAM=http://localhost:20002 OHLCV_UPSTREAM_PREFIX= bun run dev:client
const UPSTREAM_PREFIX = (process.env.OHLCV_UPSTREAM_PREFIX ?? '/ohlcv').replace(/\/+$/, '')

function upstreamPath(pathname: string): string {
  const rest = pathname.replace(/^\/ohlcv/, '')
  return `${UPSTREAM_PREFIX}${rest}`
}

function upstreamUrl(req: Request): string {
  const url = new URL(req.url)
  return `${UPSTREAM}${upstreamPath(url.pathname)}${url.search}`
}

// Hop-by-hop and origin-bound headers must not be forwarded verbatim: `host` would route
// the upstream request to the wrong vhost, and `origin`/`referer` naming localhost would be
// rejected by the upstream CORS allowlist on preflighted requests.
function forwardHeaders(req: Request): Headers {
  const headers = new Headers(req.headers)
  for (const name of ['host', 'origin', 'referer', 'connection']) headers.delete(name)
  return headers
}

// Tiles are immutable by construction -- build_chart_tiles.py (bars) and build_book_tiles.py
// (the books, under `books/v1/`) only write a period once the source holds a row at or past
// its end, and everything still growing is content-addressed.
// So they get a year of `immutable`, which is what makes a scroll-back cost no network at
// all. The manifest is the mutable index that points at them, so it must never be cached:
// it is how the client learns that a new tile exists. Same split as client/nginx.conf uses
// for hashed bundles vs index.html.
async function serveTile(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url)
  const rest = decodeURIComponent(pathname.replace(/^\/tiles\//, ''))
  // Reject traversal before touching the filesystem: this serves a directory by raw path.
  if (rest.split('/').some((segment) => segment === '..' || segment === '')) {
    return new Response('bad tile path', { status: 400 })
  }
  const file = Bun.file(`${TILES_ROOT}/${rest}`)
  if (!(await file.exists())) return new Response('no such tile', { status: 404 })

  const manifest = rest.endsWith('.json')
  return new Response(file, {
    headers: {
      'content-type': manifest ? 'application/json' : 'application/vnd.apache.parquet',
      'cache-control': manifest ? 'no-cache' : 'public, max-age=31536000, immutable',
      // Parquet is already Snappy-compressed internally; gzipping it again costs CPU at
      // both ends for ~2% (129.4 KB snappy vs 127.0 KB gzipped).
      'content-encoding': 'identity'
    }
  })
}

async function proxyRest(req: Request): Promise<Response> {
  const target = upstreamUrl(req)
  try {
    const response = await fetch(target, {
      method: req.method,
      headers: forwardHeaders(req),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      redirect: 'manual'
    })
    // Bun's fetch transparently decodes the upstream body, so the upstream's
    // Content-Encoding/Content-Length now describe a payload that no longer exists. Passing
    // them through makes the browser try to gunzip plain JSON and fail the request outright
    // ("TypeError: Failed to fetch"). The server compresses anything over 1 KB, so this hits
    // every real /getbars and /levels response and nothing else.
    const headers = new Headers(response.headers)
    headers.delete('content-encoding')
    headers.delete('content-length')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    })
  } catch (err) {
    console.error(`[proxy] ${req.method} ${target} failed:`, err)
    return Response.json(
      { code: 'internal', detail: `dev proxy could not reach ${UPSTREAM}` },
      { status: 502 }
    )
  }
}

// Per-connection proxy state. `pending` exists because the browser may send frames before
// the upstream socket finishes opening; dropping those would silently lose the very first
// `subscribe`, which is the only one that matters on a fresh page load.
interface SocketProxy {
  upstream: WebSocket | null
  pending: string[]
  closed: boolean
}

// Bun.serve's second type parameter is the union of route paths, not an options bag; it has
// to be named explicitly here because the `websocket`/`data` generic in the first slot stops
// it being inferred from the `routes` literal.
const server = Bun.serve<SocketProxy, '/ohlcv/stream' | '/ohlcv/*' | '/tiles/*' | '/*'>({
  hostname: '0.0.0.0',
  port: PORT,
  // Chart cold loads fetch several hundred bars per pane and the upstream can take its
  // time; Bun's 10s default aborts those mid-flight.
  idleTimeout: 60,
  routes: {
    '/ohlcv/stream': (req, srv) => {
      if (srv.upgrade(req, { data: { upstream: null, pending: [], closed: false } })) return
      return new Response('expected a websocket upgrade', { status: 426 })
    },
    '/ohlcv/*': proxyRest,
    '/tiles/*': serveTile,
    '/*': index
  },
  websocket: {
    open(ws) {
      const upstream = new WebSocket(`${UPSTREAM_WS}${upstreamPath('/ohlcv/stream')}`)
      ws.data.upstream = upstream

      upstream.addEventListener('open', () => {
        for (const message of ws.data.pending) upstream.send(message)
        ws.data.pending = []
      })
      upstream.addEventListener('message', (event: MessageEvent) => {
        if (!ws.data.closed) ws.send(event.data as string)
      })
      upstream.addEventListener('error', (event) => {
        console.error('[proxy/ws] upstream error', event)
      })
      upstream.addEventListener('close', () => {
        if (!ws.data.closed) ws.close()
      })
    },
    message(ws, message) {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message)
      const upstream = ws.data.upstream
      if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(text)
      else ws.data.pending.push(text)
    },
    close(ws) {
      ws.data.closed = true
      ws.data.upstream?.close()
    }
  },
  development: {
    hmr: true,
    console: true
  }
})

console.log(
  `client dev server ready at ${server.url} (proxying /ohlcv -> ${UPSTREAM}, tiles from ${TILES_ROOT})`
)
