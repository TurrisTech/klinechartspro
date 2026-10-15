// ENTRIES AS TRADES, through the paper-trading fill engine (client/replay/engine.ts -- the port of
// the server's sim engine, kept to it by shared fixtures): a market order at the entry bar's
// close fills at its bid or ask, a stop or target fills where OANDA's rules say it does, across a
// gap at the worse (stop) or better (target) open, and a bar reaching both takes the stop.
//
// What the engine does not do, this does, at each path bar's CLOSE -- the only instant a decision
// can be made on a bar:
//
//   breakeven   the stop moves to the entry once a close is `breakevenAtR` R the trade's way
//   trailing    the stop follows the best close at `distance` once a close is `activateR` R in;
//               it only ever tightens, and a stop that would sit beyond the price closes instead
//   rule        a long (short) closes at the first close its exit rule holds
//   time        after `maxBars` bars of the entry's timeframe
//   opposite    an entry the other way closes what is open first
//
// Levels are computed from the entry bar's close (mid), then handed to the engine, which fills
// on the bid/ask -- so a long pays the spread on the way in and is stopped on the bid.
//
// PURE.

import type { ReplayBar } from '../replay/cache'
import { type BidAskBar, Engine, type Event, SimError } from '../replay/engine'
import type { LabEntry } from './entries'
import type { Compiled } from './expr'
import type { Readings } from './graph'
import type { Direction, ExitSpec, Level, Sizing } from './model'
import { lastAtOrBefore } from './sorted'

export type ExitReason = 'stop' | 'target' | 'breakeven' | 'trail' | 'rule' | 'time' | 'opposite' | 'end'

export interface LabTrade {
  id: string
  entry: LabEntry
  direction: Direction
  units: number
  openedAt: number
  openPrice: number
  stop: number | null
  target: number | null
  /** The stop's distance at entry, in price: what one R is. Null without a stop. */
  risk: number | null
  closedAt: number | null
  closePrice: number | null
  reason: ExitReason | null
  /** Quote currency, as the engine counts it. */
  pnl: number | null
  pips: number | null
  r: number | null
  barsHeld: number
}

export interface SkippedEntry {
  entry: LabEntry
  reason: string
}

export interface EquityPoint {
  t: number
  balance: number
}

export interface TradeStats {
  trades: number
  wins: number
  losses: number
  winRate: number | null
  netPnl: number
  netPips: number
  totalR: number | null
  avgR: number | null
  profitFactor: number | null
  /** Largest fall of the closed-trade balance from a peak, as a fraction of that peak. */
  maxDrawdown: number
  avgBarsHeld: number | null
  byReason: Partial<Record<ExitReason, number>>
}

export interface SimResult {
  trades: LabTrade[]
  skipped: SkippedEntry[]
  equity: EquityPoint[]
  stats: TradeStats
}

/** A bar as the engine folds it: its bid and ask, or its mid on both sides where the store has
 * no quotes (client/replay/session.ts `toBidAsk`, which this module cannot import without the
 * page's configuration). */
function bidAsk(bar: ReplayBar, symbol: string): BidAskBar {
  const bid = bar.bid ?? { o: bar.o, h: bar.h, l: bar.l, c: bar.c }
  const ask = bar.ask ?? { o: bar.o, h: bar.h, l: bar.l, c: bar.c }
  return {
    symbol,
    time: bar.open,
    end: bar.end,
    bidOpen: bid.o,
    bidHigh: bid.h,
    bidLow: bid.l,
    bidClose: bid.c,
    askOpen: ask.o,
    askHigh: ask.h,
    askLow: ask.l,
    askClose: ask.c
  }
}

/** What a level reads beyond its own numbers: an expression's environment for an entry. */
export type LevelEnv = (entry: LabEntry, reference: number) => import('./expr').ExprEnv

