// WHAT `atr()` AND `ind()` READ: an indicator's value at the latest bar of a timeframe that had
// CLOSED by an instant -- the effective-timestamp rule, so a 1h ATR read at 13:20 is the ATR of the
// bar that closed at 13:00, never the one still forming.
//
// Computed before a run (the graph is built synchronously, and klinecharts' templates compute
// asynchronously), for exactly the calls the strategy's expressions make: the runner collects
// them with `needsOf` (each call's arguments are literals, which the expression language enforces
// for these two functions), plus the ATR stops, targets and outcome measures.
//
//   atr(period)       MT4's ATR -- the simple mean of the last `period` true ranges -- the one the
//                     chart's ATR pane draws by default and the NNFX study traded with
//                     (src/indicators/nnfx/atr.ts, `averageTrueRange(..., 0)`)
//   ind(name, ...)    any registered chart template, computed by that template (alerts/compute.ts
//                     `indicatorValues`), so the value is the line the chart draws

import type { KLineData } from 'klinecharts'
import { averageTrueRange } from '../../src/indicators/nnfx/atr'
import { indicatorValues } from '../alerts/compute'
import type { ReplayBar } from '../replay/cache'
import { type Ast, callsOf } from './expr'
import type { Readings } from './graph'
import { lastAtOrBefore } from './sorted'

export type ReadingNeed =
  | { kind: 'atr'; period: number; interval: string }
  | { kind: 'ind'; name: string; output: string; interval: string; params: number[] }

export function needKey(need: ReadingNeed): string {
  return need.kind === 'atr' ? `atr:${need.period}@${need.interval}` : `ind:${need.name}(${need.params.join(',')}).${need.output}@${need.interval}`
}

/** The bars a need wants before its first trustworthy value. */
export function leadIn(need: ReadingNeed): number {
  if (need.kind === 'atr') return need.period + 2
  const longest = Math.max(1, ...need.params.filter((p) => Number.isFinite(p)))
  return Math.min(1200, Math.max(60, Math.ceil(longest * 5 + 50)))
}

/** The `atr()` and `ind()` calls in `ast`, with `self` -- the timeframes a call that names none
 * (or names '*') may be read on: every timeframe its subject can be on. */
export function needsOf(ast: Ast, self: readonly string[]): ReadingNeed[] {
  const out: ReadingNeed[] = []
  for (const args of callsOf(ast, 'atr')) {
    const period = Math.round(Number(args[0]))
    if (!(period >= 1)) continue
    const tf = typeof args[1] === 'string' && args[1] !== '*' ? [args[1]] : self
    for (const interval of tf) out.push({ kind: 'atr', period, interval })
  }
  for (const args of callsOf(ast, 'ind')) {
    const [name, output, tf, ...params] = args
    if (typeof name !== 'string' || typeof output !== 'string') continue
    const nums = params.filter((p): p is number => typeof p === 'number')
    const intervals = typeof tf === 'string' && tf !== '*' ? [tf] : self
    for (const interval of intervals) out.push({ kind: 'ind', name, output, interval, params: nums })
  }
  return out
}

/** One computed series: the closes of its bars and the value on each. */
interface Series {
  ends: number[]
  values: Array<number | undefined>
}

function toKLine(bar: ReplayBar): KLineData {
  return { timestamp: bar.open, open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v }
}

export class SeriesReadings implements Readings {
  private readonly series = new Map<string, Series>()

  constructor(readonly pip: number) {}

  set(need: ReadingNeed, series: Series): void {
    this.series.set(needKey(need), series)
  }

  has(need: ReadingNeed): boolean {
    return this.series.has(needKey(need))
  }

  private at(key: string, at: number): number | undefined {
    const s = this.series.get(key)
    if (!s) return undefined
    const i = lastAtOrBefore(s.ends, at)
    return i >= 0 ? s.values[i] : undefined
  }

  atr(period: number, interval: string, at: number): number | undefined {
    return this.at(needKey({ kind: 'atr', period, interval }), at)
  }

  ind(name: string, output: string, interval: string, params: number[], at: number): number | undefined {
    return this.at(needKey({ kind: 'ind', name, output, interval, params }), at)
  }
}

/** Compute every need over its timeframe's bars (`bars` hands each timeframe's, ascending). A
 * timeframe with no bars reads as unknown everywhere. */
export async function computeReadings(needs: readonly ReadingNeed[], bars: (interval: string) => readonly ReplayBar[], pip: number): Promise<SeriesReadings> {
  const readings = new SeriesReadings(pip)
  const unique = new Map(needs.map((n) => [needKey(n), n]))
  for (const need of unique.values()) {
    const held = bars(need.interval)
    const ends = held.map((bar) => bar.end)
    const data = held.map(toKLine)
    if (need.kind === 'atr') {
      const values = averageTrueRange(data, need.period, 0).map((row) => (typeof row.atr === 'number' && Number.isFinite(row.atr) ? row.atr : undefined))
      readings.set(need, { ends, values })
    } else {
      const values = await indicatorValues(data, need.name, need.params, need.output)
      readings.set(need, { ends, values: values.map((v) => (typeof v === 'number' ? v : undefined)) })
    }
  }
  return readings
}
