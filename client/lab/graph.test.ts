import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import parity from './fixtures/graph_parity.json'

// The lab's graph builder against the overlay's: with every slot at its default it must build
// the SAME graphs from the same signals -- same roots, same nodes, same parents, same entries --
// because a strategy developed in the lab is meant to be the graph the wall draws. The wall's
// graph is the server's since wdashboard-server 0.56.0 (services/mtfgraph.py), so the reference
// is the server's own output: `fixtures/graph_parity.json`, generated and checked there by
// tests/mtfgraph/ and vendored by scripts/sync-engine-fixtures.sh. Then each slot, one at a time.
installWindow()
const { buildRootGraphs, graphEntries, graphStarts } = await import('./graph')
const { defaultGraph, defaultGraphEntry, defaultStep } = await import('./model')

import type { GraphSpec, Side, SlotCondition } from './model'
import type { LabGraph, LabSignal, Readings } from './graph'

const M = 60_000
const H = 60 * M
const DURATION: Record<string, number> = { '1D': 24 * H, '8h': 8 * H, '4h': 4 * H, '2h': 2 * H, '1h': H, '30m': 30 * M, '15m': 15 * M, '5m': 5 * M, '3m': 3 * M }

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

const spec = (patch: Partial<GraphSpec> = {}): GraphSpec => ({ ...defaultGraph(), ...patch })

function lab(signals: LabSignal[], s: GraphSpec, from: number, entry: SlotCondition[] = defaultGraphEntry()): LabGraph[] {
  return buildRootGraphs({ signals, spec: s, entry, from, readings: NO_READINGS })
}

/** A graph as the fixture states it: root, side, and each node as `[key, parent key, entry]`,
 * a signal's key being `interval|knownAt`. */
const asFixture = (graphs: LabGraph[]) =>
  graphs.map((g) => {
    const key = (n: { signal: LabSignal }) => `${n.signal.interval}|${n.signal.knownAt}`
    return { root: g.root, side: g.side, nodes: g.nodes.map((n) => [key(n), n.parent < 0 ? null : key(g.nodes[n.parent]), n.entry]) }
  })

describe('the default slots build the server’s graphs', () => {
  test('the fixture is vendored from the server, not written here', () => {
    expect(String(parity.$comment)).toContain('GENERATED')
    expect(String(parity.$comment)).toContain('gen_graph_parity.py')
    // The lab's default entry test is the server's: a step on this timeframe or shorter.
    expect(parity.entryMaxInterval).toBe('5m')
  })

  const pools = (parity.pools as Array<Array<[string, number, Side, number]>>).map((rows) =>
    rows.map(([interval, knownAt, side, price]) => sig(interval, knownAt, side, price))
  )
  const ROOT_SETS = [...new Set(parity.cases.map((c) => c.roots.join('+')))]
  for (const rootSet of ROOT_SETS) {
    test(`roots ${rootSet}, every largest step, every pool`, () => {
      const cases = parity.cases.filter((c) => c.roots.join('+') === rootSet)
      expect(cases.length).toBeGreaterThan(0)
      for (const c of cases) {
        const ours = asFixture(lab(pools[c.pool], spec({ roots: c.roots, step: defaultStep(c.maxStep) }), c.from))
        expect(ours, `pool ${c.pool}, roots ${rootSet}, step ${c.maxStep}`).toEqual(c.graphs as never)
      }
    })
  }

  test('a longer root starts from its run in force at a shorter root’s start', () => {
    // 8h's run in force at 40H began at 10H; 1D's run in force at 10H began at 5H -- not the 1D
    // run in force at 40H, which began at 20H. (The server's `walk_starts`, same case.)
    const signals = [
      sig('8h', 0, 'top', 1),
      sig('8h', 10 * H, 'bottom', 1),
      sig('8h', 30 * H, 'bottom', 1),
      sig('1D', -48 * H, 'top', 1),
      sig('1D', 5 * H, 'bottom', 1),
      sig('1D', 20 * H, 'top', 1)
    ]
    const starts = graphStarts({ signals, spec: spec({ roots: ['1D', '8h'] }), from: 40 * H })
    expect(Object.fromEntries(starts)).toEqual({ '8h': 10 * H, '1D': 5 * H })
  })
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
