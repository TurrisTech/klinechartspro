import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import type { SimAnswer, SimQuote, SimSnapshot } from './api'

// ONE `POST /sim/sessions/{id}/watch` per instrument per session. A pane load used to send
// four and every trade-box open one more; each persisted and returned the whole session to
// change nothing, since the server's watch is set membership.
//
// `fetch` is stubbed rather than the module mocked, the way client/instrumentconfig.test.ts
// does it, with a fake `/sim` that answers the three routes the session touches here. `window`
// does not exist under bun and config.ts reads it at MODULE LOAD, so it is installed before
// the dynamic import below; `document` because a loaded session starts polling (a hidden tab
// never polls, and every test disposes its session, which clears the timer). Each is
// installed only if absent, and removed only if this file installed it: test files share one
// global, and a sibling's `window` (with the `navigator` klinecharts reads at import) must
// survive this one.

const g = globalThis as Record<string, unknown>
const hadWindow = 'window' in g
const hadDocument = 'document' in g
installWindow()
if (!hadDocument) {
  g.document = { visibilityState: 'hidden', addEventListener: () => {}, removeEventListener: () => {} }
}
afterAll(() => {
  if (!hadWindow) delete g.window
  if (!hadDocument) delete g.document
})

const { PaperTradingSession } = await import('./session')

const ID = 's1'
const EURUSD = 'oanda:EURUSD'
const GBPUSD = 'oanda:GBPUSD'

/** The fake `/sim`: one paper session, a quote per watched instrument whose time moves on
 * every read, and switches for the two ways a watch fails. */
const server = {
  quotes: {} as Record<string, SimQuote>,
  clock: 1_000,
  calls: [] as string[],
  /** The next watch answers 500. */
  failNext: false,
  /** Watches answer 200 without the quote -- a swallowed subscribe/seed failure. */
  withholdQuote: false
}

function snapshot(): SimSnapshot {
  server.clock += 1
  for (const quote of Object.values(server.quotes)) quote.time = server.clock
  return {
    id: ID,
    mode: 'paper',
    name: 'Paper',
    createdAt: 1,
    rev: server.clock,
    account: { currency: 'USD', initialBalance: 1, balance: 1, unrealizedPnl: 0, equity: 1 },
    quotes: structuredClone(server.quotes),
    orders: [],
    trades: [],
    symbols: Object.keys(server.quotes)
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function route(method: string, path: string, body: unknown): Response {
  if (method === 'GET' && path === '/ohlcv/sim/sessions') return json({ sessions: [snapshot()] })
  if (method === 'GET' && path === `/ohlcv/sim/sessions/${ID}`) return json({ session: snapshot(), events: [] })
  if (method === 'POST' && path === `/ohlcv/sim/sessions/${ID}/watch`) {
    if (server.failNext) {
      server.failNext = false
      return json({ code: 'internal', detail: 'boom' }, 500)
    }
    const { symbol } = body as { symbol: string }
    if (!server.withholdQuote) server.quotes[symbol] ??= { time: 0, bid: 1.1, ask: 1.2 }
    const answer: SimAnswer = { session: snapshot(), events: [] }
    return json(answer)
  }
  return json({ code: 'not_found', detail: `${method} ${path}` }, 404)
}

const pristineFetch = globalThis.fetch
let session: InstanceType<typeof PaperTradingSession>

beforeEach(() => {
  server.quotes = {}
  server.calls = []
  server.failNext = false
  server.withholdQuote = false
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = init?.method ?? 'GET'
    server.calls.push(`${method} ${url.pathname}`)
    return route(method, url.pathname, init?.body ? JSON.parse(String(init.body)) : undefined)
  }) as typeof fetch
  session = new PaperTradingSession()
})

afterEach(() => {
  session.dispose()
  globalThis.fetch = pristineFetch
})

const watches = (): number => server.calls.filter((c) => c.endsWith('/watch')).length

describe('PaperTradingSession.watch', () => {
  test('a repeat watch of one instrument sends one POST', async () => {
    await session.watch(EURUSD)
    await session.watch(EURUSD)
    await session.watch(EURUSD)
    expect(watches()).toBe(1)
    expect(session.snapshot.quotes[EURUSD]).toBeDefined()
  })

  test('concurrent callers share the request in flight', async () => {
    await Promise.all([session.watch(EURUSD), session.watch(EURUSD), session.watch(EURUSD)])
    expect(watches()).toBe(1)
  })

  test('each instrument is watched once, on its own', async () => {
    await session.watch(EURUSD)
    await session.watch(GBPUSD)
    await session.watch(EURUSD)
    await session.watch(GBPUSD)
    expect(watches()).toBe(2)
  })

  test('a failed watch rejects and is retried by the next call', async () => {
    server.failNext = true
    await expect(session.watch(EURUSD)).rejects.toThrow('boom')
    await session.watch(EURUSD)
    await session.watch(EURUSD)
    expect(watches()).toBe(2)
    expect(session.snapshot.quotes[EURUSD]).toBeDefined()
  })

  test('a 200 without the quote is not a watch that took: the next call retries', async () => {
    server.withholdQuote = true
    await session.watch(EURUSD) // resolves, as it always did -- callers see no change
    await session.watch(EURUSD)
    expect(watches()).toBe(2)
    server.withholdQuote = false
    await session.watch(EURUSD)
    await session.watch(EURUSD)
    expect(watches()).toBe(3)
  })
})

describe('PaperTradingSession.quote', () => {
  test('reads the account fresh every time, while watching only once', async () => {
    const first = await session.quote(EURUSD)
    const second = await session.quote(EURUSD)
    expect(watches()).toBe(1)
    expect(server.calls.filter((c) => c === `GET /ohlcv/sim/sessions/${ID}`).length).toBe(2)
    expect(first).toBeDefined()
    expect(second?.time).toBeGreaterThan(first?.time ?? Number.POSITIVE_INFINITY)
    // The fresh read is the session's state too, not only the answer.
    expect(session.snapshot.quotes[EURUSD]).toEqual(second as SimQuote)
  })

  test('after a plain watch, the quote is newer than the watch reply', async () => {
    await session.watch(EURUSD)
    const watched = session.snapshot.quotes[EURUSD]?.time ?? Number.POSITIVE_INFINITY
    const quote = await session.quote(EURUSD)
    expect(watches()).toBe(1)
    expect(quote?.time).toBeGreaterThan(watched)
  })
})
