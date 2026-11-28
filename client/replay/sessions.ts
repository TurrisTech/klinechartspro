import type { SimSnapshot } from '../trading/api'
import { formatDuration } from '../trading/format'
import { Engine } from '../sim/engine'
import { type ReplayState, restore } from './persist'
import { type ReplayResults, replayResults } from './results'
import { tickerOf } from '../symbols'

// PURE. The replay sessions this owner has, as the start dialog's Sessions list shows them: which
// instrument each walks, where it started and how far it got, when it was last played, and its
// score -- the same figures the Results panel draws, worked out from the stored blob without
// mounting anything.
//
// The score comes from the BLOB's engine, never the server's snapshot of the session: a replay's
// engine runs in the client (engine.ts), so the server's copy of its account is the opening
// balance with no trades, however much was traded.

export interface ReplaySessionSummary {
  id: string
  /** `vendor:TICKER`, the instrument the replay walks: the blob's, or -- for a blob this client
   * cannot read -- the instrument the session was created on. */
  symbol: string
  ticker: string
  createdAt: number
  /** When it was last saved (`stampSaved`); null for a blob written before the stamp existed. */
  savedAt: number | null
  /** The readable blob, or null: such a session can be deleted, not resumed. */
  state: ReplayState | null
  /** Its score, from the blob's engine; null with no readable blob. */
  results: ReplayResults | null
}

/** A `SimSnapshot` of an engine: what the replay session hands every view (the dock, the
 * overlays, the Results panel), and what the Sessions list scores a stored engine with. */
export function snapshotOf(engine: Engine, meta: { id: string; name: string; createdAt: number; rev: number; symbol: string }): SimSnapshot {
  const quotes: SimSnapshot['quotes'] = {}
  for (const [k, q] of engine.quotes) quotes[k] = { time: q.time, bid: q.bid, ask: q.ask }
  return {
    id: meta.id,
    mode: 'replay',
    name: meta.name,
    createdAt: meta.createdAt,
    rev: meta.rev,
    account: {
      currency: engine.currency,
      initialBalance: engine.initialBalance,
      balance: engine.balance,
      unrealizedPnl: engine.unrealizedPnl(),
      equity: engine.equity()
    },
    quotes,
    orders: [...engine.orders.values()].map((o) => ({ ...o })),
    trades: [...engine.trades.values()].map((t) => ({ ...t })),
    symbols: [...new Set([meta.symbol, ...engine.quotes.keys()])].sort()
  }
}

/** Every replay session in `GET /sim/sessions`, most recently played first. Paper sessions share
 * the route and are left out. */
export function summarizeSessions(sessions: readonly SimSnapshot[]): ReplaySessionSummary[] {
  return sessions
    .filter((s) => s.mode === 'replay')
    .map(summarize)
    .sort((a, b) => lastPlayed(b) - lastPlayed(a) || b.createdAt - a.createdAt)
}

function summarize(session: SimSnapshot): ReplaySessionSummary {
  const state = restore(session.state)
  const symbol = state?.symbol ?? session.symbols[0] ?? ''
  return {
    id: session.id,
    symbol,
    ticker: tickerOf(symbol),
    createdAt: session.createdAt,
    savedAt: state?.savedAt ?? null,
    state,
    results: state ? score(session, state) : null
  }
}

function score(session: SimSnapshot, state: ReplayState): ReplayResults | null {
  try {
    const engine = Engine.fromState(state.engine)
    const snapshot = snapshotOf(engine, { id: session.id, name: session.name, createdAt: session.createdAt, rev: session.rev, symbol: state.symbol })
    return replayResults(snapshot, state.startedAt, state.cursor)
  } catch {
    // An engine the blob's shallow check let through but that will not rebuild: the session is
    // listed, unscored, and cannot be resumed either (the mount would fail the same way).
    return null
  }
}

/** When the session was last played, or created when no save says so. */
export function lastPlayed(s: ReplaySessionSummary): number {
  return s.savedAt ?? s.createdAt
}

/** The line under a session's dates: its trades, its win rate and how much it replayed --
 * "3 trades · 67% win · replayed 4d 2h". The P&L is the row's headline, not repeated here. */
export function sessionFacts(s: ReplaySessionSummary): string {
  const r = s.results
  if (!r) return 'Saved by another version: it can be deleted, not resumed'
  const parts: string[] = []
  const traded = r.closed + r.open
  if (traded === 0) parts.push('No trades')
  else {
    if (r.closed > 0) parts.push(`${r.closed} closed`)
    if (r.open > 0) parts.push(`${r.open} open`)
    if (r.winRate !== null) parts.push(`${r.winRate.toFixed(0)}% win`)
  }
  parts.push(`replayed ${formatDuration(r.span)}`)
  return parts.join(' · ')
}

/** Can it be resumed: a blob this client reads, whose engine rebuilds. */
export function resumable(s: ReplaySessionSummary): boolean {
  return s.state !== null && s.results !== null
}
