import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { KLineChartPro, PaneSnapshot, SymbolInfo } from '../../src'
import type { EngineState } from './engine'
import type { ReplayState } from './persist'

// THE REPLAY WALL'S GLUE (index.ts), mounted for real: `mountBarReplay` over a fake wall and a
// stubbed server -- the session read, the stored-ladder probe, the state writes -- with the
// trading dock and the replay controls rendered into a real DOM (happy-dom, this file only).
// What the follow decisions (follow.test.ts) cannot show on their own: that a symbol picked on the
// active pane reaches the session, that the blob the server is sent walks the new instrument at
// the same cursor, that the wall is told to rebuild exactly once -- and, when something is open,
// that nothing is sent, nothing rebuilt, and the controls say why.

GlobalRegistrator.register({ url: 'http://test/' })

const { mountBarReplay, bootReplay, REPLAY_WALL_CLASS } = await import('./index')
const { writeIntent } = await import('./persist')
const { FX_SCHEDULE, fromWall } = await import('./timeframes')
const { resolutionToPeriod } = await import('../periods')
const { resetInstrumentConfigCache } = await import('../instrumentconfig')

const pristineFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = pristineFetch
  GlobalRegistrator.unregister()
})

const H = 3_600_000
const WALKED = 'oanda:EURGBP'
const CURSOR = fromWall(Date.UTC(2024, 2, 4, 10, 0), 'America/New_York')

function info(ticker: string): SymbolInfo {
  // The schedule rides on the symbol, as client/symbols.ts resolves it from the server.
  return { ticker, exchange: 'oanda', pricePrecision: 5, timezone: FX_SCHEDULE.timezone, dayGeometry: FX_SCHEDULE.day } as unknown as SymbolInfo
}

/** The server: one replay session whose blob is `blob`, every stored interval present at the
 * cursor, and every `PUT .../state` recorded. Anything else is a 404 the code must survive. */
class FakeServer {
  rev = 1
  puts: ReplayState[] = []
  probes: string[] = []
  /** The next PUT is answered 409, as when another tab saved first. */
  conflict = false
  constructor(public blob: ReplayState) {}

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const method = init?.method ?? 'GET'
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.pathname.endsWith('/sim/sessions/s1') && method === 'GET') return json({ session: this.session(), events: [] })
    if (url.pathname.endsWith('/sim/sessions/s1/state') && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as { rev: number; state: ReplayState }
      if (this.conflict || body.rev !== this.rev) {
        this.conflict = false
        this.rev++
        return json({ code: 'conflict', detail: 'stale rev' }, 409)
      }
      this.puts.push(body.state)
      this.blob = body.state
      this.rev++
      return json({ session: this.session(), events: [] })
    }
    if (url.pathname.endsWith('/instrument')) {
      // What a mount asks for an instrument no pane shows: its configuration, market hours and all.
      const symbol = url.searchParams.get('symbol') ?? ''
      const marketHours = { timezone: 'America/New_York', sessions: [{ openDay: 'sun', openTime: '17:00', closeDay: 'fri', closeTime: '17:00' }] }
      return json({ vendor: 'oanda', symbol: symbol.split(':').pop(), displayName: symbol, instrumentType: 'CURRENCY', assetClass: 'forex', displayPrecision: 5, forexPipLocation: -4, marketHours })
    }
    if (url.pathname.endsWith('/getbars')) {
      // The ladder probe asks for one bar; a bar at the cursor answers "stored".
      if (url.searchParams.get('limit') === '1') {
        this.probes.push(`${url.searchParams.get('symbol')} ${url.searchParams.get('resolution')}`)
        const t = CURSOR - H
        return json([{ time: t, open: 0.85, high: 0.851, low: 0.849, close: 0.85, volume: 1 }])
      }
      return json([])
    }
    return json({ code: 'not_found', detail: url.pathname }, 404)
  }) as typeof fetch

  private session() {
    return {
      id: 's1',
      mode: 'replay',
      name: 'Replay',
      createdAt: 0,
      rev: this.rev,
      account: { currency: 'GBP', initialBalance: 10_000, balance: 10_000, unrealizedPnl: 0, equity: 10_000 },
      quotes: {},
      orders: [],
      trades: [],
      symbols: [WALKED],
      state: this.blob
    }
  }
}

