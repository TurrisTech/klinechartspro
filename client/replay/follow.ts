import type { ReplayState } from './persist'
import { type CandleGrid, type Schedule, gridOf, sortByLength, validateBase } from './timeframes'

// PURE. A replay FOLLOWING the chart to another instrument (2026-10-29; the user switched a
// replaying pane from EURGBP to EURUSD and nothing followed: the replay kept walking EURGBP under
// a chart showing EURUSD).
//
// A replay walks one instrument -- the walk, the quote, the price watches, the fills and the
// title bar are all that one's -- and that rule stays. What changes is WHICH one: when the active
// pane is moved to another instrument, the replay moves with it, at the same cursor, in the same
// session and the same paper account. The move is the blob rewritten for the new instrument and
// the wall rebuilt from it exactly as a reload rebuilds it (index.ts: `bootReplay` and
// `mountBarReplay`, so the new instrument's market hours and stored intervals are resolved as a
// mount resolves them), which is why nothing else in the replay had to learn that an instrument
// can change: every session still has one for its whole life.
//
// It moves only when nothing is left open on the instrument it walks: no open trade, no pending
// order, no armed price watch (`FollowBlockers`). Each of those is evaluated by the walk and only
// by the walk, so leaving one behind would leave a stop loss nothing could hit, an order nothing
// could fill, a line nothing could fire -- silently, under a chart showing something else.
// Otherwise the replay keeps walking the old instrument and the controls say so, and what to do
// (session.ts `followNotice`, controls.ts).
//
// What the account keeps of the instrument left (`movedState`):
// - its CLOSED trades and their P&L -- they are the session's history, and Results scores them;
// - its last QUOTE, frozen at the cursor it was left at. It marks nothing (nothing is open on it)
//   and prices nothing: the session refuses an order on any instrument but the one it walks.
// What it does not keep:
// - the instrument left's price watches, none of them armed by then (a follow waits for that):
//   fired or switched off, they could never fire again, and a stored line nothing evaluates is the
//   thing `canWatch` refuses to create in the first place;
// - a quote of the instrument FOLLOWED kept from an earlier walk of it: it is the price of then,
//   not of now, and dropping it is what makes the new wall quote it at the cursor (`primeQuote`).

/** What keeps a replay on the instrument it walks: everything only its walk evaluates. */
export interface FollowBlockers {
  /** Open trades on the walked instrument. */
  trades: number
  /** Pending (resting) orders on it. */
  orders: number
  /** Armed price watches -- every replay watch is on it (`canWatch` refuses any other). */
  watches: number
}

/** The chart is on an instrument the replay has not followed: which, and why it has not. */
export interface FollowNotice {
  /** `vendor:TICKER` the active pane moved to. */
  symbol: string
  ticker: string
  /** Why it cannot be walked (no market hours, nothing stored, a failed save), or null when what
   * keeps the replay is something open on its own instrument -- `FollowBlockers`, read live. */
  problem: string | null
  /** A follow is being made: the wall rebuilds when it lands. */
  moving: boolean
}

export function blocked(b: FollowBlockers): boolean {
  return b.trades + b.orders + b.watches > 0
}

