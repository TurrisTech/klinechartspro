import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// The signal graph's rules (graph.ts): where a graph starts and resets, which lower-timeframe
// signal steps from which, and how a stored config carries the graph's settings.
installWindow()
const { buildGraphs, buildRootGraphs, canStep, graphStart, storeGraphSignals } = await import('./graph')
const { MTF_DEFAULTS, fromStoredMtfConfig, graphRoots, toStoredMtfConfig } = await import('./config')
const { GRID_ARRAY, RegistryStore } = await import('../tsregistry/store')

import type { ArevPoint } from '../arev/api'
import type { GraphSide, GraphSignal } from './graph'

const M = 60_000
const H = 60 * M
const DURATION: Record<string, number> = { '1D': 24 * H, '8h': 8 * H, '4h': 4 * H, '1h': H, '15m': 15 * M, '5m': 5 * M, '3m': 3 * M }

const sig = (interval: string, knownAt: number, side: GraphSide, price: number): GraphSignal => ({
  interval,
  durationMs: DURATION[interval],
  knownAt,
  side,
  price
})

/** Each node as `interval@price <- parent interval@price`, for readable expectations. */
const shape = (nodes: { signal: GraphSignal; parent: number }[]) =>
  nodes.map((n) => {
    const self = `${n.signal.interval}@${n.signal.price}`
    const parent = n.parent < 0 ? null : nodes[n.parent].signal
    return parent ? `${self} <- ${parent.interval}@${parent.price}` : self
  })

