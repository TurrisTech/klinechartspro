import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// A whole run over a fake data source on the FX week: the wiring between the reads, the graph,
// the entries, the outcomes and the trades -- and that the graphs a run builds are the graphs
// its default slots build over the same signals, read back as far as they need. That those are
// the overlay's -- the server's -- is graph.test.ts's job, against the server's own output.
installWindow()
const { nominalMs } = await import('../replay/timeframes')
const { runStrategy, autoPathInterval, RunError } = await import('./runner')
const { rank85Strategy, ruleStrategy, defaultGraph, defaultGraphEntry } = await import('./model')
const { buildRootGraphs } = await import('./graph')
const { ruleEntryTest, ruleGraphSpec, ruleSignals } = await import('./rules')

import type { Strategy, StrategyRule } from './model'

const { FakeData, NOW, D, withRules } = await import('./testdata')

const window = { from: NOW - 10 * D, to: NOW }
const POOL = ['3m', '5m', '15m', '1h', '4h']
const NO_READINGS = { pip: 0.0001, atr: () => undefined, ind: () => undefined }

type Described = Array<{ root: string; side: string; nodes: Array<{ signal: { key: string }; parent: number }> }>
const describeGraphs = (graphs: Described) => graphs.map((g) => `${g.root} ${g.side}: ${g.nodes.map((n) => `${n.signal.key}<${n.parent}`).join(' ')}`)

describe('a strategy of rules', () => {
  /** A long and a short rule from each of 4h and 1h, over the pool's shorter timeframes. */
  const strategy = (patch: Partial<StrategyRule> = {}): Strategy => withRules(rank85Strategy(NOW), ['4h', '1h'], POOL, patch)

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
      // Against the signal: a top is sold, a bottom bought -- a long rule follows the bottoms.
      expect(entry.direction).toBe(entry.side === 'top' ? 'short' : 'long')
      const rule = run.strategy.rules.find((r) => r.id === entry.rule)
      expect(rule?.direction).toBe(entry.direction)
      expect(rule?.follows).toBe(entry.side)
    }
    // Each rule alone: its own entries and its own account.
    // Long rules first, as the editor lists them.
    expect(run.rules.map((r) => r.label)).toEqual(['Long · 4h', 'Long · 1h', 'Short · 4h', 'Short · 1h'])
    for (const rr of run.rules) {
      for (const e of rr.entries) expect(e.rule).toBe(rr.rule.id)
      expect(rr.outcomes.size).toBe(rr.entries.length)
      if (rr.entries.length > 0) expect((rr.sim?.trades.length ?? 0) + (rr.sim?.skipped.length ?? 0)).toBe(rr.entries.length)
    }
    // Together, a signal two rules enter on is one entry.
    const union = new Set(run.rules.flatMap((rr) => rr.entries.map((e) => e.id)))
    expect(run.entries.length).toBe(union.size)
    // The path is 1m: the longest stored timeframe that tiles both 3m and 5m.
    expect(run.pathInterval).toBe('1m')
    expect(run.outcomes.size).toBe(run.entries.length)
    expect(run.summary.all.n).toBe(run.entries.length)
    expect(run.sim).not.toBeNull()
    expect((run.sim?.trades.length ?? 0) + (run.sim?.skipped.length ?? 0)).toBe(run.entries.length)
    expect(run.counts.some((c) => c.signals > 0)).toBe(true)
  })

  test('each rule’s graphs are its spec’s, over its signals', async () => {
    const s = strategy()
    const run = await runStrategy(s, new FakeData(), { ...window, catalogue: null, now: NOW })
    for (const rr of run.rules) {
      const theirs = buildRootGraphs({ signals: ruleSignals(rr.rule, run.signals), spec: ruleGraphSpec(rr.rule, s.lookback), entry: ruleEntryTest(rr.rule), from: window.from, readings: NO_READINGS }).filter(
        (g) => g.side === rr.rule.follows
      )
      expect(describeGraphs(rr.graphs)).toEqual(describeGraphs(theirs))
    }
  })

  test('a long and a short rule from one root are the overlay’s graphs from that root', async () => {
    // The overlay's spec with one root, both sides, over the whole pool -- what graph.test.ts holds
    // to the server -- split by side is the two rules' graphs, and its stars their entries.
    for (const root of ['4h', '1h']) {
      const s = withRules(rank85Strategy(NOW), [root], POOL)
      const run = await runStrategy(s, new FakeData(), { ...window, catalogue: null, now: NOW })
      const overlay = buildRootGraphs({ signals: run.signals, spec: { ...defaultGraph(), roots: [root] }, entry: defaultGraphEntry(), from: window.from, readings: NO_READINGS })
      expect(overlay.length).toBeGreaterThan(0)
      const [long, short] = run.rules
      expect(describeGraphs(long.graphs)).toEqual(describeGraphs(overlay.filter((g) => g.side === 'bottom')))
      expect(describeGraphs(short.graphs)).toEqual(describeGraphs(overlay.filter((g) => g.side === 'top')))
      const stars = new Set(overlay.flatMap((g) => g.nodes.filter((n) => n.entry).map((n) => n.signal.key)))
      expect(new Set([...long.entries, ...short.entries].map((e) => e.id))).toEqual(new Set([...stars].filter((k) => [...long.entries, ...short.entries].some((e) => e.id === k))))
      // and nothing the overlay stars inside the window is missing
      const inWindow = overlay.flatMap((g) => g.nodes.filter((n) => n.entry && n.signal.knownAt >= window.from && n.signal.knownAt <= window.to).map((n) => n.signal.key))
      expect(new Set([...long.entries, ...short.entries].map((e) => e.id))).toEqual(new Set(inWindow))
    }
  })

  test('a second run over the same window reads nothing new', async () => {
    const data = new FakeData()
    const { HttpLabData } = await import('./data')
    void HttpLabData
    await runStrategy(strategy(), data, { ...window, catalogue: null, now: NOW })
    // FakeData records every read; the real data layer's caches are tested in data.test.ts. Each
    // timeframe's signals are read once, though 1h is one rule's root and another's step.
    expect(data.reads.filter((r) => r.startsWith('signals')).length).toBe(5)
  })

  test('a filter rule takes entries out, and says which', async () => {
    const s = strategy()
    // Only where the 1h close is above its 20-bar moving average -- on every rule.
    for (const rule of s.rules) rule.filter = { left: { kind: 'bar', interval: '1h', field: 'close' }, op: '>', right: { operand: { kind: 'indicator', interval: '1h', name: 'MA', params: [20], output: 'ma1' } } }
    const run = await runStrategy(s, new FakeData(), { ...window, catalogue: null, now: NOW })
    const unfiltered = await runStrategy(strategy(), new FakeData(), { ...window, catalogue: null, now: NOW })
    expect(run.entries.length + run.filtered.length).toBe(unfiltered.entries.length)
    expect(run.filtered.length).toBeGreaterThan(0)
  })

  test('a strategy with problems is refused before anything is read', async () => {
    const s = strategy()
    s.rules[0].stepIf = [{ id: 'x', expr: 'child.price >', enabled: true }]
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
