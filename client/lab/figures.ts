// A RUN IN A ROW OF NUMBERS: what every comparison reads -- the baseline beside the current run,
// the fitting part of the window beside its holdout, a sweep's values, a basket's instruments.
// One definition of each figure, with which way is better, so they are counted and coloured
// alike everywhere.
//
// PURE.

import type { LabRun } from './runner'
import { type MeanStats, meanStats } from './stats'
import { type LabTrade, tradeStats } from './trades'

export interface Figures {
  entries: number
  longs: number
  trades: number
  winRate: number | null
  totalR: number | null
  avgR: number | null
  /** The t-statistic of the mean R and its bootstrap interval (stats.ts). */
  r: MeanStats
  profitFactor: number | null
  maxDrawdown: number | null
  netPips: number
  netPnl: number
  /** Forward pips after the longest outcome horizon, per entry: mean, t and interval. */
  forward: MeanStats
  forwardBars: number | null
}

export type Part = 'all' | 'fit' | 'holdout'

/** Whether an instant falls in `part` of a run split at `split`. */
export function inPart(at: number, part: Part, split: number | null): boolean {
  if (part === 'all') return true
  // With no holdout, all of the window is fitting.
  if (split === null) return part === 'fit'
  return part === 'fit' ? at < split : at >= split
}

/** The run's figures over all of it, or over the part before (`fit`) or from (`holdout`) its
 * split. An entry belongs to the part its instant falls in, a trade to the part it opened in. */
export function figuresOf(run: LabRun, part: Part = 'all'): Figures {
  const split = run.split
  const entries = run.entries.filter((e) => inPart(e.at, part, split))
  const trades: LabTrade[] = run.sim ? run.sim.trades.filter((t) => inPart(t.openedAt, part, split)) : []
  // A part's drawdown is measured from the balance it starts with.
  const start = part === 'holdout' && split !== null && run.sim ? balanceAt(run, split) : run.strategy.sizing.balance
  const stats = run.sim ? tradeStats(trades, start) : null
  const horizons = [...run.strategy.outcomes.horizons].filter((h) => h >= 1).sort((a, b) => a - b)
  const longest = horizons.length - 1
  const forwardPips = longest < 0 ? [] : entries.flatMap((e) => {
    const pips = run.outcomes.get(e.id)?.forward[longest]?.pips
    return pips === undefined || !Number.isFinite(pips) ? [] : [pips]
  })
  return {
    entries: entries.length,
    longs: entries.filter((e) => e.direction === 'long').length,
    trades: stats?.trades ?? 0,
    winRate: stats?.winRate ?? null,
    totalR: stats?.totalR ?? null,
    avgR: stats?.avgR ?? null,
    r: meanStats(stats?.rs ?? []),
    profitFactor: stats?.profitFactor ?? null,
    maxDrawdown: stats ? stats.maxDrawdown : null,
    netPips: stats?.netPips ?? 0,
    netPnl: stats?.netPnl ?? 0,
    forward: meanStats(forwardPips),
    forwardBars: longest < 0 ? null : horizons[longest]
  }
}

/** The closed-trade balance at `at`. */
function balanceAt(run: LabRun, at: number): number {
  let balance = run.strategy.sizing.balance
  for (const p of run.sim?.equity ?? []) if (p.t < at) balance = p.balance
  return balance
}

// -- the figures as columns -------------------------------------------------------------------

export interface FigureColumn {
  key: string
  label: string
  title: string
  value(f: Figures): number | null
  format(v: number | null): string
  /** Which way is better, for colouring a change: up, down, or neither (a count). */
  better: 'up' | 'down' | null
  /** How a change is written (a percent's change in points, a count's in units...). */
  formatChange?(d: number): string
}