describe('buildGraphs', () => {
  test('a cascade the user described is one path: 8h -> 1h -> 15m -> 5m, each higher', () => {
    const graphs = buildGraphs(
      [
        sig('5m', 20 * H, 'top', 1.104),
        sig('8h', 8 * H, 'top', 1.1),
        sig('15m', 14 * H, 'top', 1.103),
        sig('1h', 10 * H, 'top', 1.102)
      ],
      { root: '8h', maxStep: 8 }
    )
    expect(graphs).toHaveLength(1)
    expect(graphs[0].side).toBe('top')
    expect(shape(graphs[0].nodes)).toEqual(['8h@1.1', '1h@1.102 <- 8h@1.1', '15m@1.103 <- 1h@1.102', '5m@1.104 <- 15m@1.103'])
  })

  test('a bottom graph steps LOWER', () => {
    const graphs = buildGraphs(
      [sig('4h', 0, 'bottom', 1.1), sig('1h', 5 * H, 'bottom', 1.09), sig('1h', 6 * H, 'bottom', 1.11)],
      { root: '4h', maxStep: 8 }
    )
    expect(shape(graphs[0].nodes)).toEqual(['4h@1.1', '1h@1.09 <- 4h@1.1'])
  })

  test('a step may skip timeframes up to maxStep, but 8h -> 3m is too far', () => {
    const signals = [sig('8h', 0, 'top', 1.1), sig('3m', H, 'top', 1.2)]
    expect(buildGraphs(signals, { root: '8h', maxStep: 8 })[0].nodes).toHaveLength(1)
    expect(buildGraphs(signals, { root: '8h', maxStep: 160 })[0].nodes).toHaveLength(2)
    // Exactly 8x is allowed: 8h -> 1h.
    expect(canStep(sig('8h', 0, 'top', 1), sig('1h', H, 'top', 2), 8)).toBe(true)
    expect(canStep(sig('8h', 0, 'top', 1), sig('15m', H, 'top', 2), 8)).toBe(false)
  })

  test('only strictly lower timeframes, strictly later, strictly further', () => {
    const parent = sig('4h', 10 * H, 'top', 1.1)
    expect(canStep(parent, sig('4h', 20 * H, 'top', 1.2), 8)).toBe(false) // same timeframe
    expect(canStep(parent, sig('1h', 10 * H, 'top', 1.2), 8)).toBe(false) // same instant
    expect(canStep(parent, sig('1h', 9 * H, 'top', 1.2), 8)).toBe(false) // earlier
    expect(canStep(parent, sig('1h', 11 * H, 'top', 1.1), 8)).toBe(false) // level, not higher
    expect(canStep(parent, sig('1h', 11 * H, 'bottom', 1.2), 8)).toBe(false) // other side
    expect(canStep(parent, sig('1h', 11 * H, 'top', 1.1001), 8)).toBe(true)
  })

  test('the root switching side resets: the old graph takes nothing after the switch', () => {
    const graphs = buildGraphs(
      [
        sig('8h', 0, 'top', 1.1),
        sig('1h', 2 * H, 'top', 1.11),
        sig('8h', 8 * H, 'bottom', 1.05),
        // After the switch: a top signal above the old graph joins nothing, a bottom signal
        // under the new root joins the new graph.
        sig('1h', 9 * H, 'top', 1.2),
        sig('1h', 10 * H, 'bottom', 1.04)
      ],
      { root: '8h', maxStep: 8 }
    )
    expect(graphs.map((g) => g.side)).toEqual(['top', 'bottom'])
    expect(shape(graphs[0].nodes)).toEqual(['8h@1.1', '1h@1.11 <- 8h@1.1'])
    expect(shape(graphs[1].nodes)).toEqual(['8h@1.05', '1h@1.04 <- 8h@1.05'])
  })

  test('a signal known at the instant of the switch belongs to neither graph', () => {
    const graphs = buildGraphs(
      [sig('8h', 0, 'top', 1.1), sig('1h', 8 * H, 'top', 1.2), sig('8h', 8 * H, 'bottom', 1.05)],
      { root: '8h', maxStep: 8 }
    )
    expect(graphs.map((g) => g.nodes.length)).toEqual([1, 1])
  })

  test('a further same-side root joins the graph as another root, and later nodes hang from it', () => {
    const graphs = buildGraphs(
      [sig('8h', 0, 'top', 1.1), sig('8h', 8 * H, 'top', 1.12), sig('1h', 9 * H, 'top', 1.13)],
      { root: '8h', maxStep: 8 }
    )
    expect(graphs).toHaveLength(1)
    expect(shape(graphs[0].nodes)).toEqual(['8h@1.1', '8h@1.12', '1h@1.13 <- 8h@1.12'])
  })

  test('each node hangs from the MOST RECENT node it may step from, so a path can branch', () => {
    const graphs = buildGraphs(
      [
        sig('8h', 0, 'top', 1.1),
        sig('1h', 2 * H, 'top', 1.15),
        sig('1h', 3 * H, 'top', 1.12), // not above 1h@1.15, and 1h cannot step from 1h: from the root
        sig('15m', 4 * H, 'top', 1.13), // above 1h@1.12, the most recent it may step from
        sig('15m', 5 * H, 'top', 1.16) // above both 1h nodes: the more recent one wins
      ],
      { root: '8h', maxStep: 8 }
    )
    expect(shape(graphs[0].nodes)).toEqual([
      '8h@1.1',
      '1h@1.15 <- 8h@1.1',
      '1h@1.12 <- 8h@1.1',
      '15m@1.13 <- 1h@1.12',
      '15m@1.16 <- 1h@1.12'
    ])
  })

  test('nothing joins before the first root signal, and timeframes above the root take no part', () => {
    const graphs = buildGraphs(
      [sig('1h', 0, 'top', 1.2), sig('1D', H, 'bottom', 1.0), sig('4h', 4 * H, 'top', 1.1), sig('1h', 5 * H, 'top', 1.11)],
      { root: '4h', maxStep: 8 }
    )
    expect(graphs).toHaveLength(1)
    expect(shape(graphs[0].nodes)).toEqual(['4h@1.1', '1h@1.11 <- 4h@1.1'])
  })

  test('`from` drops everything known before it', () => {
    const graphs = buildGraphs([sig('4h', 0, 'top', 1.1), sig('4h', 8 * H, 'bottom', 1.0), sig('1h', 9 * H, 'bottom', 0.9)], {
      root: '4h',
      maxStep: 8,
      from: 8 * H
    })
    expect(graphs.map((g) => g.side)).toEqual(['bottom'])
    expect(graphs[0].nodes).toHaveLength(2)
  })
})

