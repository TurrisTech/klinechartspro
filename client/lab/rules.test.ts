import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// A STRATEGY AS RULES (model.ts, rules.ts): the defaults are the overlay's 1D graph as a long and
// a short rule, a rule compiles to the graph builder's spec, a version-1 strategy (one graph over
// several roots and both sides) reads back as its rules, and each rule is checked by its own name.
installWindow()
const { defaultEntryOn, defaultRule, migrateV1, newRuleId, rank85Strategy, RANK_TIMEFRAMES, readStrategy, ruleLabel, ruleStrategy, stepsBelow, strategyProblems } = await import('./model')
const { ruleEntryTest, ruleGraphSpec, ruleSignals, ruleTimeframes, ruleWatchInterval } = await import('./rules')

import type { LabSignal } from './graph'

describe('the default rules', () => {
  test('rank 85 is the overlay’s 1D graph, a long rule on the bottoms and a short one on the tops', () => {
    const s = rank85Strategy(0)
    expect(s.version).toBe(2)
    expect(s.rules.map((r) => [ruleLabel(s, r), r.follows, r.root, r.maxStep])).toEqual([
      ['Long · 1D', 'bottom', '1D', 8],
      ['Short · 1D', 'top', '1D', 8]
    ])
    // Every timeframe the overlay reads under 1D; entries on its stars' 5m and 3m.
    expect(s.rules[0].steps).toEqual(['3m', '5m', '15m', '20m', '30m', '1h', '2h', '4h', '8h'])
    expect(s.rules[0].entryOn).toEqual(['3m', '5m'])
    expect(strategyProblems(s)).toEqual([])
  })

  test('the rule events have no graph: they enter on their root', () => {
    const s = ruleStrategy(0)
    expect(s.rules.map((r) => [r.direction, r.source, r.root, r.steps, r.entryOn])).toEqual([
      ['long', 'rsi', '1h', [], ['1h']],
      ['short', 'rsi', '1h', [], ['1h']]
    ])
    expect(strategyProblems(s)).toEqual([])
  })

  test('steps, entries, names and ids', () => {
    expect(stepsBelow('4h', RANK_TIMEFRAMES)).toEqual(['3m', '5m', '15m', '20m', '30m', '1h', '2h'])
    expect(defaultEntryOn('4h', ['15m', '1h'])).toEqual(['15m'])
    expect(defaultEntryOn('1h', [])).toEqual(['1h'])
    const s = rank85Strategy(0)
    s.rules.push({ ...defaultRule('long', '1D', RANK_TIMEFRAMES, 'rank85', newRuleId(s, 'long', '1D')) })
    expect(s.rules[2].id).toBe('long1D_2')
    expect(ruleLabel(s, s.rules[2])).toBe('Long · 1D #2')
  })
})

describe('a rule, compiled', () => {
  test('the overlay’s step test with its own longest step, rooted by its source alone', () => {
    const rule = { ...defaultRule('long', '4h', RANK_TIMEFRAMES, 'rank85', 'r'), maxStep: 6, stepIf: [{ id: 'x', expr: 'child.depth < 4', enabled: true }] }
    const spec = ruleGraphSpec(rule, { rootBars: 300, maxBars: 10_000 })
    expect(spec.roots).toEqual(['4h'])
    expect(spec.rootSources).toEqual(['rank85'])
    expect(spec.takenDontRoot).toBe(false)
    expect(spec.step.map((c) => c.expr)).toEqual(['(child.price - parent.price) * dir > 0', 'child.tf <= parent.tf', 'parent.tf <= child.tf * 6', 'child.depth < 4'])
    // No longest step: no such condition.
    expect(ruleGraphSpec({ ...rule, maxStep: null }, { rootBars: 1, maxBars: 1 }).step.map((c) => c.id)).toEqual(['further', 'lower', 'x'])
    expect(ruleEntryTest(rule)[0].expr).toBe("node.tf == tf('3m') or node.tf == tf('5m')")
    expect(ruleTimeframes(rule)).toEqual(['4h', '3m', '5m', '15m', '20m', '30m', '1h', '2h'])
    expect(ruleWatchInterval(rule)).toBe('3m')
  })

  test('its signals: its source’s on the root, both sides; its side’s on the steps', () => {
    const rule = defaultRule('long', '1h', ['5m', '1h'], 'a', 'r')
    const sig = (source: string, interval: string, side: 'top' | 'bottom'): LabSignal =>
      ({ key: `${source}|${interval}|${side}`, source, interval, side, durationMs: 0, knownAt: 0, sourceDate: 0, price: 1, bar: { o: 1, h: 1, l: 1, c: 1 }, label: '', raw: {} }) as LabSignal
    const pool = [sig('a', '1h', 'top'), sig('a', '1h', 'bottom'), sig('a', '5m', 'top'), sig('a', '5m', 'bottom'), sig('b', '5m', 'bottom'), sig('a', '15m', 'bottom')]
    expect(ruleSignals(rule, pool).map((s) => s.key)).toEqual(['a|1h|top', 'a|1h|bottom', 'a|5m|bottom'])
  })
})

