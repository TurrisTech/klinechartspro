// Test-only (nothing outside `*.test.ts` imports it): a deterministic data source on the FX week
// for the lab's runner, plugin and alert tests.

import type { ReplayBar } from '../replay/cache'
import { FX_GRID } from '../replay/timeframes'
import type { LabData, SignalRequest } from './data'
import type { SignalPoint } from './events'
import { defaultRule, type Strategy, type StrategyRule } from './model'

const H = 3_600_000
export const D = 24 * H
export const NOW = Date.UTC(2026, 2, 13, 20) // a Friday, after the FX close

/** A deterministic price at any instant: two waves and a drift, so signals and outcomes vary. */
const priceAt = (t: number): number => 1.1 + 0.004 * Math.sin(t / (9 * H)) + 0.0015 * Math.sin(t / (47 * 60_000)) + ((t - NOW) / D) * 0.0002

/** A deterministic integer per (interval, open): which bars carry a signal. */
const hash = (s: string): number => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

export class FakeData implements LabData {
  reads: string[] = []
  grid = async () => FX_GRID
  pip = async () => 0.0001

  async bars(_symbol: string, interval: string, from: number, to: number, columns: 'core' | 'all'): Promise<ReplayBar[]> {
    this.reads.push(`bars ${interval} ${columns}`)
    const out: ReplayBar[] = []
    let open = FX_GRID.start(interval, from)
    if (open < from) open = FX_GRID.nextStart(interval, open)
    for (; open < to && open < NOW; open = FX_GRID.nextStart(interval, open)) {
      const end = FX_GRID.end(interval, open)
      if (end > NOW) break
      const o = priceAt(open)
      const c = priceAt(end)
      const mid = priceAt((open + end) / 2)
      const bar: ReplayBar = { open, end, date: FX_GRID.toWire(interval, open), o, h: Math.max(o, c, mid) + 0.0002, l: Math.min(o, c, mid) - 0.0002, c, v: 100 }
      if (columns === 'all') {
        const s = (d: number) => ({ o: bar.o + d, h: bar.h + d, l: bar.l + d, c: bar.c + d })
        bar.bid = s(-0.00006)
        bar.ask = s(0.00006)
      }
      out.push(bar)
    }
    return out
  }

  async signals(request: SignalRequest, symbol: string, interval: string, from: number, to: number): Promise<SignalPoint[]> {
    this.reads.push(`signals ${interval}`)
    const bars = await this.bars(symbol, interval, FX_GRID.fromWire(interval, from), FX_GRID.fromWire(interval, to), 'core')
    const rate = interval === '3m' || interval === '5m' ? 9 : interval === '1D' ? 2 : 5
    return bars.flatMap((bar) => {
      const h = hash(`${request.variant}|${interval}|${bar.date}`) % rate
      if (h > 0) return []
      // Long where the price is rising through the bar, short where it is falling.
      return [{ date: bar.date, signal: bar.c >= bar.o ? 'long' : 'short', p: 0.5 }]
    })
  }

  async points() {
    return []
  }
}


/** `strategy` with a long and a short rule from each of `roots` (longest first), each stepping
 * through the shorter of `timeframes` -- what a version-1 strategy with those roots over a pool on
 * those timeframes became. */
export function withRules(strategy: Strategy, roots: readonly string[], timeframes: readonly string[], patch: Partial<StrategyRule> = {}): Strategy {
  const source = strategy.sources[0]?.id ?? 'rank85'
  strategy.rules = roots.flatMap((root) => (['long', 'short'] as const).map((dir) => ({ ...defaultRule(dir, root, timeframes, source, `${dir}${root}`), ...patch })))
  return strategy
}