describe('graphStart', () => {
  const roots = [
    sig('8h', 0, 'bottom', 1),
    sig('8h', 8 * H, 'top', 1),
    sig('8h', 16 * H, 'top', 1),
    sig('8h', 40 * H, 'top', 1),
    sig('8h', 48 * H, 'bottom', 1)
  ]

  test('the first signal of the run of same-side root signals in force at the left edge', () => {
    expect(graphStart(roots, 44 * H, 1000 * H)).toBe(8 * H)
    expect(graphStart(roots, 48 * H, 1000 * H)).toBe(48 * H)
  })

  test('the walk stops at the look-back, cutting a longer run there', () => {
    expect(graphStart(roots, 44 * H, 30 * H)).toBe(16 * H)
  })

  test('the left edge itself when no root signal is in the span', () => {
    expect(graphStart(roots, 44 * H, 2 * H)).toBe(44 * H)
    expect(graphStart([], 44 * H, 1000 * H)).toBe(44 * H)
  })
})

describe('storeGraphSignals', () => {
  const point = (date: number, signal: 'long' | 'short' | null): ArevPoint =>
    ({ date, prediction: 0, n: 200, p: signal === 'long' ? 0.7 : 0.3, confidence: 0.2, atCross: true, signal }) as ArevPoint

  test('prices a top signal at the top of its candle BODY and a bottom one at its bottom, at the close', () => {
    const store = new RegistryStore<ArevPoint>('k', (p) => p as ArevPoint)
    store.ingest([point(0, 'long'), point(4 * H, 'short'), point(8 * H, 'long'), point(12 * H, 'short')], { from: 0, to: 20 * H }, {
      [GRID_ARRAY]: [
        // A rising candle: its body's top is the close, its bottom the open.
        { date: 0, open: 1.05, close: 1.15 },
        // A falling candle: its body's top is the open, its bottom the close.
        { date: 4 * H, open: 1.25, close: 1.12 },
        { date: 8 * H, open: 1.3, close: 1.35 },
        { date: 12 * H, open: 1.34, close: 1.28 },
        { date: 16 * H, open: 1.28, close: 1.3 }
      ]
    })
    const out = storeGraphSignals('4h', store)
    expect(out.map(({ side, price, knownAt }) => ({ side, price, knownAt }))).toEqual([
      { side: 'top', price: 1.15, knownAt: 4 * H },
      { side: 'bottom', price: 1.12, knownAt: 8 * H },
      { side: 'top', price: 1.35, knownAt: 12 * H },
      { side: 'bottom', price: 1.28, knownAt: 16 * H }
    ])
  })

  test('a signal whose bar has not closed is not knowable, and is left out', () => {
    const store = new RegistryStore<ArevPoint>('k', (p) => p as ArevPoint)
    store.ingest([point(0, 'long'), point(4 * H, 'long')], { from: 0, to: 8 * H }, {
      [GRID_ARRAY]: [
        { date: 0, open: 1.0, close: 1.1 },
        { date: 4 * H, open: 1.1, close: 1.2 }
      ]
    })
    expect(storeGraphSignals('4h', store).map((s) => s.knownAt)).toEqual([4 * H])
  })

  test('a signal whose candle body is not held is left out, and a price-less re-fetch keeps a known body', () => {
    const store = new RegistryStore<ArevPoint>('k', (p) => p as ArevPoint)
    store.ingest([point(0, 'long')], { from: 0, to: 8 * H }, { [GRID_ARRAY]: [{ date: 0 }, { date: 4 * H }] })
    expect(storeGraphSignals('4h', store)).toEqual([])
    store.ingest([], { from: 0, to: 8 * H }, { [GRID_ARRAY]: [{ date: 0, open: 1.1, close: 1.2 }] })
    store.ingest([], { from: 0, to: 8 * H }, { [GRID_ARRAY]: [{ date: 0 }] })
    expect(storeGraphSignals('4h', store).map((s) => s.price)).toEqual([1.2])
  })
})