const dash = '–'
const fixed = (digits: number) => (v: number | null): string => (v === null || !Number.isFinite(v) ? dash : v.toFixed(digits))
const signedFixed = (digits: number) => (v: number | null): string => (v === null || !Number.isFinite(v) ? dash : `${v > 0 ? '+' : ''}${v.toFixed(digits)}`)
const percent = (v: number | null): string => (v === null || !Number.isFinite(v) ? dash : `${(v * 100).toFixed(0)}%`)
const whole = (v: number | null): string => (v === null || !Number.isFinite(v) ? dash : Math.round(v).toLocaleString('en-US'))
const signedWhole = (v: number | null): string => (v === null || !Number.isFinite(v) ? dash : `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString('en-US')}`)
const points = (d: number): string => `${d > 0 ? '+' : ''}${(d * 100).toFixed(0)} pt`

/** The columns every comparison shows, in order. */
export const FIGURE_COLUMNS: FigureColumn[] = [
  { key: 'entries', label: 'entries', title: 'Entries in the window', value: (f) => f.entries, format: whole, better: null, formatChange: signedWhole },
  { key: 'trades', label: 'trades', title: 'Simulated trades closed', value: (f) => f.trades, format: whole, better: null, formatChange: signedWhole },
  { key: 'won', label: 'won', title: 'Trades that made money, net of costs', value: (f) => f.winRate, format: percent, better: 'up', formatChange: points },
  { key: 'totalR', label: 'R', title: 'R in all, net of costs', value: (f) => f.totalR, format: signedFixed(1), better: 'up', formatChange: signedFixed(1) },
  { key: 'avgR', label: 'avg R', title: 'Mean R per trade', value: (f) => f.avgR, format: signedFixed(2), better: 'up', formatChange: signedFixed(2) },
  { key: 'tR', label: 't (R)', title: "The mean R's t-statistic against zero (trades assumed independent)", value: (f) => f.r.t, format: signedFixed(1), better: 'up', formatChange: signedFixed(1) },
  { key: 'pf', label: 'PF', title: 'Profit factor: gross won over gross lost', value: (f) => f.profitFactor, format: fixed(2), better: 'up', formatChange: signedFixed(2) },
  { key: 'dd', label: 'max DD', title: 'Largest fall of the balance from a peak', value: (f) => f.maxDrawdown, format: percent, better: 'down', formatChange: points },
  { key: 'pips', label: 'pips', title: 'Net pips of the trades (slippage included)', value: (f) => f.netPips, format: signedWhole, better: 'up', formatChange: signedWhole },
  { key: 'fwd', label: 'fwd pips', title: 'Mean forward pips per entry after the longest outcome horizon', value: (f) => f.forward.mean, format: signedFixed(1), better: 'up', formatChange: signedFixed(1) }
]

/** `now` against `then`, for a column: the change, written, and whether it is better (+1),
 * worse (-1) or neither (0). Null when either side has no value. */
export function change(column: FigureColumn, now: Figures, then: Figures): { text: string; sign: -1 | 0 | 1 } | null {
  const a = column.value(now)
  const b = column.value(then)
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return null
  const d = a - b
  if (Math.abs(d) < 1e-12) return { text: '=', sign: 0 }
  const better = column.better === null ? 0 : (d > 0) === (column.better === 'up') ? 1 : -1
  return { text: column.formatChange ? column.formatChange(d) : signedFixed(2)(d), sign: better as -1 | 0 | 1 }
}

/** A mean with its t and interval, in words: "+0.05 (t 0.4; 95% CI -0.21 to +0.30)". */
export function describeMean(s: MeanStats, digits = 2, unit = ''): string {
  if (s.mean === null) return dash
  const m = signedFixed(digits)(s.mean)
  if (s.t === null || s.ci === null) return `${m}${unit} (n ${s.n})`
  return `${m}${unit} (t ${s.t.toFixed(1)}; 95% CI ${signedFixed(digits)(s.ci[0])} to ${signedFixed(digits)(s.ci[1])}; n ${s.n})`
}