function blob(engine: Partial<EngineState> = {}): ReplayState {
  return {
    version: 1,
    vendor: 'oanda',
    symbol: WALKED,
    cursor: CURSOR,
    startedAt: CURSOR - 24 * H,
    base: '1h',
    advance: { interval: '1h', multiple: 1 },
    pauseOnFill: false,
    watches: [],
    engine: {
      initialBalance: 10_000,
      currency: 'GBP',
      balance: 10_000,
      clock: CURSOR,
      nextId: 1,
      quotes: { [WALKED]: { symbol: WALKED, time: CURSOR, bid: 0.85, ask: 0.8502 } },
      orders: [],
      trades: [],
      ...engine
    }
  }
}

/** A one-pane wall the replay can ask what it shows. `pick` is the symbol search's: the pane's
 * symbol changes, then the wall reports it, as ChartPro's `assignSymbol` does. */
function wall(initial = 'EURGBP') {
  let symbol = info(initial)
  const pane = { id: 'p1', getSymbol: () => symbol, getPeriod: () => resolutionToPeriod('1h'), getChart: () => null }
  const chartPro = {
    getPanes: () => [pane],
    getPane: (id: string) => (id === 'p1' ? pane : null),
    getActivePaneId: () => 'p1',
    getSymbol: () => symbol,
    getPaneSnapshots: () => [{ id: 'p1', symbol } as unknown as PaneSnapshot],
    getSlot: () => null
  }
  return {
    chartPro: chartPro as unknown as KLineChartPro,
    setSymbol(ticker: string) {
      symbol = info(ticker)
      return symbol
    }
  }
}

async function mount(server: FakeServer, initial = 'EURGBP') {
  globalThis.fetch = server.fetch
  // The page-wide instrument cache, which another suite in this process may have filled with an
  // answer from its own stub.
  resetInstrumentConfigCache()
  writeIntent(window.sessionStorage, { sessionId: 's1', cursor: CURSOR })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const w = wall(initial)
  const rebuilds: number[] = []
  const controller = await mountBarReplay(w.chartPro, container, bootReplay({ sessionId: 's1', cursor: CURSOR }, '1m'), {
    pluginHost: { invalidateFrom: () => {}, settled: async () => {} } as never,
    levelsController: { invalidate: () => {} },
    notify: { notify: (spec) => ({ ...spec, id: 'n', at: 0, level: 'info', seen: false }) },
    alerts: null,
    rebuild: () => rebuilds.push(Date.now())
  })
  if (!controller) throw new Error('the replay did not mount')
  return { controller, container, rebuilds, w }
}

