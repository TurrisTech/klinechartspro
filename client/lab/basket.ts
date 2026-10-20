// A BASKET RUN: one strategy over many instruments -- the NNFX "x of 28 pairs" view -- a row of
// figures per instrument (figures.ts) and the pooled trades of all of them.
//
// Each instrument is a full run of the same draft on that instrument, a few at a time. Only the
// figures are kept: a run holds its bars, and 28 of them held at once would be the page's whole
// memory. Money is in each instrument's own quote currency, so it is not summed; R and pips are.
//
// PURE, but for the run it is handed.

import { type Figures, figuresOf, type Part } from './figures'
import type { LabRun } from './runner'
import { type MeanStats, meanStats } from './stats'

/** The seven majors, OANDA's names. */
export const MAJORS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD']

/** Every pair of the eight major currencies, each named the way the market quotes it: the
 * earlier currency of EUR GBP AUD NZD USD CAD CHF JPY is the base. */
export const FX_28: string[] = (() => {
  const order = ['EUR', 'GBP', 'AUD', 'NZD', 'USD', 'CAD', 'CHF', 'JPY']
  const out: string[] = []
  for (let a = 0; a < order.length; a++) for (let b = a + 1; b < order.length; b++) out.push(`${order[a]}${order[b]}`)
  return out
})()

export interface BasketRow {
  symbol: string
  all: Figures | null
  fit: Figures | null
  holdout: Figures | null
  /** Every closed trade's R, by part: what the pooled figures read. */
  rs: Record<Part, number[]>
  error: string | null
}

export interface BasketPool {
  instruments: number
  /** Instruments whose total R is above zero, of those with trades. */
  positive: number
  withTrades: number
  entries: number
  trades: number
  winRate: number | null
  totalR: number
  r: MeanStats
  netPips: number
  holdout: MeanStats | null
}

/** Run on every symbol, `concurrency` at a time, handing each row on as it lands (in the order
 * they finish; `index` is the symbol's place in the list). */
export async function runBasket(
  symbols: readonly string[],
  run: (symbol: string) => Promise<LabRun>,
  onRow: (row: BasketRow, index: number) => void,
  isCancelled: () => boolean,
  concurrency = 2
): Promise<BasketRow[]> {
  const rows: BasketRow[] = new Array(symbols.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < symbols.length && !isCancelled()) {
      const index = next++
      const symbol = symbols[index]
      let row: BasketRow
      try {
        row = rowOf(symbol, await run(symbol))
      } catch (err) {
        if (isCancelled()) return
        row = { symbol, all: null, fit: null, holdout: null, rs: { all: [], fit: [], holdout: [] }, error: err instanceof Error ? err.message : String(err) }
      }
      rows[index] = row
      onRow(row, index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, symbols.length)) }, worker))
  return rows.filter(Boolean)
}

function rowOf(symbol: string, run: LabRun): BasketRow {
  const split = run.split
  const closed = (run.sim?.trades ?? []).filter((t) => t.closedAt !== null && t.r !== null).sort((a, b) => (a.closedAt as number) - (b.closedAt as number))
  const rsOf = (keep: (openedAt: number) => boolean): number[] => closed.filter((t) => keep(t.openedAt)).map((t) => t.r as number)
  return {
    symbol,
    all: figuresOf(run),
    fit: split !== null ? figuresOf(run, 'fit') : null,
    holdout: split !== null ? figuresOf(run, 'holdout') : null,
    rs: {
      all: rsOf(() => true),
      fit: split === null ? rsOf(() => true) : rsOf((at) => at < split),
      holdout: split === null ? [] : rsOf((at) => at >= split)
    },
    error: null
  }
}

/** Every instrument's trades taken together. */
export function poolBasket(rows: readonly BasketRow[]): BasketPool {
  const ok = rows.filter((r) => r.all)
  const all = ok.flatMap((r) => r.rs.all)
  const wins = ok.reduce((a, r) => a + Math.round((r.all?.winRate ?? 0) * (r.all?.trades ?? 0)), 0)
  const trades = ok.reduce((a, r) => a + (r.all?.trades ?? 0), 0)
  const withTrades = ok.filter((r) => (r.all?.trades ?? 0) > 0)
  const holdout = ok.flatMap((r) => r.rs.holdout)
  return {
    instruments: ok.length,
    positive: withTrades.filter((r) => (r.all?.totalR ?? 0) > 0).length,
    withTrades: withTrades.length,
    entries: ok.reduce((a, r) => a + (r.all?.entries ?? 0), 0),
    trades,
    winRate: trades > 0 ? wins / trades : null,
    totalR: all.reduce((a, b) => a + b, 0),
    r: meanStats(all),
    netPips: ok.reduce((a, r) => a + (r.all?.netPips ?? 0), 0),
    holdout: ok.some((r) => r.holdout) ? meanStats(holdout) : null
  }
}