/** "1 open trade, 2 pending orders and 1 armed price watch" -- what the notice says keeps it. */
export function describeBlockers(b: FollowBlockers): string {
  const parts = [
    count(b.trades, 'open trade'),
    count(b.orders, 'pending order'),
    count(b.watches, 'armed price watch', 'armed price watches')
  ].filter((p): p is string => p !== null)
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/** What to do about them, as one imperative: "Close or cancel them". */
export function undoBlockers(b: FollowBlockers): string {
  const verbs = [b.trades > 0 ? 'close' : null, b.orders > 0 ? 'cancel' : null, b.watches > 0 ? 'remove' : null].filter((v): v is string => v !== null)
  const said = verbs.length <= 1 ? (verbs[0] ?? 'close') : `${verbs.slice(0, -1).join(', ')} or ${verbs.at(-1)}`
  const one = b.trades + b.orders + b.watches === 1
  return `${said.charAt(0).toUpperCase()}${said.slice(1)} ${one ? 'it' : 'them'}`
}

function count(n: number, one: string, many = `${one}s`): string | null {
  return n <= 0 ? null : `${n} ${n === 1 ? one : many}`
}

/** What walking an instrument needs, resolved as a mount resolves it: its candle grid (from its
 * market hours), what the store holds of it at the cursor, and the panes' intervals as they stand
 * then. Or why it cannot be walked. */
export type FollowResolution = { grid: CandleGrid; stored: readonly string[]; inUse: readonly string[] } | { problem: string }

/** The instrument the chart moved to, and how to find out whether it can be walked. */
export interface FollowTarget {
  /** `vendor:TICKER`, the engine's instrument key. */
  symbol: string
  vendor: string
  /** The ticker alone, as the controls name it. */
  ticker: string
  resolve(at: number): Promise<FollowResolution>
}

/** How index.ts resolves a target: the two reads a mount makes, and the wall's panes. Injected so
 * the decisions below are tested without a server. */
export interface FollowSources {
  /** The instrument's market hours: a pane's resolved ones when one shows it, else the server's
   * (index.ts `replayScheduleFor`, what a mount asks). */
  schedule(symbol: string): Promise<Schedule | null>
  /** Which stored intervals the store holds for it around `at` (index.ts `storedIntervalsFor`). */
  stored(symbol: string, at: number, grid: CandleGrid): Promise<string[]>
  /** The wall's pane intervals, read when the follow resolves rather than when the pane moved: a
   * pane moved to an instrument without its timeframe (5s for a metal) has its period replaced
   * straight after the move, and a base is chosen against what the wall shows. */
  intervalsInUse(): readonly string[]
}

/** The follow target for an instrument the active pane now shows. No schedule is never guessed
 * (CLAUDE.md: never hardcode a zone), and an instrument the store holds nothing of at the cursor
 * would open a wall with no bars: both are reasons not to follow, said in the notice -- where a
 * mount meeting them would have LEFT the replay, throwing the session away. */
export function followTarget(instrument: { symbol: string; vendor: string; ticker: string }, sources: FollowSources): FollowTarget {
  const { symbol, vendor, ticker } = instrument
  return {
    symbol,
    vendor,
    ticker,
    async resolve(at) {
      const schedule = await sources.schedule(symbol)
      if (!schedule) return { problem: `No market hours for ${ticker}` }
      const grid = gridOf(schedule)
      const stored = await sources.stored(symbol, at, grid)
      if (stored.length === 0) return { problem: `No stored bars for ${ticker} at the replay’s clock` }
      return { grid, stored, inUse: sources.intervalsInUse() }
    }
  }
}

/** Whether a symbol change reported for `paneId` is the replay's business: it is when the pane is
 * the ACTIVE one (a wall following its active pane fans the change out to the others, each
 * reported in turn, and a replay wall can mix instruments) -- `'follow'`, or `'back'` when the
 * pane is back on the instrument the replay walks, which withdraws any notice. Activating a pane
 * that shows another instrument is not a request: only moving one is. */
export function followRequest(paneId: string, activePaneId: string, symbol: string, walked: string): 'back' | 'follow' | null {
  if (paneId !== activePaneId) return null
  return symbol === walked ? 'back' : 'follow'
}

/** Whether a wall just mounted on a replay has moved away from the instrument it walks: no pane
 * shows it. A wall rebuilt from what is saved -- Revert, a reload that let an unsaved draft go, a
 * workspace switched mid-replay, a `?symbol=` link reloaded -- can come back like that, and it is
 * the active pane moved off the instrument walked: the same request as a pick. A wall where any
 * pane still shows it is a replay wall mixing instruments, and stays as it is. */
export function followOnMount(paneSymbols: readonly string[], active: string | null, walked: string): boolean {
  return active !== null && active !== walked && !paneSymbols.includes(walked)
}

/** The base a followed replay walks. The one it walks now, when the new instrument stores it, it
 * still tiles every pane, and no candle of it on the new instrument's grid straddles the cursor;
 * otherwise the coarsest stored interval that does all three. Null when none does.
 *
 * The straddle is the cross-schedule case: a 1D base followed from the FX week (days close 17:00
 * New York) to a coinbase pair (midnight UTC) leaves the cursor inside a coinbase day, and a walk
 * that starts inside a base candle either skips its head or -- for the quote -- reads the bar
 * that closed before it, a day stale. The session keeps the cursor on a base boundary everywhere
 * else (`onBaseBoundary`, `alertStop`), so a follow does too, by choosing the base, not by moving
 * the cursor. A cursor in the closed window straddles nothing: no candle is open there. */
export function followBase(current: string, inUse: readonly string[], stored: readonly string[], grid: CandleGrid, cursor: number): string | null {
  const straddles = (code: string): boolean => grid.start(code, cursor) < cursor && grid.end(code, cursor) > cursor
  const fits = (code: string): boolean => validateBase(code, inUse, stored).ok && !straddles(code)
  if (fits(current)) return current
  return sortByLength(stored).reverse().find(fits) ?? null
}

/** This replay's blob, moved to walk `to` instead: the same session, cursor, start, advance and
 * account -- see the head of this file for what of the instrument left it keeps. */
export function movedState(current: ReplayState, to: { symbol: string; vendor: string }, base: string): ReplayState {
  const quotes = { ...current.engine.quotes }
  delete quotes[to.symbol]
  return {
    ...current,
    vendor: to.vendor,
    symbol: to.symbol,
    base,
    watches: current.watches.filter((w) => w.wire.target === to.symbol),
    engine: { ...current.engine, quotes }
  }
}
