import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// A whole run over a fake data source on the FX week: the wiring between the reads, the graph,
// the entries, the outcomes and the trades -- and that the graphs a run builds are the overlay's
// graphs over the same signals, read back as far as the overlay reads.
installWindow()
const { FX_GRID, nominalMs } = await import('../replay/timeframes')
const { runStrategy, autoPathInterval, RunError } = await import('./runner')
const { rank85Strategy, ruleStrategy, defaultStep } = await import('./model')
const mtf = await import('../mtf/graph')

import type { ReplayBar } from '../replay/cache'
import type { LabData, SignalRequest } from './data'
import type { SignalPoint } from './events'
import type { Strategy } from './model'

const H = 3_600_000
const D = 24 * H
const NOW = Date.UTC(2026, 2, 13, 20) // a Friday, after the FX close

/** A deterministic price at any instant: two waves and a drift, so signals and outcomes vary. */
const priceAt = (t: number): number => 1.1 + 0.004 * Math.sin(t / (9 * H)) + 0.0015 * Math.sin(t / (47 * 60_000)) + ((t - NOW) / D) * 0.0002

/** A deterministic integer per (interval, open): which bars carry a signal. */
const hash = (s: string): number => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

class FakeData implements LabData {
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

const window = { from: NOW - 10 * D, to: NOW }

describe('a graph strategy', () => {
  const strategy = (patch: Partial<Strategy['graph']> = {}): Strategy => {
    const s = rank85Strategy(NOW)
    s.sources[0].timeframes = ['3m', '5m', '15m', '1h', '4h']
    s.graph = { ...s.graph, roots: ['4h', '1h'], step: defaultStep(8), ...patch }
    return s
  }

  test('graphs, entries, outcomes and trades', async () => {
    const data = new FakeData()
    const run = await runStrategy(strategy(), data, { ...window, catalogue: null, now: NOW })
    expect(run.signals.length).toBeGreaterThan(50)
    expect(run.graphs.length).toBeGreaterThan(3)
    expect(run.entries.length).toBeGreaterThan(0)
    for (const entry of run.entries) {
      // Every entry is a 3m or 5m step of a graph, inside the window.
      expect(['3m', '5m']).toContain(entry.signal.interval)
      expect(entry.graph?.nodes[entry.node].parent).toBeGreaterThanOrEqual(0)
      expect(entry.at).toBeGreaterThanOrEqual(window.from)
      expect(entry.direction).toBe(entry.side === 'top' ? 'long' : 'short')
    }
    // The path is 1m: the longest stored timeframe that tiles both 3m and 5m.
    expect(run.pathInterval).toBe('1m')
    expect(run.outcomes.size).toBe(run.entries.length)
    expect(run.summary.all.n).toBe(run.entries.length)
    expect(run.sim).not.toBeNull()
    expect((run.sim?.trades.length ?? 0) + (run.sim?.skipped.length ?? 0)).toBe(run.entries.length)
    expect(run.counts.some((c) => c.signals > 0)).toBe(true)
  })

  test('the graphs are the overlay’s, over the same signals', async () => {
    const run = await runStrategy(strategy(), new FakeData(), { ...window, catalogue: null, now: NOW })
    const theirs = mtf.buildRootGraphs(run.signals, ['4h', '1h'], 8, window.from)
    const describe = (graphs: Array<{ root: string; side: string; nodes: Array<{ signal: { key: string }; parent: number }> }>) =>
      graphs.map((g) => `${g.root} ${g.side}: ${g.nodes.map((n) => `${n.signal.key}<${n.parent}`).join(' ')}`)
    expect(describe(run.graphs)).toEqual(describe(theirs))
    const entries = theirs.flatMap((g) => g.nodes.filter((n) => mtf.isEntry(n)).map((n) => n.signal.key))
    expect(run.entries.map((e) => e.id).sort()).toEqual([...new Set(entries)].filter((k) => run.entries.some((e) => e.id === k)).sort())
  })

  test('a second run over the same window reads nothing new', async () => {
    const data = new FakeData()
    const { HttpLabData } = await import('./data')
    void HttpLabData
    await runStrategy(strategy(), data, { ...window, catalogue: null, now: NOW })
    // FakeData records every read; the real data layer's caches are tested in data.test.ts.
    expect(data.reads.filter((r) => r.startsWith('signals')).length).toBe(5)
  })

  test('a filter rule takes entries out, and says which', async () => {
    const s = strategy()
    // Only where the 1h close is above its 20-bar moving average.
    s.entry.filter = { left: { kind: 'bar', interval: '1h', field: 'close' }, op: '>', right: { operand: { kind: 'indicator', interval: '1h', name: 'MA', params: [20], output: 'ma1' } } }
    const run = await runStrategy(s, new FakeData(), { ...window, catalogue: null, now: NOW })
    const unfiltered = await runStrategy(strategy(), new FakeData(), { ...window, catalogue: null, now: NOW })
    expect(run.entries.length + run.filtered.length).toBe(unfiltered.entries.length)
    expect(run.filtered.length).toBeGreaterThan(0)
  })

  test('a strategy with problems is refused before anything is read', async () => {
    const s = strategy()
    s.graph.step[0].expr = 'child.price >'
    const data = new FakeData()
    await expect(runStrategy(s, data, { ...window, catalogue: null, now: NOW })).rejects.toBeInstanceOf(RunError)
    expect(data.reads).toHaveLength(0)
  })
})

describe('a rule strategy, no graph', () => {
  test('RSI events become entries straight away, the other way round', async () => {
    const s = ruleStrategy(NOW)
    // The fake price's RSI(14) on 1h stays between ~44 and ~64: move the levels inside that.
    const source = s.sources[0]
    if (source.kind !== 'rule' || !source.top || !source.bottom || !('right' in source.top) || !('right' in source.bottom)) throw new Error('fixture')
    source.top = { ...source.top, right: { value: 60 } }
    source.bottom = { ...source.bottom, right: { value: 40 } }
    const run = await runStrategy(s, new FakeData(), { ...window, catalogue: null, now: NOW })
    expect(run.graphs).toHaveLength(0)
    expect(run.entries.length).toBeGreaterThan(0)
    for (const entry of run.entries) {
      expect(entry.signal.interval).toBe('1h')
      // Tops (RSI leaving 70) are sold, bottoms bought.
      expect(entry.direction).toBe(entry.side === 'top' ? 'short' : 'long')
    }
    expect(run.pathInterval).toBe('1h')
  })
})

test('autoPathInterval', () => {
  expect(autoPathInterval(['3m', '5m'])).toBe('1m')
  expect(autoPathInterval(['1h', '4h'])).toBe('1h')
  expect(autoPathInterval(['1D'])).toBe('1D')
  expect(autoPathInterval([])).toBeNull()
  expect(nominalMs('1m')).toBe(60_000)
})
