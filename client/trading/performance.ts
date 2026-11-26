import type { KLineData } from 'klinecharts'
import type { CandleGrid } from '../replay/timeframes'
import { nominalMs } from '../replay/timeframes'
import type { SimSnapshot } from './api'
import { balanceSeries, equitySeries, type MarkAt, openAt } from './ledger'
import type { PerfMetric, PerfRange } from './prefs'

// The account window's Performance tab, as numbers. PURE (performance.test.ts): what window a
// range button means, how it is cut into periods, which bars the equity needs, and the bars the
// histogram draws. The view (perfview.ts) fetches and draws; nothing here touches the DOM or the
// network.
//
// A period's bar is the balance -- or the equity -- at the period's END, drawn from a baseline at
// what it was when the window began, so a bar above the line is a gain over the window and one
// below it a loss. The last bar ends NOW (the replay's clock under a replay) and is the account's
// own live figure.
//
// Periods are candles of the ACTIVE chart's instrument (`CandleGrid`): an FX wall's days close at
// 17:00 New York and skip the weekend, a coinbase wall's at midnight UTC every day. With no grid
// (no market hours resolved) they are plain equal steps -- a period, not a guessed session.

export type { PerfMetric, PerfRange } from './prefs'
export const PERF_RANGES: readonly PerfRange[] = ['1M', '3M', '6M', '1Y', 'all']

export const RANGE_LABEL: Record<PerfRange, string> = { '1M': '1M', '3M': '3M', '6M': '6M', '1Y': '1Y', all: 'All' }

const MONTHS: Record<Exclude<PerfRange, 'all'>, number> = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 }

/** The period lengths a window may be cut into, finest first. */
export const STEP_LADDER: readonly string[] = ['1m', '5m', '15m', '1h', '4h', '1D', '1W', '1M']

/** At most this many bars: a thin bar per period still reads in a window 380px wide. */
export const MAX_BUCKETS = 120

/** The instant a range reaches back to from `now`: whole calendar months (UTC), so 1M on the 31st
 * of March is the last day of February, not the 3rd of March. */
export function rangeStart(range: PerfRange, now: number): number {
  if (range === 'all') return Number.NEGATIVE_INFINITY
  const d = new Date(now)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - MONTHS[range])
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d.getTime()
}

/** When the account began, on the session's clock: a replay's start, else the session's creation
 * -- or its first trade, should one be dated earlier. */
export function accountStart(snapshot: Pick<SimSnapshot, 'createdAt' | 'trades'>, startedAt?: number): number {
  let start = startedAt ?? snapshot.createdAt
  for (const trade of snapshot.trades) start = Math.min(start, trade.openedAt)
  return start
}

/** The instant the baseline is read at: the window's start -- or, where the window begins with
 * the account, just before it, so a trade placed in its first instant is not already in the line
 * every bar is measured from (it would be, half a spread down). */
export function baseInstant(window: PerfWindow): number {
  return window.clamped ? window.from - 1 : window.from
}

export interface PerfWindow {
  from: number
  to: number
  /** The range reaches back past the account's start, so the window begins there instead. */
  clamped: boolean
}

export function perfWindow(range: PerfRange, now: number, start: number): PerfWindow {
  const reach = rangeStart(range, now)
  const from = Math.min(Math.max(reach, start), now)
  return { from, to: now, clamped: reach <= start }
}

/** The finest step that cuts `span` into at most `MAX_BUCKETS` periods. */
export function chooseStep(span: number): string {
  for (const step of STEP_LADDER) if (span / nominalMs(step) <= MAX_BUCKETS) return step
  return STEP_LADDER[STEP_LADDER.length - 1]
}

/** The period ends of `(from, to]`, ascending: every close of a `step` candle on the grid after
 * `from` and before `to`, then `to` itself -- the period still running. */
export function periodEnds(from: number, to: number, step: string, grid: CandleGrid | null): number[] {
  const out: number[] = []
  if (!(to > from)) return [to]
  if (grid) {
    // The grid's own stepping rule: from inside a candle, its close; from a close (which is also
    // the next open), a gap or the closed window, the close of the next candle to open. Stepping
    // with `nextStart` from a close would skip the candle opening at it -- a whole day per day.
    let t = grid.advanceTarget(step, from, 1)
    for (let guard = 0; t < to && guard < MAX_BUCKETS * 4; guard++) {
      out.push(t)
      t = grid.advanceTarget(step, t, 1)
    }
  } else {
    const ms = nominalMs(step)
    for (let t = (Math.floor(from / ms) + 1) * ms; t < to; t += ms) out.push(t)
  }
  out.push(to)
  return out
}

