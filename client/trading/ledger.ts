import type { SimAccount, SimSnapshot, SimTrade } from './api'
import { pairCurrencies } from './metrics'

// The account through time, from its trades. PURE (ledger.test.ts).
//
// The engine moves the balance in exactly one way: a trade closing adds its realised P&L
// (wdashboard_server/sim/engine.py `_close`; a partial close carves the closed units into a
// trade of their own first, so every change is one closed trade). So the balance at any instant
// is today's balance less what has closed since -- anchored on the balance the server reports,
// never re-summed forward from the initial deposit, so the newest figure always agrees with the
// account strip.
//
// Equity is the balance plus what the trades open at that instant were worth, marked on the
// closing side by the engine. Here a past mark is a stored bar's close (the mid) -- the bars carry
// no spread -- so a past equity figure is the engine's less half a spread per open trade; the
// newest is the engine's own.

/** The trades that have closed, oldest close first; ties keep the snapshot's order. */
export function closedTrades(snapshot: Pick<SimSnapshot, 'trades'>): SimTrade[] {
  return snapshot.trades
    .map((trade, index) => ({ trade, index }))
    .filter(({ trade }) => trade.closedAt !== null)
    .sort((a, b) => (a.trade.closedAt as number) - (b.trade.closedAt as number) || a.index - b.index)
    .map(({ trade }) => trade)
}

/** The balance each closed trade was realised against -- the balance just before it closed --
 * by trade id. */
export function balancesBefore(snapshot: Pick<SimSnapshot, 'trades' | 'account'>): Map<string, number> {
  const out = new Map<string, number>()
  let running = snapshot.account.balance
  const closed = closedTrades(snapshot)
  for (let i = closed.length - 1; i >= 0; i--) {
    running -= closed[i].realizedPnl ?? 0
    out.set(closed[i].id, running)
  }
  return out
}

/** A closed trade's realised P&L in the account currency, where its own close says the rate:
 * the account IS the quote (1:1), IS the base (at the close price), or the ticker names no
 * currency (the engine books it in the account's). A cross has no rate of its own at the time it
 * closed, so it gets none -- the open-trade rule (metrics.ts) borrows a held quote, which is a
 * rate for NOW, not for then. */
export function realisedInAccount(trade: SimTrade, account: Pick<SimAccount, 'currency'>): number | null {
  if (trade.realizedPnl === null) return null
  const pair = pairCurrencies(trade.symbol)
  if (!pair || pair.quote === account.currency) return trade.realizedPnl
  if (pair.base === account.currency && trade.closePrice !== null && trade.closePrice > 0) {
    return trade.realizedPnl / trade.closePrice
  }
  return null
}

/** A closed trade's realised P&L as a percentage of the balance it was realised against, or null
 * where it does not convert (see `realisedInAccount`). */
export function closedShareOfBalance(trade: SimTrade, before: number | undefined, account: Pick<SimAccount, 'currency'>): number | null {
  const amount = realisedInAccount(trade, account)
  if (amount === null || before === undefined || !(before > 0)) return null
  return (amount / before) * 100
}

/** The price a closed trade moved in its favour, in pips (null off the pip instruments). */
export function closedMove(trade: SimTrade): number | null {
  if (trade.closePrice === null) return null
  return trade.side === 'buy' ? trade.closePrice - trade.entryPrice : trade.entryPrice - trade.closePrice
}

/** The balance at each instant of `times` (ascending): today's balance less every close after
 * it. A trade closing exactly at an instant has closed by it. */
export function balanceSeries(snapshot: Pick<SimSnapshot, 'trades' | 'account'>, times: readonly number[]): number[] {
  const closed = closedTrades(snapshot)
  const out = new Array<number>(times.length)
  let running = snapshot.account.balance
  let j = closed.length - 1
  for (let i = times.length - 1; i >= 0; i--) {
    while (j >= 0 && (closed[j].closedAt as number) > times[i]) {
      running -= closed[j].realizedPnl ?? 0
      j--
    }
    out[i] = running
  }
  return out
}

/** Whether a trade was open at instant `t`: filled at or before it, not closed by it. */
export function openAt(trade: SimTrade, t: number): boolean {
  return trade.openedAt <= t && (trade.closedAt === null || trade.closedAt > t)
}

/** A trade's worth at a mark, as the engine books it: the move times the units, in the quote
 * currency, summed into the balance without conversion. */
export function markToMarket(trade: SimTrade, mark: number): number {
  return (trade.side === 'buy' ? mark - trade.entryPrice : trade.entryPrice - mark) * trade.units
}

/** Where an instrument stood at an instant: the close of the last bar that had closed by then,
 * or null when none had. */
export type MarkAt = (symbol: string, t: number) => number | null

export interface EquityPoint {
  equity: number
  /** Open trades at that instant with no bar to mark them by, counted at their entry. */
  unmarked: number
}

/** Equity at each instant of `times` (ascending), from the balance then and the open trades
 * marked by `markAt`. */
export function equitySeries(
  snapshot: Pick<SimSnapshot, 'trades' | 'account'>,
  times: readonly number[],
  markAt: MarkAt
): EquityPoint[] {
  const balances = balanceSeries(snapshot, times)
  return times.map((t, i) => {
    let equity = balances[i]
    let unmarked = 0
    for (const trade of snapshot.trades) {
      if (!openAt(trade, t)) continue
      const mark = markAt(trade.symbol, t)
      if (mark === null) unmarked += 1
      else equity += markToMarket(trade, mark)
    }
    return { equity, unmarked }
  })
}