describe('a version-1 strategy', () => {
  /** What a version-1 document looked like: one graph, several roots, both sides. */
  const v1 = (patch: Record<string, unknown> = {}) => ({
    version: 1,
    id: 'st1',
    name: 'old',
    notes: '',
    instrument: 'oanda:EURUSD',
    window: { kind: 'days', days: 30 },
    sources: [{ kind: 'published', id: 'rank85', title: 'AREV21 outlier rank 85', plugin: 'arev21_outlier', variant: 'arev21_outlier_rank', params: { bars: 200, q: 0.85, samples_only: 0 }, timeframes: ['3m', '5m', '15m', '1h', '4h', '1D'], sides: { long: 'top', short: 'bottom' }, price: 'body' }],
    graph: {
      enabled: true,
      roots: ['1h', '1D'],
      rootSources: null,
      rootJoin: 'join',
      takenDontRoot: true,
      reach: true,
      parent: 'supersede',
      step: [
        { id: 'further', expr: '(child.price - parent.price) * dir > 0', enabled: true },
        { id: 'lower', expr: 'child.tf <= parent.tf', enabled: true },
        { id: 'maxstep', expr: 'parent.tf <= child.tf * 12', enabled: true }
      ],
      end: { rootBars: 20, when: '', watch: null },
      lookback: { rootBars: 200, maxBars: 5000 }
    },
    entry: {
      when: [
        { id: 'step', expr: 'not node.is_root', enabled: true },
        { id: 'short', expr: "node.tf <= tf('5m')", enabled: true },
        { id: 'deep', expr: 'node.depth >= 2', enabled: true }
      ],
      filter: null,
      direction: { top: 'long', bottom: 'short' }
    },
    exits: {},
    createdAt: 1,
    updatedAt: 2,
    ...patch
  })

  test('becomes a rule per root and side, with its settings, the presets as fields', () => {
    const s = readStrategy(v1())
    if (!s) throw new Error('not read')
    expect(s.version).toBe(2)
    expect('graph' in s || 'entry' in s).toBe(false)
    expect(s.sources[0]).not.toHaveProperty('timeframes')
    // Longest root first; its direction kept (tops were bought then: with the signal).
    expect(s.rules.map((r) => [ruleLabel(s, r), r.follows])).toEqual([
      ['Short · 1D', 'bottom'],
      ['Long · 1D', 'top'],
      ['Short · 1h', 'bottom'],
      ['Long · 1h', 'top']
    ])
    const r = s.rules[0]
    expect(r.steps).toEqual(['3m', '5m', '15m', '1h', '4h'])
    expect(r.entryOn).toEqual(['3m', '5m'])
    expect(r.maxStep).toBe(12)
    expect(r.stepIf).toEqual([])
    expect(r.entryIf.map((c) => c.expr)).toEqual(['node.depth >= 2'])
    expect(r.end.rootBars).toBe(20)
    expect(s.lookback).toEqual({ rootBars: 200, maxBars: 5000 })
    expect(strategyProblems(s)).toEqual([])
  })

  test('a condition that is not a preset is kept as the rule’s own', () => {
    const doc = v1()
    doc.graph.step.push({ id: 'atr', expr: '(child.price - parent.price) * dir >= 0.5 * atr(14)', enabled: true })
    doc.entry.when = doc.entry.when.filter((c) => c.id !== 'short')
    const s = migrateV1(doc) as { rules: Array<{ stepIf: Array<{ expr: string }>; entryOn: string[] }> }
    expect(s.rules[0].stepIf.map((c) => c.expr)).toEqual(['(child.price - parent.price) * dir >= 0.5 * atr(14)'])
    // Without the 5m preset, every step is an entry.
    expect(s.rules[0].entryOn).toEqual(['3m', '5m', '15m', '1h', '4h'])
  })

  test('with the graph off, each timeframe is a pair of event rules', () => {
    const doc = v1({ graph: { ...v1().graph, enabled: false }, entry: { when: [], filter: null, direction: { top: 'short', bottom: 'long' } } })
    doc.sources[0].timeframes = ['1h']
    const s = readStrategy(doc)
    expect(s?.rules.map((r) => [r.direction, r.root, r.steps, r.entryOn])).toEqual([
      ['long', '1h', [], ['1h']],
      ['short', '1h', [], ['1h']]
    ])
  })

  test('anything else is not a strategy', () => {
    expect(readStrategy({ version: 3, id: 'x', sources: [] })).toBeNull()
    expect(readStrategy({ version: 2, id: 'x', sources: [] })).toBeNull()
    expect(readStrategy(null)).toBeNull()
  })
})

describe('a rule’s problems carry its name', () => {
  test('each slot, by the rule', () => {
    const s = rank85Strategy(0)
    // A step not under the root, and an entry on a timeframe it does not step through.
    s.rules[1].steps = [...s.rules[1].steps, '1D']
    s.rules[1].entryOn = ['1W']
    s.rules[0].source = 'gone'
    expect(strategyProblems(s).map((p) => p.where)).toEqual(['Long · 1D · signal', 'Short · 1D · steps', 'Short · 1D · entries'])
    for (const r of s.rules) r.enabled = false
    expect(strategyProblems(s).map((p) => p.where)).toEqual(['Rules'])
  })
})