/** The stored interval past equity is marked on: the closes of its bars fall on every period
 * end of that step (hours for an hour and up, minutes below). */
export function markInterval(step: string): string {
  return nominalMs(step) >= nominalMs('1h') ? '1h' : '1m'
}

/** Which bars the equity at `times` needs: per instrument, the span over which one of its trades
 * was open at one of those instants, widened by one bar so the first instant has a close before
 * it. Nothing for an instrument with nothing open at any of them. */
export function marksNeeded(
  snapshot: Pick<SimSnapshot, 'trades'>,
  times: readonly number[],
  barMs: number
): Map<string, { from: number; to: number }> {
  const out = new Map<string, { from: number; to: number }>()
  for (const trade of snapshot.trades) {
    const hit = times.filter((t) => openAt(trade, t))
    if (hit.length === 0) continue
    const from = hit[0] - barMs
    const to = hit[hit.length - 1]
    const span = out.get(trade.symbol)
    out.set(trade.symbol, span ? { from: Math.min(span.from, from), to: Math.max(span.to, to) } : { from, to })
  }
  return out
}

/** `MarkAt` over fetched bars: the close of the last bar that had CLOSED by the instant (its open
 * plus one bar), never the bar forming then. Bars per instrument, any order. */
export function marksFrom(bars: Map<string, readonly KLineData[]>, barMs: number): MarkAt {
  const sorted = new Map<string, KLineData[]>()
  for (const [symbol, list] of bars) sorted.set(symbol, [...list].sort((a, b) => a.timestamp - b.timestamp))
  return (symbol, t) => {
    const list = sorted.get(symbol)
    if (!list || list.length === 0) return null
    // The last bar with timestamp + barMs <= t.
    let lo = 0
    let hi = list.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].timestamp + barMs <= t) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return found < 0 ? null : list[found].close
  }
}

export interface PerfBar {
  /** The period's end: the instant its value is taken at. */
  end: number
  /** Where the period began (the previous bar's end, or the window's start). */
  start: number
  value: number
  /** Open trades with no bar to mark them by, counted at entry (equity only). */
  unmarked: number
  /** The period still running: its value is the account's live figure. */
  live: boolean
}

export interface PerfModel {
  metric: PerfMetric
  window: PerfWindow
  step: string
  /** The value when the window began: the line every bar grows from. */
  base: number
  bars: PerfBar[]
  /** The newest value less the base, and that as a percentage of the base. */
  change: number
  changePercent: number | null
}

/** The histogram's bars. `live` is the account's own figure now (the balance, or the engine's
 * equity), which the last period takes; the rest come from the ledger, equity through `markAt`.
 * `markAt` may be omitted for the balance. */
export function perfModel(
  snapshot: Pick<SimSnapshot, 'trades' | 'account'>,
  metric: PerfMetric,
  window: PerfWindow,
  step: string,
  ends: readonly number[],
  markAt: MarkAt | null
): PerfModel {
  const times = [baseInstant(window), ...ends.slice(0, -1)]
  let values: Array<{ value: number; unmarked: number }>
  if (metric === 'equity' && markAt) {
    values = equitySeries(snapshot, times, markAt).map((p) => ({ value: p.equity, unmarked: p.unmarked }))
  } else {
    values = balanceSeries(snapshot, times).map((value) => ({ value, unmarked: 0 }))
  }
  const live = metric === 'equity' ? snapshot.account.equity : snapshot.account.balance
  const base = values[0].value
  const bars: PerfBar[] = ends.map((end, i) => {
    const last = i === ends.length - 1
    return {
      end,
      start: i === 0 ? window.from : ends[i - 1],
      value: last ? live : values[i + 1].value,
      unmarked: last ? 0 : values[i + 1].unmarked,
      live: last
    }
  })
  const change = live - base
  return {
    metric,
    window,
    step,
    base,
    bars,
    change,
    changePercent: base > 0 ? (change / base) * 100 : null
  }
}