export interface SimInput {
  symbol: string
  entries: readonly LabEntry[]
  /** Path bars, store clock, ascending; bid/ask where the store has them (mid otherwise). */
  bars: readonly ReplayBar[]
  pathMs: number
  exits: ExitSpec
  sizing: Sizing
  pip: number
  readings: Readings
  /** Compiled `expr` levels, by role. */
  levels: { stop?: Compiled; target?: Compiled; trail?: Compiled }
  levelEnv: LevelEnv
  /** Whether the exit rule for a direction holds at a close; null for none. */
  exitRule: (direction: Direction) => ((t: number) => boolean) | null
}

interface Open {
  trade: LabTrade
  engineId: string
  bestClose: number
  breakeven: boolean
  trailing: boolean
  deadline: number | null
}

/** A level's price for an entry at `reference`, or null (no level, or not computable). */
export function levelPrice(
  level: Level | null,
  role: 'stop' | 'target' | 'trail',
  entry: LabEntry,
  reference: number,
  stopDistance: number | null,
  input: Pick<SimInput, 'pip' | 'readings' | 'levels' | 'levelEnv'>
): number | null {
  if (!level) return null
  const dir = entry.direction === 'long' ? 1 : -1
  // A stop or a trail sits behind the price, a target ahead of it.
  const sign = role === 'target' ? dir : -dir
  switch (level.kind) {
    case 'pips':
      return reference + sign * level.value * input.pip
    case 'atr': {
      const atr = input.readings.atr(level.period, level.interval ?? entry.signal.interval, entry.at)
      return atr === undefined ? null : reference + sign * level.mult * atr
    }
    case 'r':
      return stopDistance === null ? null : reference + sign * level.mult * stopDistance
    case 'expr': {
      const compiled = input.levels[role]
      const value = compiled?.number(input.levelEnv(entry, reference))
      return value === undefined ? null : value
    }
  }
}

/** A trailing stop's DISTANCE (a positive price difference), or null. */
function trailDistance(level: Level, entry: LabEntry, reference: number, input: SimInput): number | null {
  const price = levelPrice(level, 'trail', entry, reference, null, input)
  return price === null ? null : Math.abs(reference - price)
}

