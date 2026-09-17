import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describeTileSource,
  localTileHeaders,
  proxiedTileHeaders,
  tileHandler,
  tileSegments,
  tileSourceFromEnv,
  upstreamTileUrl
} from './devtiles'

// The dev server's /tiles/* route (client/serve.ts). Every fetch here is an injected stub and
// every file a temporary one: nothing reaches a real bucket or a real tile tree.

const BASE = 'http://127.0.0.1:18493/marketdata-tiles-dev'
const MANIFEST = '/tiles/v2/oanda/EURUSD/1m/manifest.json'
const TILE = '/tiles/v2/oanda/EURUSD/1m/2024-03.parquet'

interface Call {
  url: string
  init?: RequestInit
}

/** A fetch stub that records what it was asked and answers with `respond`. */
function stubFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = []
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return respond(url)
  }
  return { calls, impl }
}

function get(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3000${path}`, init)
}

describe('tileSourceFromEnv', () => {
  test('nothing set is no source at all -- no directory is read by default', () => {
    expect(tileSourceFromEnv({})).toEqual({ kind: 'none' })
    expect(tileSourceFromEnv({ TILES_ROOT: '', TILES_UPSTREAM: '  ' })).toEqual({ kind: 'none' })
  })

  test('TILES_UPSTREAM selects the proxy, trailing slashes trimmed', () => {
    expect(tileSourceFromEnv({ TILES_UPSTREAM: `${BASE}//` })).toEqual({
      kind: 'upstream',
      base: BASE
    })
  })

  test('TILES_ROOT selects a local directory', () => {
    expect(tileSourceFromEnv({ TILES_ROOT: '/srv/fixtures/tiles/' })).toEqual({
      kind: 'root',
      root: '/srv/fixtures/tiles'
    })
  })

  test('the upstream wins when both are set, and the log says the root was ignored', () => {
    const env = { TILES_UPSTREAM: BASE, TILES_ROOT: '/srv/fixtures/tiles' }
    const source = tileSourceFromEnv(env)
    expect(source.kind).toBe('upstream')
    expect(describeTileSource(source, env)).toContain('TILES_ROOT ignored')
  })

  test('an unusable upstream fails at startup rather than per tile', () => {
    expect(() => tileSourceFromEnv({ TILES_UPSTREAM: 'not a url' })).toThrow(/not a URL/)
    expect(() => tileSourceFromEnv({ TILES_UPSTREAM: 'file:///mnt/d/tiles' })).toThrow(/http/)
    expect(() => tileSourceFromEnv({ TILES_UPSTREAM: `${BASE}?list-type=2` })).toThrow(/query/)
  })

  test('the startup line names the mode', () => {
    expect(describeTileSource({ kind: 'none' })).toContain('404')
    expect(describeTileSource({ kind: 'upstream', base: BASE })).toContain(BASE)
    expect(describeTileSource({ kind: 'root', root: '/x' })).toContain('/x')
  })
})

describe('tileSegments', () => {
  test('the bar and book layouts both pass', () => {
    expect(tileSegments(MANIFEST)).toEqual(['v2', 'oanda', 'EURUSD', '1m', 'manifest.json'])
    expect(tileSegments('/tiles/books/v1/position/oanda/EURUSD/1h/manifest.json')).toEqual([
      'books',
      'v1',
      'position',
      'oanda',
      'EURUSD',
      '1h',
      'manifest.json'
    ])
  })

  test('a percent-encoded symbol is decoded once', () => {
    expect(tileSegments('/tiles/v2/schwab/%24SPX/1D/manifest.json')?.[2]).toBe('$SPX')
  })

  test.each([
    ['plain traversal', '/tiles/v2/../../etc/passwd'],
    ['encoded traversal', '/tiles/v2/%2e%2e/%2e%2e/etc/passwd'],
    ['encoded separator', '/tiles/v2/..%2F..%2Fsecret'],
    ['dot segment', '/tiles/./v2/manifest.json'],
    ['empty segment', '/tiles/v2//manifest.json'],
    ['the bucket root, which would be a listing', '/tiles/'],
    ['a trailing slash', '/tiles/v2/oanda/'],
    ['malformed escape', '/tiles/v2/%zz'],
    ['NUL byte', '/tiles/v2/a%00b'],
    ['a path outside /tiles/', '/etc/passwd']
  ])('refuses %s', (_, path) => {
    expect(tileSegments(path)).toBeNull()
  })
})

