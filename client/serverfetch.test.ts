import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

// The login is enforced by the server on every route, so every request this client makes to
// wdashboard-server must carry the session's bearer -- and no request to the object stores
// (chart tiles, indicator tiles, book tiles) may, since those are anonymous reads behind a
// proxy that passes request headers through to SeaweedFS. Two doors make that structural:
// `serverFetch` (config.ts) for the server and `objectStoreFetch` (objectstore.ts) for the
// stores. The first block below fails if any new network call in the browser bundle goes
// around both; the rest check what each door does.

const CLIENT = import.meta.dir
const SRC = join(CLIENT, '..', 'src')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === 'fixtures') continue
      out.push(...sources(path))
    } else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path)
    }
  }
  return out
}

const GLOBALS = new Set(['globalThis', 'window', 'self'])
const NETWORK_CONSTRUCTORS = new Set(['WebSocket', 'EventSource', 'XMLHttpRequest'])

/** Where `text` reaches the network: any use of the GLOBAL `fetch` (called, or handed on as a
 * value), the browser's other network constructors, and `sendBeacon`. Read off the syntax tree,
 * so a method or property that happens to be named `fetch` -- a store's, a source spec's, the
 * plugin host's -- is not one. */
function networkUses(text: string, fileName: string): string[] {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  // A local variable or parameter named `fetch` shadows the global inside its scope (the plugin
  // host calls its in-flight read that), so a use there is not the network.
  const shadows: ts.Node[] = []
  const collect = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name) && node.name.text === 'fetch') {
      let scope: ts.Node = node.parent
      while (!(ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isFunctionLike(scope))) scope = scope.parent
      shadows.push(scope)
    }
    ts.forEachChild(node, collect)
  }
  collect(file)
  const shadowed = (node: ts.Node): boolean => shadows.some((scope) => node.pos >= scope.pos && node.end <= scope.end)
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'fetch' && !shadowed(node)) {
      const parent = node.parent
      const isName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isMethodDeclaration(parent) ||
          ts.isMethodSignature(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isParameter(parent) ||
          ts.isVariableDeclaration(parent) ||
          ts.isGetAccessorDeclaration(parent) ||
          ts.isSetAccessorDeclaration(parent)) &&
          parent.name === node)
      if (!isName) found.push('fetch')
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      if (GLOBALS.has(node.expression.text) && (node.name.text === 'fetch' || NETWORK_CONSTRUCTORS.has(node.name.text))) {
        found.push(`${node.expression.text}.${node.name.text}`)
      }
      if (node.name.text === 'sendBeacon') found.push('sendBeacon')
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && NETWORK_CONSTRUCTORS.has(node.expression.text)) {
      found.push(`new ${node.expression.text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

function scriptOf(path: string): string {
  const text = readFileSync(path, 'utf8')
  if (!path.endsWith('.svelte')) return text
  return [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
}

describe('every network call goes through a door', () => {
  test('only the two doors, the socket and the Bun-side dev proxy reach the network', () => {
    const hits = [...sources(CLIENT), ...sources(SRC)]
      .filter((path) => networkUses(scriptOf(path), path).length > 0)
      .map((path) => relative(join(CLIENT, '..'), path))
      .sort()
    expect(hits).toEqual(
      [
        // serverFetch: the one door to wdashboard-server; adds the bearer.
        'client/config.ts',
        // Runs in Bun, not the browser: the dev server's /tiles proxy (forwards no auth).
        'client/devtiles.ts',
        // objectStoreFetch: the one door to the tile buckets; never carries the bearer.
        'client/objectstore.ts',
        // Runs in Bun, not the browser: the dev server's /ohlcv proxy.
        'client/serve.ts',
        // WS /stream: presents the session in its first frame (an auth frame).
        'client/stream.ts',
        // The library's demo datafeed (Polygon). The dashboard client never constructs it.
        'src/DefaultDatafeed.ts'
      ].sort()
    )
  })
})

// --- behaviour ----------------------------------------------------------------------------
//
// config.ts reads `window` at module load, so the globals go in before the dynamic imports.

const pristine = {
  fetch: globalThis.fetch,
  window: (globalThis as Record<string, unknown>).window,
  localStorage: (globalThis as Record<string, unknown>).localStorage,
  hadWindow: 'window' in globalThis,
  hadLocalStorage: 'localStorage' in globalThis
}

const storage = new Map<string, string>()
if (!pristine.hadWindow) {
  ;(globalThis as Record<string, unknown>).window = {
    location: { href: 'http://localhost/', origin: 'http://localhost' }
  }
}
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key)
}

interface Seen {
  url: string
  authorization: string | null
  owner: string | null
}
const seen: Seen[] = []
// Path suffix -> [status, body]. Anything unlisted answers 200 with a generic envelope.
let answers: Record<string, [number, unknown]> = {}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input)
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
  seen.push({ url, authorization: headers.get('authorization'), owner: headers.get('x-sim-owner') })
  const path = new URL(url).pathname
  const match = Object.keys(answers).find((suffix) => path.endsWith(suffix))
  const [status, body] = match ? answers[match] : [200, { s: 'ok', points: [], plugins: [], serverTime: 0 }]
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

const TOKEN = 'tok-123'
const TOKEN_KEY = 'wd.auth.token'

const config = await import('./config')
const authtoken = await import('./authtoken')
const auth = await import('./auth')
const plugins = await import('./plugins/api')
const mtf = await import('./mtf/api')
const indicators = await import('./indicators/api')
const trading = await import('./trading/api')
const watch = await import('./watch/api')
const symbols = await import('./symbols')
const objectstore = await import('./objectstore')
const tileManifest = await import('./tiles/manifest')
const cachestore = await import('./tiles/cachestore')
const indicatorTiles = await import('./indicatortiles')
const bookTiles = await import('./books/tiles')

afterAll(() => {
  globalThis.fetch = pristine.fetch
  authtoken.whenSessionRejected(null)
  // One module registry for every test file: leave no manifest this file's stub answered.
  tileManifest.resetManifests()
  indicatorTiles.resetIndicatorTiles()
  bookTiles.resetBookTileCaches()
  if (pristine.hadWindow) (globalThis as Record<string, unknown>).window = pristine.window
  else delete (globalThis as Record<string, unknown>).window
  if (pristine.hadLocalStorage) (globalThis as Record<string, unknown>).localStorage = pristine.localStorage
  else delete (globalThis as Record<string, unknown>).localStorage
})

beforeEach(() => {
  seen.length = 0
  answers = {}
  storage.clear()
  authtoken.whenSessionRejected(null)
})

const serverRoot = new URL(`${config.DATASOURCE_BASE_URL}/`, 'http://localhost/').href
const isServer = (s: Seen) => s.url.startsWith(serverRoot)

const MTF_REQUEST = {
  symbol: 'oanda:EURUSD',
  source: 'arev21',
  timeframes: ['1h'],
  roots: ['1h'],
  maxStep: 1,
  from: 0,
  to: 1,
  limit: 10
} as unknown as Parameters<typeof mtf.fetchMtfGraph>[0]

/** One call through every server-facing module, each by its own public entry point.
 * preferences.ts is not called here: it reaches the server only through `apiSend` (the PUT
 * below), and its memoized document would leak into client/preferences.test.ts, since bun
 * runs every test file in one module registry. */
async function callEveryServerSite(): Promise<void> {
  await config.apiGet('/capabilities')
  await config.apiGetResponse('/levels', { symbol: 'oanda:EURUSD' })
  await config.apiSend('PUT', '/preferences', { body: { data: {} } })
  await plugins.fetchEnvelope(config.apiUrl('/plugins/arev/values', { symbol: 'oanda:EURUSD' }))
  await mtf.fetchMtfGraph(MTF_REQUEST)
  await mtf.warmMtfGraph(MTF_REQUEST)
  await indicators.resolveSeries('oanda:EURUSD', '1h', { name: 'rsi', params: { n: Math.random() } } as never)
  await trading.simApi.list()
  await watch.watchApi.sources()
  await auth.currentSession()
  await symbols.fetchSymbols('EUR')
}

/** One read through every object-store module. */
async function callEveryTileSite(): Promise<void> {
  tileManifest.resetManifests()
  await tileManifest.manifestFor('oanda', 'EURUSD', '1h')
  await cachestore.tileBytes('auth-test')(`${tileManifest.tilesBaseUrl()}/v2/oanda/EURUSD/1h/x.parquet`)
  indicatorTiles.resetIndicatorTiles()
  await indicatorTiles.manifestFor('arev21/oanda/EURUSD/1h')
  bookTiles.resetBookTileCaches()
  await bookTiles.manifestFor('orderbook' as never, 'oanda', 'EURUSD', '1h')
}

describe('the bearer', () => {
  test('rides on every server call site when a token is held', async () => {
    storage.set(TOKEN_KEY, TOKEN)
    answers = { '/sim/sessions': [200, { sessions: [] }], '/search': [200, []] }
    await callEveryServerSite()
    const server = seen.filter(isServer)
    // Every site above made at least one request; none of them went anywhere else.
    expect(server.length).toBeGreaterThanOrEqual(11)
    expect(seen.length).toBe(server.length)
    for (const s of server) expect({ url: s.url, authorization: s.authorization }).toEqual({ url: s.url, authorization: `Bearer ${TOKEN}` })
  })

  test('is absent everywhere when no token is held', async () => {
    answers = { '/sim/sessions': [200, { sessions: [] }], '/search': [200, []] }
    await callEveryServerSite()
    expect(seen.filter(isServer).length).toBeGreaterThan(0)
    for (const s of seen) expect(s.authorization).toBeNull()
  })

  test('never reaches an object store, token or not', async () => {
    storage.set(TOKEN_KEY, TOKEN)
    await callEveryTileSite()
    expect(seen.length).toBeGreaterThanOrEqual(4)
    for (const s of seen) {
      expect(isServer(s)).toBe(false)
      expect(s.authorization).toBeNull()
    }
  })

  test('objectStoreFetch strips an Authorization a caller passed by mistake', async () => {
    storage.set(TOKEN_KEY, TOKEN)
    await objectstore.objectStoreFetch('http://localhost/tiles/v2/x', { headers: { Authorization: 'Bearer leaked' } })
    expect(seen).toHaveLength(1)
    expect(seen[0].authorization).toBeNull()
  })

  test('serverFetch refuses a URL that is not the server', async () => {
    storage.set(TOKEN_KEY, TOKEN)
    await expect(config.serverFetch(new URL('http://localhost/tiles/v2/x'))).rejects.toThrow()
    expect(seen).toHaveLength(0)
  })

  test('the owner header is still sent beside the bearer (the identity where auth is off)', async () => {
    storage.set(TOKEN_KEY, TOKEN)
    answers = { '/sim/sessions': [200, { sessions: [] }] }
    await trading.simApi.list()
    expect(seen[0].owner).toBeTruthy()
    expect(seen[0].authorization).toBe(`Bearer ${TOKEN}`)
  })

  test('logout presents the token it is clearing', async () => {
    storage.set(TOKEN_KEY, TOKEN)
    answers = { '/auth/logout': [204, null] }
    await auth.logout()
    expect(seen.map((s) => [new URL(s.url).pathname.endsWith('/auth/logout'), s.authorization])).toEqual([[true, `Bearer ${TOKEN}`]])
    expect(storage.has(TOKEN_KEY)).toBe(false)
  })
})

const UNAUTHORIZED: [number, unknown] = [401, { code: 'unauthorized', detail: 'Missing, invalid, or expired session token' }]

describe('a rejected session', () => {
  test('a wall of 401s signs out once, not once per request', async () => {
    storage.set(TOKEN_KEY, TOKEN)
    let calls = 0
    authtoken.whenSessionRejected(() => {
      calls += 1
    })
    answers = { '/values': UNAUTHORIZED, '/graph': UNAUTHORIZED, '/getbars': UNAUTHORIZED }
    const reads = [
      ...Array.from({ length: 8 }, (_, i) => plugins.fetchEnvelope(config.apiUrl(`/plugins/p${i}/values`))),
      mtf.fetchMtfGraph(MTF_REQUEST),
      config.apiGet('/getbars', { symbol: 'oanda:EURUSD' })
    ]
    const results = await Promise.allSettled(reads)
    // The reads still fail, each as it always has; the sign-out is the page's, and happens once.
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toBe(1)
    expect(storage.has(TOKEN_KEY)).toBe(false)
  })

  test('a wrong password at sign-in is an answer, not a lost session', async () => {
    let calls = 0
    authtoken.whenSessionRejected(() => {
      calls += 1
    })
    answers = { '/auth/login': [401, { code: 'unauthorized', detail: 'Invalid username or password' }] }
    await expect(auth.login('user', 'wrong')).rejects.toThrow('Invalid username or password')
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toBe(0)
  })

  test('a 401 that is not the unauthorized error body does not sign out', async () => {
    storage.set(TOKEN_KEY, TOKEN)
    let calls = 0
    authtoken.whenSessionRejected(() => {
      calls += 1
    })
    answers = { '/getbars': [401, { code: 'internal', detail: 'a proxy said no' }] }
    await expect(config.apiGet('/getbars')).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toBe(0)
    expect(storage.get(TOKEN_KEY)).toBe(TOKEN)
  })

  test('with nothing armed (auth off, or before the boot gate) a 401 changes nothing', async () => {
    storage.set(TOKEN_KEY, TOKEN)
    answers = { '/getbars': UNAUTHORIZED }
    await expect(config.apiGet('/getbars')).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 10))
    expect(storage.get(TOKEN_KEY)).toBe(TOKEN)
  })
})
