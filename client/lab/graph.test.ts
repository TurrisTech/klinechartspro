import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// The lab's graph builder against the overlay's: with every slot at its default it must build
// the SAME graphs from the same signals -- same roots, same nodes, same parents, same entries --
// because a strategy developed in the lab is meant to be the graph the wall draws. Then each
// slot, one at a time.
installWindow()
const mtf = await import('../mtf/graph')
const { buildRootGraphs, graphEntries } = await import('./graph')
const { defaultGraph, defaultGraphEntry, defaultStep } = await import('./model')

import type { GraphSpec, Side, SlotCondition } from './model'
import type { LabGraph, LabSignal, Readings } from './graph'

const M = 60_000
const H = 60 * M
const DURATION: Record<string, number> = { '1D': 24 * H, '8h': 8 * H, '4h': 4 * H, '2h': 2 * H, '1h': H, '30m': 30 * M, '15m': 15 * M, '5m': 5 * M, '3m': 3 * M }
const LADDER = ['3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '1D']

const NO_READINGS: Readings = { pip: 0.0001, atr: () => undefined, ind: () => undefined }

const sig = (interval: string, knownAt: number, side: Side, price: number, source = 'rank85'): LabSignal => ({
  key: `${source}|${interval}|${knownAt - DURATION[interval]}`,
  source,
  interval,
  durationMs: DURATION[interval],
  knownAt,
  sourceDate: knownAt - DURATION[interval],
  side,
  price,
  bar: { o: price, h: price, l: price, c: price },
  label: side === 'top' ? 'long' : 'short',
  raw: {}
})

/** A deterministic PRNG (mulberry32), so a failing seed can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A plausible pool: every timeframe signals at some of its own bar closes, sides that run in
 * streaks, prices on a random walk -- so graphs form, reset, supersede and skip. */
function pool(seed: number, days = 20): LabSignal[] {
  const random = rng(seed)
  const out: LabSignal[] = []
  const start = Date.UTC(2026, 0, 5)
  const end = start + days * 24 * H
  // One shared price path, sampled at 3m.
  const path = new Map<number, number>()
  let price = 1.1
  for (let t = start; t <= end; t += 3 * M) {
    price += (random() - 0.5) * 0.0008
    path.set(t, price)
  }
  for (const interval of LADDER) {
    const d = DURATION[interval]
    // Shorter timeframes signal less often per bar, as the rank rule does.
    const rate = interval === '3m' || interval === '5m' ? 0.03 : interval === '1D' ? 0.5 : 0.12
    let side: Side = random() < 0.5 ? 'top' : 'bottom'
    for (let t = start + d; t <= end; t += d) {
      if (random() < 0.25) side = side === 'top' ? 'bottom' : 'top'
      if (random() > rate) continue
      const p = (path.get(t) ?? price) + (side === 'top' ? 1 : -1) * random() * 0.0005
      out.push(sig(interval, t, side, Number(p.toFixed(5))))
    }
  }
  return out
}

const spec = (patch: Partial<GraphSpec> = {}): GraphSpec => ({ ...defaultGraph(), ...patch })

function lab(signals: LabSignal[], s: GraphSpec, from: number, entry: SlotCondition[] = defaultGraphEntry()): LabGraph[] {
  return buildRootGraphs({ signals, spec: s, entry, from, readings: NO_READINGS })
}

/** A graph as comparable data: root, side, and each node as `key <- parentKey` with its entry. */
const describeLab = (graphs: LabGraph[]) =>
  graphs.map((g) => ({ root: g.root, side: g.side, nodes: g.nodes.map((n) => [n.signal.key, n.parent < 0 ? null : g.nodes[n.parent].signal.key, n.entry]) }))
const describeMtf = (graphs: ReturnType<typeof mtf.buildRootGraphs<LabSignal>>) =>
  graphs.map((g) => ({ root: g.root, side: g.side, nodes: g.nodes.map((n) => [n.signal.key, n.parent < 0 ? null : g.nodes[n.parent].signal.key, mtf.isEntry(n)]) }))

describe('the default slots build the overlay’s graphs', () => {
  const ROOT_SETS = [['1D'], ['8h'], ['1h'], ['1D', '8h'], ['8h', '4h', '1h'], ['1D', '8h', '4h', '2h', '1h']]
  for (const roots of ROOT_SETS) {
    for (const maxStep of [8, 3, 50]) {
      test(`roots ${roots.join('+')}, largest step ${maxStep}×, 40 generated pools`, () => {
        let nodes = 0
        let entries = 0
        for (let seed = 1; seed <= 40; seed++) {
          const signals = pool(seed * 7919 + maxStep)
          const from = Date.UTC(2026, 0, 12)
          const theirs = describeMtf(mtf.buildRootGraphs(signals, roots, maxStep, from))
          const ours = describeLab(lab(signals, spec({ roots, step: defaultStep(maxStep) }), from))
          expect(ours).toEqual(theirs)
          for (const g of theirs) {
            nodes += g.nodes.length
            entries += g.nodes.filter((n) => n[2]).length
          }
        }
        // The comparison is only worth something if the pools produced real graphs.
        expect(nodes).toBeGreaterThan(100)
        if (roots.some((r) => DURATION[r] <= 8 * H) || maxStep === 50) expect(entries).toBeGreaterThan(0)
      })
    }
  }
})

describe('each slot', () => {
  const T = Date.UTC(2026, 0, 5, 12)

  test('rootJoin: join (another root), new (a graph each), ignore (the first only)', () => {
    const signals = [sig('8h', T, 'top', 1.1), sig('8h', T + 8 * H, 'top', 1.12), sig('1h', T + 9 * H, 'top', 1.13)]
    const join = lab(signals, spec({ roots: ['8h'] }), T)
    expect(join).toHaveLength(1)
    // The second root supersedes the first (same timeframe, further), and the 1h steps from it.
    expect(join[0].nodes.map((n) => [n.signal.price, n.parent])).toEqual([
      [1.1, -1],
      [1.12, 0],
      [1.13, 1]
    ])
    const fresh = lab(signals, spec({ roots: ['8h'], rootJoin: 'new' }), T)
    expect(fresh.map((g) => g.nodes.map((n) => n.signal.price))).toEqual([[1.1], [1.12, 1.13]])
    const ignore = lab(signals, spec({ roots: ['8h'], rootJoin: 'ignore' }), T)
    expect(ignore.map((g) => g.nodes.map((n) => n.signal.price))).toEqual([[1.1, 1.13]])
  })

  test('reach off: a signal that falls short of the graph still joins where it may step', () => {
    // A second 1h top below the first: it cannot supersede it, but it may step from the root.
    const signals = [sig('8h', T, 'top', 1.1), sig('1h', T + H, 'top', 1.13), sig('1h', T + 2 * H, 'top', 1.12)]
    expect(lab(signals, spec({ roots: ['8h'] }), T)[0].nodes).toHaveLength(2)
    const loose = lab(signals, spec({ roots: ['8h'], reach: false }), T)[0]
    expect(loose.nodes.map((n) => [n.signal.price, n.parent])).toEqual([
      [1.1, -1],
      [1.13, 0],
      [1.12, 0]
    ])
  })

  test('parent: recent, nearest and root choose differently among admissible parents', () => {
    const signals = [sig('8h', T, 'bottom', 1.2), sig('4h', T + 4 * H, 'bottom', 1.18), sig('1h', T + 5 * H, 'bottom', 1.17), sig('15m', T + 6 * H, 'bottom', 1.16)]
    const parentOf = (parent: GraphSpec['parent'], maxStep = 50) =>
      lab(signals, spec({ roots: ['8h'], parent, reach: false, step: defaultStep(maxStep) }), T)[0].nodes.map((n) => n.parent)
    expect(parentOf('supersede')).toEqual([-1, 0, 1, 2])
    expect(parentOf('recent')).toEqual([-1, 0, 1, 2])
    expect(parentOf('root')).toEqual([-1, 0, 0, 0])
    // The 15m at 1.16: the 1h (1.17) is nearest.
    expect(parentOf('nearest')).toEqual([-1, 0, 1, 2])
  })

  test('takenDontRoot off: a signal stepping in the 1D graph roots an 8h graph too', () => {
    const signals = [sig('1D', T, 'top', 1.1), sig('8h', T + 8 * H, 'top', 1.11)]
    expect(lab(signals, spec({ roots: ['1D', '8h'] }), T).map((g) => g.root)).toEqual(['1D'])
    expect(lab(signals, spec({ roots: ['1D', '8h'], takenDontRoot: false }), T).map((g) => g.root)).toEqual(['1D', '8h'])
  })

  test('end after N root bars: a later signal joins nothing', () => {
    const signals = [sig('1h', T, 'top', 1.1), sig('15m', T + 30 * M, 'top', 1.11), sig('15m', T + 2 * H + 30 * M, 'top', 1.12)]
    const closes = [T, T + H, T + 2 * H, T + 3 * H]
    const graphs = buildRootGraphs({
      signals,
      spec: spec({ roots: ['1h'], end: { rootBars: 2, when: '', watch: null } }),
      entry: defaultGraphEntry(),
      from: T,
      readings: NO_READINGS,
      rootCloses: () => closes
    })
    expect(graphs).toHaveLength(1)
    expect(graphs[0].nodes.map((n) => n.signal.price)).toEqual([1.1, 1.11])
    expect(graphs[0].endedAt).toBe(T + 2 * H)
    expect(graphs[0].endReason).toBe('expired')
  })

  test('end when a condition holds at a watched close: price closed back below the root', () => {
    const signals = [sig('1h', T, 'top', 1.1), sig('15m', T + 15 * M, 'top', 1.11), sig('15m', T + 45 * M, 'top', 1.12)]
    const watch = [
      { end: T + 15 * M, o: 1.105, h: 1.11, l: 1.1, c: 1.105 },
      { end: T + 30 * M, o: 1.1, h: 1.1, l: 1.09, c: 1.095 },
      { end: T + 45 * M, o: 1.1, h: 1.12, l: 1.1, c: 1.115 }
    ]
    const graphs = buildRootGraphs({
      signals,
      spec: spec({ roots: ['1h'], end: { rootBars: null, when: '(bar.close - root.price) * dir < 0', watch: '15m' } }),
      entry: defaultGraphEntry(),
      from: T,
      readings: NO_READINGS,
      watchBars: watch,
      watchInterval: '15m'
    })
    expect(graphs[0].nodes.map((n) => n.signal.price)).toEqual([1.1, 1.11])
    expect(graphs[0].endedAt).toBe(T + 30 * M)
    expect(graphs[0].endReason).toBe('condition')
  })

  test('a custom step: the child must go at least half an ATR further', () => {
    const signals = [sig('1h', T, 'top', 1.1), sig('15m', T + 15 * M, 'top', 1.1004), sig('15m', T + 30 * M, 'top', 1.1012)]
    const readings: Readings = { pip: 0.0001, atr: (period, interval) => (period === 14 && interval === '15m' ? 0.001 : undefined), ind: () => undefined }
    const step = [...defaultStep(), { id: 'atr', expr: '(child.price - parent.price) * dir >= 0.5 * atr(14)', enabled: true }]
    const graphs = buildRootGraphs({ signals, spec: spec({ roots: ['1h'], step }), entry: defaultGraphEntry(), from: T, readings })
    // 1.1004 is only 0.4 ATR above the root; 1.1012 is 1.2 above it.
    expect(graphs[0].nodes.map((n) => n.signal.price)).toEqual([1.1, 1.1012])
  })

  test('a disabled condition is not read', () => {
    const signals = [sig('8h', T, 'top', 1.1), sig('3m', T + 3 * M, 'top', 1.11)]
    expect(lab(signals, spec({ roots: ['8h'] }), T)[0].nodes).toHaveLength(1)
    const step = defaultStep().map((c) => (c.id === 'maxstep' ? { ...c, enabled: false } : c))
    expect(lab(signals, spec({ roots: ['8h'], step }), T)[0].nodes).toHaveLength(2)
  })

  test('entries: the default test, a first-entry-only test, and one per signal across graphs', () => {
    // A 30m root: 30m -> 5m is 6x, inside the default 8x step.
    const signals = [sig('30m', T, 'top', 1.1), sig('5m', T + 10 * M, 'top', 1.11), sig('5m', T + 20 * M, 'top', 1.12), sig('3m', T + 21 * M, 'top', 1.13)]
    const all = graphEntries(lab(signals, spec({ roots: ['30m'] }), T))
    expect(all.map((e) => e.node.signal.price)).toEqual([1.11, 1.12, 1.13])
    const first = graphEntries(lab(signals, spec({ roots: ['30m'] }), T, [...defaultGraphEntry(), { id: 'first', expr: 'graph.entries == 0', enabled: true }]))
    expect(first.map((e) => e.node.signal.price)).toEqual([1.11])
    const deep = graphEntries(lab(signals, spec({ roots: ['30m'] }), T, [{ id: 'd', expr: 'node.depth >= 2', enabled: true }]))
    expect(deep.map((e) => e.node.signal.price)).toEqual([1.12, 1.13])
  })
})