describe('upstreamTileUrl', () => {
  test('appends the path below /tiles/ to the bucket base', () => {
    expect(upstreamTileUrl(BASE, ['v2', 'oanda', 'EURUSD', '1m', 'manifest.json'])).toBe(
      `${BASE}/v2/oanda/EURUSD/1m/manifest.json`
    )
  })

  test('nothing in a segment can add a query, a fragment or a path level', () => {
    const url = new URL(upstreamTileUrl(BASE, ['v2', 'a?acl', 'b#x', 'c/d']))
    expect(url.search).toBe('')
    expect(url.hash).toBe('')
    expect(url.pathname).toBe('/marketdata-tiles-dev/v2/a%3Facl/b%23x/c%2Fd')
  })
})

describe('headers', () => {
  test('a local manifest is never cached; a local tile is a year immutable', () => {
    expect(localTileHeaders(['v2', 'manifest.json'])).toMatchObject({
      'content-type': 'application/json',
      'cache-control': 'no-cache'
    })
    expect(localTileHeaders(['v2', '2024-03.parquet'])).toMatchObject({
      'content-type': 'application/vnd.apache.parquet',
      'cache-control': 'public, max-age=31536000, immutable'
    })
  })

  test('a proxied response keeps the object store per-object policy and drops the encoding', () => {
    const headers = proxiedTileHeaders(
      new Headers({
        'content-type': 'application/json',
        'cache-control': 'no-cache',
        etag: '"abc"',
        'content-encoding': 'gzip',
        'content-length': '123',
        connection: 'keep-alive'
      })
    )
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('cache-control')).toBe('no-cache')
    expect(headers.get('etag')).toBe('"abc"')
    expect(headers.has('content-encoding')).toBe(false)
    expect(headers.has('content-length')).toBe(false)
    expect(headers.has('connection')).toBe(false)
  })
})

describe('tileHandler with no source', () => {
  test('every tile is a 404, and nothing is fetched', async () => {
    const { calls, impl } = stubFetch(() => new Response('unreachable'))
    const handle = tileHandler({ kind: 'none' }, impl)
    const books = '/tiles/books/v1/position/oanda/EURUSD/1h/manifest.json'
    for (const path of [MANIFEST, TILE, books]) {
      expect((await handle(get(path))).status).toBe(404)
    }
    expect(calls).toHaveLength(0)
  })
})