/** Until `done()` holds or a second passes: the follow is a chain of reads and a write. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
}

let mounted: Array<{ controller: { teardown(): void } }> = []
afterEach(() => {
  for (const m of mounted) m.controller.teardown()
  mounted = []
  document.body.innerHTML = ''
  window.sessionStorage.clear()
})

describe('mountBarReplay following the active pane', () => {
  test('nothing open: the blob for the new instrument at the same cursor is written, then one rebuild', async () => {
    const server = new FakeServer(blob())
    const m = await mount(server)
    mounted.push(m)
    expect(m.container.classList.contains(REPLAY_WALL_CLASS)).toBe(true)
    const writes = server.puts.length

    m.controller.symbolChanged('p1', m.w.setSymbol('EURUSD'))
    await until(() => m.rebuilds.length > 0)

    expect(m.rebuilds.length).toBe(1)
    const sent = server.puts.slice(writes)
    expect(sent.map((s) => s.symbol)).toEqual(['oanda:EURUSD'])
    expect(sent[0].cursor).toBe(CURSOR)
    expect(sent[0].startedAt).toBe(CURSOR - 24 * H)
    // The rebuild reads it back: the intent still names this session at this cursor.
    expect(server.blob.symbol).toBe('oanda:EURUSD')
    expect(JSON.parse(window.sessionStorage.getItem('wd.replay.intent') ?? 'null')).toEqual({ sessionId: 's1', cursor: CURSOR })
    // The new instrument's ladder was probed once, as the mount it rebuilds into would...
    expect(server.probes.filter((p) => p.startsWith('oanda:EURUSD')).length).toBe(4)

    // ...and that mount takes the follow's answer rather than asking again.
    m.controller.teardown()
    mounted = []
    const again = await mount(server, 'EURUSD')
    mounted.push(again)
    expect(server.probes.filter((p) => p.startsWith('oanda:EURUSD')).length).toBe(4)
    expect(document.querySelector('.wd-replay-symbol')?.textContent).toBe('EURUSD')
    expect(again.controller.watches.canWatch('oanda:EURUSD')).toBeNull()
    // The wall shows what it walks: no follow from the mount.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(again.rebuilds).toEqual([])
  })

  test('a stale rev (another tab saved) still writes the blob the follow rebuilds from', async () => {
    const server = new FakeServer(blob())
    const m = await mount(server)
    mounted.push(m)
    server.conflict = true
    m.controller.symbolChanged('p1', m.w.setSymbol('EURUSD'))
    await until(() => m.rebuilds.length > 0)
    expect(m.rebuilds.length).toBe(1)
    expect(server.blob.symbol).toBe('oanda:EURUSD')
  })

  test('a save landing after Exit does not put the page back into the replay', async () => {
    const { clearReplay } = await import('./index')
    const { PRICE_SOURCE, priceCondition } = await import('../watch/types')
    const server = new FakeServer(blob())
    const m = await mount(server)
    mounted.push(m)
    const writes = server.puts.length
    // Exit clears the intent; a write the session queued just before it lands just after.
    clearReplay()
    await m.controller.watches.store.create({ source: PRICE_SOURCE, target: WALKED, condition: priceCondition(0.9), name: 'EURGBP 0.9' })
    await until(() => server.puts.length > writes)
    // The intent is written after the PUT answers: give that its turn.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(server.puts.length).toBeGreaterThan(writes)
    expect(window.sessionStorage.getItem('wd.replay.intent')).toBeNull()
  })

  test('a trade open on the instrument walked: nothing written, no rebuild, and the controls say why', async () => {
    const trade = {
      id: 't1',
      symbol: WALKED,
      side: 'buy' as const,
      units: 1000,
      entryPrice: 0.8502,
      openedAt: CURSOR - H,
      orderId: 'o1',
      stopLoss: null,
      takeProfit: null,
      closedAt: null,
      closePrice: null,
      closeReason: null,
      realizedPnl: null,
      label: null
    }
    const server = new FakeServer(blob({ trades: [trade], nextId: 2 }))
    const m = await mount(server)
    mounted.push(m)
    const writes = server.puts.length

    m.controller.symbolChanged('p1', m.w.setSymbol('EURUSD'))
    await until(() => document.querySelector('.wd-replay-notice') !== null)

    const notice = document.querySelector('.wd-replay-notice') as HTMLElement
    expect(notice.textContent).toContain('The replay walks EURGBP, not EURUSD: EURGBP has 1 open trade. Close it to follow EURUSD, or exit the replay.')
    expect((notice.querySelector('.wd-replay-follow') as HTMLButtonElement).disabled).toBe(true)
    // Give a follow every chance to have gone ahead anyway.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(server.puts.slice(writes).every((s) => s.symbol === WALKED)).toBe(true)
    expect(m.rebuilds).toEqual([])
    // Still the replay of EURGBP: the title bar, and its watches.
    expect(document.querySelector('.wd-replay-symbol')?.textContent).toBe('EURGBP')
    expect(m.controller.watches.canWatch('oanda:EURUSD')).toContain('EURGBP')

    // Back on EURGBP: the notice goes.
    m.controller.symbolChanged('p1', m.w.setSymbol('EURGBP'))
    expect(document.querySelector('.wd-replay-notice')).toBeNull()
  })

  test('a wall that comes back with no pane on the instrument walked follows its active pane', async () => {
    // Revert after a follow: the saved layout shows EURGBP, the blob walks EURUSD.
    const server = new FakeServer({ ...blob(), symbol: 'oanda:EURUSD', engine: { ...blob().engine, quotes: {} } })
    const m = await mount(server, 'EURGBP')
    mounted.push(m)
    await until(() => m.rebuilds.length > 0)
    expect(m.rebuilds.length).toBe(1)
    expect(server.blob.symbol).toBe(WALKED)
    expect(server.blob.cursor).toBe(CURSOR)
  })
})