describe('several roots at once', () => {
  // A 1D bottom run and, inside it, an 8h TOP run: two graphs over the same bars, running
  // opposite ways. Each root resets only on its own signals.
  const signals = [
    sig('1D', 0, 'bottom', 1.1),
    sig('8h', 8 * H, 'top', 1.09),
    sig('4h', 12 * H, 'bottom', 1.08),
    sig('4h', 16 * H, 'top', 1.095),
    sig('1h', 17 * H, 'top', 1.1),
    sig('1h', 18 * H, 'bottom', 1.07)
  ]

  test('each root builds its own graphs, and they may overlap in time and run opposite ways', () => {
    const graphs = buildRootGraphs(signals, ['8h', '1D'], 8, Number.NEGATIVE_INFINITY)
    expect(graphs.map((g) => `${g.root} ${g.side}`)).toEqual(['1D bottom', '8h top'])
    expect(shape(graphs[0].nodes)).toEqual(['1D@1.1', '4h@1.08 <- 1D@1.1', '1h@1.07 <- 4h@1.08'])
    expect(shape(graphs[1].nodes)).toEqual(['8h@1.09', '4h@1.095 <- 8h@1.09', '1h@1.1 <- 4h@1.095'])
  })

  test('a signal can root one graph and step in another', () => {
    const graphs = buildRootGraphs(
      [sig('1D', 0, 'top', 1.1), sig('8h', 8 * H, 'top', 1.12), sig('1h', 9 * H, 'top', 1.13)],
      ['1D', '8h'],
      8,
      Number.NEGATIVE_INFINITY
    )
    expect(shape(graphs[0].nodes)).toEqual(['1D@1.1', '8h@1.12 <- 1D@1.1', '1h@1.13 <- 8h@1.12'])
    expect(shape(graphs[1].nodes)).toEqual(['8h@1.12', '1h@1.13 <- 8h@1.12'])
  })

  test('the roots switched on, longest first', () => {
    const config = structuredClone(MTF_DEFAULTS)
    config.graph.roots['4h'] = true
    config.graph.roots['1D'] = false
    config.graph.roots['8h'] = true
    expect(graphRoots(config)).toEqual(['8h', '4h'])
    expect(graphRoots(MTF_DEFAULTS)).toEqual(['1D'])
  })
})

describe('graph settings in the stored config', () => {
  test('on the defaults nothing is stored; a change round-trips as a diff', () => {
    expect(toStoredMtfConfig(structuredClone(MTF_DEFAULTS))).toBeUndefined()
    const config = structuredClone(MTF_DEFAULTS)
    config.graph.roots['8h'] = true
    config.graph.maxStep = 4
    const stored = toStoredMtfConfig(config)
    expect(stored).toEqual({ graph: { roots: { '8h': true }, maxStep: 4 } })
    const back = fromStoredMtfConfig(JSON.parse(JSON.stringify(stored)))
    expect(back?.graph).toEqual({ ...MTF_DEFAULTS.graph, roots: { ...MTF_DEFAULTS.graph.roots, '8h': true }, maxStep: 4 })
  })

  test('the single root client-a2c8f6c saved reads as that one root on, and nothing else', () => {
    expect(graphRoots(fromStoredMtfConfig({ graph: { from: '8h' } }))).toEqual(['8h'])
    expect(graphRoots(fromStoredMtfConfig({ graph: { from: 'off' } }))).toEqual([])
    // A document that states roots is read by them, whatever else it says.
    expect(graphRoots(fromStoredMtfConfig({ graph: { from: '8h', roots: { '4h': true } } }))).toEqual(['1D', '4h'])
  })

  test('a bad value falls back to its default, and a document from before the graph reads unchanged', () => {
    const back = fromStoredMtfConfig({
      graph: { from: '3m', roots: { '1D': 'yes', '2h': true, '3m': true }, maxStep: 1, lineWidth: 2 },
      '4h': { color: '#000000' }
    })
    expect(back?.graph).toEqual({ ...MTF_DEFAULTS.graph, roots: { ...MTF_DEFAULTS.graph.roots, '2h': true }, lineWidth: 2 })
    expect(back?.timeframes['4h'].color).toBe('#000000')
    expect(fromStoredMtfConfig({ '1h': { enabled: false } })?.graph).toEqual(MTF_DEFAULTS.graph)
  })
})