export function simulate(input: SimInput): SimResult {
  const { symbol, exits, sizing } = input
  const engine = new Engine(sizing.balance, 'quote')
  const trades: LabTrade[] = []
  const skipped: SkippedEntry[] = []
  const equity: EquityPoint[] = []
  const open = new Map<string, Open>()
  const entries = [...input.entries].sort((a, b) => a.at - b.at)
  const ends = input.bars.map((b) => b.end)
  let next = 0

  // Entries no path bar closes at are refused, not moved: taking one at a later close would be a
  // different trade, and at an earlier one a trade on information that did not exist yet.
  const closesAt = new Set(ends)
  const runnable: LabEntry[] = []
  for (const entry of entries) {
    if (closesAt.has(entry.at)) runnable.push(entry)
    else skipped.push({ entry, reason: lastAtOrBefore(ends, entry.at) < 0 || entry.at > (ends.at(-1) ?? 0) ? 'outside the simulated bars' : 'no path bar closes at the entry' })
  }

  const record = (state: Open, price: number, at: number, reason: ExitReason, pnl: number): void => {
    const t = state.trade
    const dir = t.direction === 'long' ? 1 : -1
    t.closedAt = at
    t.closePrice = price
    t.reason = reason
    t.pnl = pnl
    t.pips = ((price - t.openPrice) * dir) / input.pip
    t.r = t.risk ? ((price - t.openPrice) * dir) / t.risk : null
    open.delete(state.engineId)
    equity.push({ t: at, balance: engine.balance })
  }

  const closed = (events: Event[], reasonFor: (state: Open, event: Event) => ExitReason): void => {
    for (const event of events) {
      if (event.kind !== 'close' || !event.tradeId) continue
      const state = open.get(event.tradeId)
      if (!state) continue
      const engineTrade = engine.trades.get(event.tradeId)
      record(state, event.price ?? 0, event.time, reasonFor(state, event), engineTrade?.realizedPnl ?? 0)
    }
  }

  const stopReason = (state: Open, event: Event): ExitReason => {
    if (event.reason === 'take_profit') return 'target'
    if (event.reason === 'stop_loss') return state.trailing ? 'trail' : state.breakeven ? 'breakeven' : 'stop'
    return 'end'
  }

  const closeNow = (state: Open, reason: ExitReason): void => {
    try {
      closed(engine.closeTrade(state.engineId), () => reason)
    } catch (err) {
      if (!(err instanceof SimError)) throw err
    }
  }

  /** Move a stop, or close at the market when the new stop would already be behind the price. */
  const moveStop = (state: Open, stop: number, reason: ExitReason): void => {
    try {
      engine.modifyTrade(state.engineId, { stopLoss: stop })
      state.trade.stop = stop
    } catch (err) {
      if (!(err instanceof SimError)) throw err
      closeNow(state, reason)
    }
  }

  for (let b = 0; b < input.bars.length; b++) {
    const bar = input.bars[b]
    closed(engine.onBar(bidAsk(bar, symbol)), stopReason)
    const t = bar.end
    const mid = bar.c

    // Management, at this close, of every trade opened before it.
    for (const state of [...open.values()]) {
      const trade = state.trade
      trade.barsHeld++
      const dir = trade.direction === 'long' ? 1 : -1
      if ((mid - state.bestClose) * dir > 0) state.bestClose = mid
      if (state.deadline !== null && t >= state.deadline) {
        closeNow(state, 'time')
        continue
      }
      const rule = input.exitRule(trade.direction)
      if (rule?.(t)) {
        closeNow(state, 'rule')
        continue
      }
      const gain = (mid - trade.openPrice) * dir
      if (exits.breakevenAtR !== null && !state.breakeven && trade.risk && gain >= exits.breakevenAtR * trade.risk) {
        const better = trade.stop === null || (trade.openPrice - trade.stop) * dir > 0
        state.breakeven = true
        if (better) moveStop(state, trade.openPrice, 'breakeven')
        if (!open.has(state.engineId)) continue
      }
      if (exits.trail) {
        const activate = exits.trail.activateR <= 0 || (trade.risk !== null && gain >= exits.trail.activateR * trade.risk)
        if (activate) {
          const distance = trailDistance(exits.trail.distance, trade.entry, state.bestClose, input)
          if (distance !== null) {
            const candidate = state.bestClose - dir * distance
            if (trade.stop === null || (candidate - trade.stop) * dir > 0) {
              state.trailing = true
              moveStop(state, candidate, 'trail')
            }
          }
        }
      }
    }

    // Entries at this close.
    while (next < runnable.length && runnable[next].at <= t) {
      const entry = runnable[next++]
      if (entry.at !== t) continue
      if (exits.onOpposite) {
        for (const state of [...open.values()]) if (state.trade.direction !== entry.direction) closeNow(state, 'opposite')
      }
      if (open.size >= sizing.maxOpen) {
        skipped.push({ entry, reason: `${sizing.maxOpen} trade${sizing.maxOpen === 1 ? '' : 's'} already open` })
        continue
      }
      const stop = levelPrice(exits.stop, 'stop', entry, mid, null, input)
      if (exits.stop && stop === null) {
        skipped.push({ entry, reason: 'the stop could not be computed (an indicator still warming up?)' })
        continue
      }
      const risk = stop === null ? null : Math.abs(mid - stop)
      const target = levelPrice(exits.target, 'target', entry, mid, risk, input)
      if (exits.target && target === null) {
        skipped.push({ entry, reason: 'the target could not be computed' })
        continue
      }
      const units =
        sizing.mode === 'risk' && risk !== null && risk > 0 ? Math.max(1, Math.floor((engine.balance * sizing.riskPercent) / 100 / risk)) : sizing.units
      let order: ReturnType<Engine['submit']>
      try {
        order = engine.submit({ symbol, side: entry.direction === 'long' ? 'buy' : 'sell', type: 'market', units, stopLoss: stop, takeProfit: target, label: entry.id })
      } catch (err) {
        if (!(err instanceof SimError)) throw err
        skipped.push({ entry, reason: err.message })
        continue
      }
      const fill = order.events.find((e) => e.kind === 'fill')
      const engineId = order.order.tradeId
      if (!fill || !engineId) {
        skipped.push({ entry, reason: 'the order did not fill' })
        continue
      }
      const openPrice = fill.price ?? mid
      const trade: LabTrade = {
        id: engineId,
        entry,
        direction: entry.direction,
        units,
        openedAt: t,
        openPrice,
        stop,
        target,
        risk: stop === null ? null : Math.abs(openPrice - stop),
        closedAt: null,
        closePrice: null,
        reason: null,
        pnl: null,
        pips: null,
        r: null,
        barsHeld: 0
      }
      trades.push(trade)
      const deadline = exits.maxBars ? deadlineOf(ends, b, exits.maxBars.count, exits.maxBars.interval ? null : entry.signal.durationMs, input.pathMs, exits.maxBars.interval) : null
      open.set(engineId, { trade, engineId, bestClose: mid, breakeven: false, trailing: false, deadline })
    }
  }

  // Whatever is still open is closed at the last close, and says so.
  closed(engine.flatten(symbol), () => 'end')
  return { trades, skipped, equity, stats: tradeStats(trades, sizing.balance) }
}