describe('tileHandler proxying an upstream', () => {
  const source = { kind: 'upstream', base: BASE } as const

  test('a manifest is fetched from the bucket and passed through with its headers', async () => {
    const body = '{"tiles":[]}'
    const { calls, impl } = stubFetch(
      () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' }
        })
    )
    const res = await tileHandler(source, impl)(get(MANIFEST))
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/v2/oanda/EURUSD/1m/manifest.json`])
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.text()).toBe(body)
  })

  test('a tile keeps the immutable policy the object carries', async () => {
    const bytes = new Uint8Array([0x50, 0x41, 0x52, 0x31])
    const { impl } = stubFetch(
      () =>
        new Response(bytes, {
          headers: {
            'content-type': 'application/vnd.apache.parquet',
            'cache-control': 'public, max-age=31536000, immutable'
          }
        })
    )
    const res = await tileHandler(source, impl)(get(TILE))
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
  })

  test("the bucket's 404 stays a 404, so the client falls back to /getbars", async () => {
    const { impl } = stubFetch(() => new Response('<Error>NoSuchKey</Error>', { status: 404 }))
    expect((await tileHandler(source, impl)(get(MANIFEST))).status).toBe(404)
  })

  test('only conditional/range headers are forwarded; cookies and auth are not', async () => {
    const { calls, impl } = stubFetch(() => new Response(null, { status: 304 }))
    const res = await tileHandler(source, impl)(
      get(TILE, {
        headers: {
          'if-none-match': '"abc"',
          range: 'bytes=0-3',
          cookie: 'session=secret',
          authorization: 'Bearer secret',
          origin: 'http://localhost:3000'
        }
      })
    )
    expect(res.status).toBe(304)
    const sent = new Headers(calls[0].init?.headers)
    expect(sent.get('if-none-match')).toBe('"abc"')
    expect(sent.get('range')).toBe('bytes=0-3')
    expect(sent.has('cookie')).toBe(false)
    expect(sent.has('authorization')).toBe(false)
    expect(sent.has('origin')).toBe(false)
  })

  test('the query string is not forwarded', async () => {
    const { calls, impl } = stubFetch(() => new Response('{}'))
    await tileHandler(source, impl)(get(`${MANIFEST}?acl`))
    expect(calls[0].url).toBe(`${BASE}/v2/oanda/EURUSD/1m/manifest.json`)
  })

  test('HEAD is forwarded as HEAD', async () => {
    const { calls, impl } = stubFetch(() => new Response(null, { status: 200 }))
    const res = await tileHandler(source, impl)(get(MANIFEST, { method: 'HEAD' }))
    expect(res.status).toBe(200)
    expect(calls[0].init?.method).toBe('HEAD')
  })

  test('a write is refused before anything reaches the bucket', async () => {
    const { calls, impl } = stubFetch(() => new Response('unreachable'))
    for (const method of ['PUT', 'POST', 'DELETE']) {
      const res = await tileHandler(source, impl)(get(TILE, { method, body: 'x' }))
      expect(res.status).toBe(405)
    }
    expect(calls).toHaveLength(0)
  })

  test('a traversal is refused before anything reaches the bucket', async () => {
    const { calls, impl } = stubFetch(() => new Response('unreachable'))
    const res = await tileHandler(source, impl)(get('/tiles/v2/%2e%2e/%2e%2e/other-bucket/key'))
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test('an unreachable bucket is a 502, not a thrown request', async () => {
    const { impl } = stubFetch(() => {
      throw new TypeError('connection refused')
    })
    const original = console.error
    console.error = () => {}
    try {
      expect((await tileHandler(source, impl)(get(MANIFEST))).status).toBe(502)
    } finally {
      console.error = original
    }
  })
})

describe('tileHandler over a local directory', () => {
  let root = ''

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'devtiles-'))
    mkdirSync(join(root, 'v2/oanda/EURUSD/1m'), { recursive: true })
    writeFileSync(join(root, 'v2/oanda/EURUSD/1m/manifest.json'), '{"tiles":[]}')
    writeFileSync(join(root, 'v2/oanda/EURUSD/1m/2024-03.parquet'), 'PAR1')
  })

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test('serves a manifest and a tile with the publisher policy', async () => {
    const { calls, impl } = stubFetch(() => new Response('unreachable'))
    const handle = tileHandler({ kind: 'root', root }, impl)

    const manifest = await handle(get(MANIFEST))
    expect(manifest.status).toBe(200)
    expect(manifest.headers.get('cache-control')).toBe('no-cache')
    expect(await manifest.text()).toBe('{"tiles":[]}')

    const tile = await handle(get(TILE))
    expect(tile.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await tile.text()).toBe('PAR1')

    expect(calls).toHaveLength(0)
  })

  test('a missing tile is a 404 and a traversal a 400', async () => {
    const handle = tileHandler({ kind: 'root', root })
    expect((await handle(get('/tiles/v2/oanda/USDJPY/1m/manifest.json'))).status).toBe(404)
    expect((await handle(get('/tiles/v2/%2e%2e/%2e%2e/%2e%2e/etc/passwd'))).status).toBe(400)
  })
})
