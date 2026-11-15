import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import type { SimSnapshot } from '../trading/api'
import { Engine } from './engine'
import { formatSpan } from './format'
import { type ReplayState, serialize, stampSaved } from './persist'

// The trading formatters reach config.ts, which reads `window` at import.
installWindow()
const { replayResults } = await import('./results')
const { lastPlayed, resumable, sessionFacts, snapshotOf, summarizeSessions } = await import('./sessions')

// The Sessions list's half of the contract, with no DOM: which sessions are listed and in what
// order, and that each is scored from its OWN blob's engine exactly as the Results panel scores
// the session while it runs.

const SYM = 'oanda:EURUSD'
const H = 3_600_000
const STARTED = Date.UTC(2023, 0, 3, 22, 0)

function engineThatTraded(): Engine {
  const engine = new Engine(10_000)
  engine.onQuote({ symbol: SYM, time: STARTED, bid: 1.1, ask: 1.1 })
  const first = engine.submit({ symbol: SYM, side: 'buy', type: 'market', units: 10_000 }).order
  engine.onQuote({ symbol: SYM, time: STARTED + H, bid: 1.105, ask: 1.105 })
  engine.closeTrade(first.tradeId as string)
  // A second, still open, marked to the last quote.
  engine.submit({ symbol: SYM, side: 'sell', type: 'market', units: 10_000 })
  engine.onQuote({ symbol: SYM, time: STARTED + 2 * H, bid: 1.104, ask: 1.104 })
  return engine
}

function blob(engine: Engine, cursor = STARTED + 2 * H): ReplayState {
  return serialize({ vendor: 'oanda', symbol: SYM, cursor, startedAt: STARTED, base: '1m', advance: { interval: '1h', multiple: 1 }, pauseOnFill: false, watches: [], engine: engine.toState() })
}

function session(id: string, over: Partial<SimSnapshot> = {}): SimSnapshot {
  return {
    id,
    mode: 'replay',
    name: 'Replay',
    createdAt: 1_000,
    rev: 1,
    account: { currency: 'USD', initialBalance: 10_000, balance: 10_000, unrealizedPnl: 0, equity: 10_000 },
    quotes: {},
    orders: [],
    trades: [],
    symbols: [SYM],
    state: blob(new Engine(10_000)),
    ...over
  }
}

describe('summarizeSessions', () => {
  test('lists replays only, most recently played first; an unstamped one by when it was created', () => {
    const list = summarizeSessions([
      session('paper', { mode: 'paper' }),
      session('old-unstamped', { createdAt: 100 }),
      session('played-yesterday', { createdAt: 50, state: stampSaved(blob(new Engine()), 5_000) }),
      session('played-today', { createdAt: 10, state: stampSaved(blob(new Engine()), 9_000) }),
      session('new-unstamped', { createdAt: 6_000 })
    ])
    expect(list.map((s) => s.id)).toEqual(['played-today', 'new-unstamped', 'played-yesterday', 'old-unstamped'])
    expect(list.map(lastPlayed)).toEqual([9_000, 6_000, 5_000, 100])
    expect(list[0].savedAt).toBe(9_000)
    expect(list[1].savedAt).toBeNull()
  })

  test("scores the blob's engine, the same figures the running session's Results panel shows", () => {
    const engine = engineThatTraded()
    const state = blob(engine)
    // The server's account for a replay never moves -- its engine is the client's.
    const [s] = summarizeSessions([session('a', { state })])
    const live = replayResults(snapshotOf(engine, { id: 'a', name: 'Replay', createdAt: 1_000, rev: 1, symbol: SYM }), STARTED, state.cursor)
    expect(s.results).toEqual(live)
    expect(s.results?.closed).toBe(1)
    expect(s.results?.open).toBe(1)
    // +0.005 x 10,000 realised on the long; the short sold at 1.105, marked at 1.104: +0.001 x 10,000.
    expect(s.results?.realised).toBeCloseTo(50, 9)
    expect(s.results?.unrealised).toBeCloseTo(10, 9)
    expect(s.results?.span).toBe(2 * H)
    expect(s.ticker).toBe('EURUSD')
    expect(resumable(s)).toBe(true)
  })

  test('a blob this client cannot read is listed on the instrument it was created on, unscored', () => {
    const [s] = summarizeSessions([session('v0', { state: { version: 0 }, symbols: ['oanda:GBPUSD'] })])
    expect(s.state).toBeNull()
    expect(s.results).toBeNull()
    expect(s.symbol).toBe('oanda:GBPUSD')
    expect(resumable(s)).toBe(false)
    expect(sessionFacts(s)).toBe('Saved by another version: it can be deleted, not resumed')
  })

  test('an engine that passes the shallow check but will not rebuild is not resumable either', () => {
    const state = { ...blob(new Engine()), engine: { orders: [], trades: [], quotes: null } }
    const [s] = summarizeSessions([session('broken', { state })])
    expect(s.state).not.toBeNull()
    expect(s.results).toBeNull()
    expect(resumable(s)).toBe(false)
  })

  test('a session that was never saved has no state', () => {
    const [s] = summarizeSessions([session('fresh', { state: null })])
    expect(s.state).toBeNull()
    expect(resumable(s)).toBe(false)
  })
})

describe('sessionFacts', () => {
  test('trades, win rate and time replayed; open trades when there are any', () => {
    const [traded] = summarizeSessions([session('a', { state: blob(engineThatTraded()) })])
    expect(sessionFacts(traded)).toBe('1 closed · 1 open · 100% win · replayed 2h 00m')
    const [idle] = summarizeSessions([session('b', { state: blob(new Engine(), STARTED + 3 * 86_400_000) })])
    expect(sessionFacts(idle)).toBe('No trades · replayed 3d 0h')
    // Open only: no "0 closed", and no win rate before the first close.
    const engine = new Engine(10_000)
    engine.onQuote({ symbol: SYM, time: STARTED, bid: 1.1, ask: 1.1 })
    engine.submit({ symbol: SYM, side: 'buy', type: 'market', units: 1_000 })
    const [open] = summarizeSessions([session('c', { state: blob(engine, STARTED + H) })])
    expect(sessionFacts(open)).toBe('1 open · replayed 1h 00m')
  })
})

describe('formatSpan', () => {
  test('the year once, unless the replay crossed into another', () => {
    expect(formatSpan(STARTED, Date.UTC(2023, 0, 20, 14, 0), 'America/New_York')).toBe('Tue, Jan 03, 2023, 17:00:00 → Fri, Jan 20, 09:00:00')
    expect(formatSpan(Date.UTC(2023, 11, 29, 22, 0), Date.UTC(2024, 0, 2, 14, 0), 'UTC')).toBe('Fri, Dec 29, 2023, 22:00:00 → Tue, Jan 02, 2024, 14:00:00')
  })
})