/** When a time exit falls: `count` bars of the entry's timeframe (or of `interval`) after the
 * path bar `b` the trade opened on, counted in path bars. */
function deadlineOf(ends: readonly number[], b: number, count: number, entryMs: number | null, pathMs: number, interval: string | null): number | null {
  let ms = entryMs
  if (ms === null && interval) {
    const m = /^(\d+)([smhDW])$/.exec(interval)
    const unit: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, D: 86_400_000, W: 604_800_000 }
    ms = m ? Number(m[1]) * unit[m[2]] : null
  }
  if (ms === null) return null
  const steps = Math.max(1, Math.round((count * ms) / pathMs))
  const at = b + steps
  return at < ends.length ? ends[at] : null
}

export function tradeStats(trades: readonly LabTrade[], balance: number): TradeStats {
  const done = trades.filter((t) => t.closedAt !== null && t.pnl !== null)
  const wins = done.filter((t) => (t.pnl as number) > 0)
  const losses = done.filter((t) => (t.pnl as number) < 0)
  const grossWin = wins.reduce((a, t) => a + (t.pnl as number), 0)
  const grossLoss = -losses.reduce((a, t) => a + (t.pnl as number), 0)
  const rs = done.map((t) => t.r).filter((r): r is number => r !== null)
  let peak = balance
  let equity = balance
  let maxDrawdown = 0
  for (const t of [...done].sort((a, b) => (a.closedAt as number) - (b.closedAt as number))) {
    equity += t.pnl as number
    if (equity > peak) peak = equity
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak)
  }
  const byReason: Partial<Record<ExitReason, number>> = {}
  for (const t of done) if (t.reason) byReason[t.reason] = (byReason[t.reason] ?? 0) + 1
  return {
    trades: done.length,
    wins: wins.length,
    losses: losses.length,
    winRate: done.length > 0 ? wins.length / done.length : null,
    netPnl: done.reduce((a, t) => a + (t.pnl as number), 0),
    netPips: done.reduce((a, t) => a + (t.pips ?? 0), 0),
    totalR: rs.length > 0 ? rs.reduce((a, b) => a + b, 0) : null,
    avgR: rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Number.POSITIVE_INFINITY : null,
    maxDrawdown,
    avgBarsHeld: done.length > 0 ? done.reduce((a, t) => a + t.barsHeld, 0) / done.length : null,
    byReason
  }
}
