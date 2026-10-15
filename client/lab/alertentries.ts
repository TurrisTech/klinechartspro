// A SAVED STRATEGY'S ENTRIES AS AN ALERT OPERAND (client/alerts `{ kind: 'strategy' }`): the bars of
// one timeframe where the strategy's own run (./runner.ts) finds an entry, each labelled with the
// way it trades -- so "tell me when the rank 85 graph strategy enters on 5m" is an alert, and a
// bar replay's Next alert stops on it.
//
// The engine runs the SAVED strategy, read when it is asked, so an alert follows the strategy as
// it is refined and saved in the lab. Over a window starting where the alert first evaluates: a
// graph in force then began at a root inside the root's lookback, which the run reads back to on
// its own (as the graph-entry operand does, client/alerts/graphentry.ts).
//
// When an answer is FINAL: a bar of the operand's timeframe that closed more than `LATE_MS` before
// the run's end. A strategy's signals are written by the research feed a little after their bar
// closes (and the outlier rows are computed per read from arev21's), so a bar closed just now may
// still gain an entry; the alert monitor waits on a bar after `through`, bounded, as it does for
// every server value (notes/architecture/freshness-horizons.md).

import { loadServerCatalogue } from '../alerts/catalogue'
import type { Point } from '../alerts/data'
import type { Operand } from '../alerts/types'
import type { CandleGrid } from '../replay/timeframes'
import { HttpLabData, type LabData } from './data'
import { runStrategy } from './runner'
import { sharedStrategyStore, type StrategyStore } from './store'

export type StrategyOperand = Extract<Operand, { kind: 'strategy' }>

/** How long after a bar's close a strategy's answer on it is taken as final. */
export const LATE_MS = 2 * 60_000

export interface StrategyEntries {
  points: Point[]
  /** The newest wire date on the operand's timeframe whose answer is final, or null. */
  through: number | null
}

/** The open of the last `interval` bar closed by `at`. */
export function lastClosedOpen(grid: CandleGrid, interval: string, at: number): number {
  const open = grid.start(interval, at)
  return grid.end(interval, open) <= at ? open : grid.start(interval, open - 1)
}

export class StrategyEntryEngine {
  constructor(
    private readonly data: LabData = new HttpLabData(),
    private readonly store: () => Promise<StrategyStore> = sharedStrategyStore,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** The operand's entries over `[from, to]` (absolute), `to` capped at now. */
  async entries(symbol: string, operand: StrategyOperand, from: number, to: number): Promise<StrategyEntries> {
    const strategies = await this.store()
    const strategy = strategies.get(operand.strategy)
    const grid = await this.data.grid(symbol)
    if (!strategy || !grid) return { points: [], through: null }
    const end = Math.min(to, this.now())
    if (end <= from) return { points: [], through: null }
    const catalogue = await loadServerCatalogue().catch(() => null)
    const run = await runStrategy(strategy, this.data, { symbol, from, to: end, catalogue, simulate: false })
    const points: Point[] = run.entries.filter((e) => e.signal.interval === operand.interval).map((e) => ({ date: e.signal.sourceDate, signal: e.direction }))
    const final = lastClosedOpen(grid, operand.interval, end - LATE_MS)
    return { points, through: final >= from ? grid.toWire(operand.interval, final) : null }
  }
}
