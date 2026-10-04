import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// The signal graph's rules (graph.ts): where a graph starts and resets, which lower-timeframe
// signal steps from which, and how a stored config carries the graph's settings.
installWindow()
const { buildGraphs, buildRootGraphs, canStep, graphStart, isEntry, storeGraphSignals } = await import('./graph')
const { FX_GRID } = await import('../replay/timeframes')
const { MTF_DEFAULTS, fromStoredMtfConfig, graphLineStyle, graphRoots, toStoredMtfConfig } = await import('./config')
const { MTF_INTERVALS } = await import('./api')
const { resolutionDurationMs } = await import('../periods')
const { GRID_ARRAY, RegistryStore } = await import('../tsregistry/store')

import type { ArevPoint } from '../arev/api'
import type { GraphSide, GraphSignal } from './graph'

const M = 60_000
const H = 60 * M
const DURATION: Record<string, number> = { '1D': 24 * H, '8h': 8 * H, '4h': 4 * H, '2h': 2 * H, '1h': H, '15m': 15 * M, '5m': 5 * M, '3m': 3 * M }

const sig = (interval: string, knownAt: number, side: GraphSide, price: number): GraphSignal => ({
  interval,
  durationMs: DURATION[interval],
  knownAt,
  // The bar it was cast on: one bar back, which is all these tests need of it.
  sourceDate: knownAt - DURATION[interval],
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

describe('how a graph line is drawn', () => {
  test('solid and full width into 3m and 5m, thinner and more broken the higher it reaches', () => {
    const at = (interval: string) => graphLineStyle(interval, 1.5)
    // The set width is what the lowest timeframes draw at, solid.
    expect(at('3m')).toEqual({ width: 1.5, dash: [] })
    expect(at('5m')).toEqual({ width: 1.5, dash: [] })
    // Everything above is dashed, and the gap grows while the width shrinks.
    const ladder = ['15m', '30m', '1h', '4h', '1D']
    const widths = ladder.map((interval) => at(interval).width)
    const gaps = ladder.map((interval) => at(interval).dash[1])
    expect(widths).toEqual([...widths].sort((a, b) => b - a))
    expect(gaps).toEqual([...gaps].sort((a, b) => a - b))
    expect(widths[0]).toBeLessThan(1.5)
    expect(at('1D').dash[0]).toBeLessThan(at('1D').dash[1])
  })

  test('a dash keeps its proportions at any width, and a line never thins away to nothing', () => {
    expect(graphLineStyle('1D', 3).dash).toEqual(graphLineStyle('1D', 1.5).dash.map((d) => d * 2))
    expect(graphLineStyle('1D', 0.5).width).toBeGreaterThanOrEqual(0.6)
    // A timeframe the table does not know draws solid at the set width rather than vanishing.
    expect(graphLineStyle('1W', 1.5)).toEqual({ width: 1.5, dash: [] })
  })
})

describe('the timeframes the overlay offers', () => {
  test('every one is a different length, which is what lets rule 4 stand alone', () => {
    // `buildGraphs` picks a cross-timeframe parent with no timeframe test of its own: rule 4
    // inside `canStep` refuses a HIGHER timeframe, and a different interval of the SAME length
    // would slip through it as though it were the superseding step. None exists, and this is
    // what says so.
    const lengths = MTF_INTERVALS.map((interval) => resolutionDurationMs(interval))
    expect(new Set(lengths).size).toBe(MTF_INTERVALS.length)
    expect(lengths.every((ms) => Number.isFinite(ms) && ms > 0)).toBe(true)
  })
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

  test('the same timeframe or a lower one, strictly later, strictly further', () => {
    const parent = sig('4h', 10 * H, 'top', 1.1)
    // The same timeframe, later and higher: the superseding step.
    expect(canStep(parent, sig('4h', 20 * H, 'top', 1.2), 8)).toBe(true)
    expect(canStep(parent, sig('4h', 20 * H, 'top', 1.05), 8)).toBe(false) // not further
    expect(canStep(parent, sig('8h', 20 * H, 'top', 1.2), 8)).toBe(false) // a LONGER timeframe
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

  test('a further same-side root supersedes the last one; one that falls short joins nothing', () => {
    const graphs = buildGraphs(
      [
        sig('8h', 0, 'top', 1.1),
        sig('8h', 8 * H, 'top', 1.12), // higher than the root before it: the same graph, stepped
        sig('8h', 16 * H, 'top', 1.11), // short of the graph's reach: not drawn at all
        sig('1h', 17 * H, 'top', 1.13)
      ],
      { root: '8h', maxStep: 8 }
    )
    expect(graphs).toHaveLength(1)
    expect(shape(graphs[0].nodes)).toEqual(['8h@1.1', '8h@1.12 <- 8h@1.1', '1h@1.13 <- 8h@1.12'])
  })

  test('each node hangs from the MOST RECENT node it may step from, so a path can branch', () => {
    const graphs = buildGraphs(
      [
        sig('8h', 0, 'top', 1.1),
        sig('1h', 2 * H, 'top', 1.15),
        sig('2h', 3 * H, 'top', 1.12), // under the graph's reach of 1.15: not drawn
        sig('15m', 4 * H, 'top', 1.13), // likewise
        sig('15m', 5 * H, 'top', 1.16) // past the reach: it joins, from the most recent node
      ],
      { root: '8h', maxStep: 8 }
    )
    expect(shape(graphs[0].nodes)).toEqual(['8h@1.1', '1h@1.15 <- 8h@1.1', '15m@1.16 <- 1h@1.15'])
  })

  test('a timeframe that goes further supersedes its own last node, and the two are joined', () => {
    const graphs = buildGraphs(
      [
        sig('8h', 0, 'top', 1.1),
        sig('1h', 2 * H, 'top', 1.12), // the first 1h: steps from the root
        sig('1h', 3 * H, 'top', 1.13), // higher than 1h@1.12: supersedes it
        sig('1h', 4 * H, 'top', 1.11), // short of the graph's reach: not drawn
        sig('1h', 5 * H, 'top', 1.14) // further again: supersedes the last 1h node drawn
      ],
      { root: '8h', maxStep: 8 }
    )
    expect(shape(graphs[0].nodes)).toEqual(['8h@1.1', '1h@1.12 <- 8h@1.1', '1h@1.13 <- 1h@1.12', '1h@1.14 <- 1h@1.13'])
  })

  test('a bottom graph only ever goes lower, and what it skipped is not drawn', () => {
    const graphs = buildGraphs(
      [sig('8h', 0, 'bottom', 1.2), sig('1h', 1 * H, 'bottom', 1.18), sig('1h', 2 * H, 'bottom', 1.19), sig('1h', 3 * H, 'bottom', 1.17)],
      { root: '8h', maxStep: 8 }
    )
    // 1h@1.19 is above the graph's reach of 1.18, so it joins nothing; 1h@1.17 goes lower and
    // supersedes the last 1h node that WAS drawn.
    expect(shape(graphs[0].nodes)).toEqual(['8h@1.2', '1h@1.18 <- 8h@1.2', '1h@1.17 <- 1h@1.18'])
  })

  test('the reach is the whole graph, not one timeframe', () => {
    const graphs = buildGraphs(
      [
        sig('8h', 0, 'top', 1.1),
        sig('1h', 1 * H, 'top', 1.2), // the graph reaches 1.2
        sig('4h', 2 * H, 'top', 1.15), // its own timeframe has no node yet, but the GRAPH is past it
        sig('15m', 3 * H, 'top', 1.19) // likewise
      ],
      { root: '8h', maxStep: 8 }
    )
    expect(shape(graphs[0].nodes)).toEqual(['8h@1.1', '1h@1.2 <- 8h@1.1'])
  })

  test('the reach is the graph own: the next graph starts from nothing', () => {
    const graphs = buildGraphs(
      [sig('8h', 0, 'top', 1.3), sig('8h', 8 * H, 'bottom', 1.1), sig('1h', 9 * H, 'bottom', 1.09)],
      { root: '8h', maxStep: 8 }
    )
    expect(shape(graphs[1].nodes)).toEqual(['8h@1.1', '1h@1.09 <- 8h@1.1'])
  })

  test('superseding is within one graph: a new graph starts from nothing', () => {
    const graphs = buildGraphs(
      [
        sig('8h', 0, 'top', 1.2),
        sig('1h', 1 * H, 'top', 1.25),
        sig('8h', 2 * H, 'bottom', 1.1),
        // In the new graph this 1h signal is the first of its timeframe, whatever the old
        // graph reached.
        sig('1h', 3 * H, 'bottom', 1.09)
      ],
      { root: '8h', maxStep: 8 }
    )
    expect(shape(graphs[1].nodes)).toEqual(['8h@1.1', '1h@1.09 <- 8h@1.1'])
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

describe('entries', () => {
  test('every step on 5m or shorter is an entry, however far down the graph it is', () => {
    const graphs = buildGraphs(
      [
        sig('8h', 8 * H, 'top', 1.1),
        sig('1h', 10 * H, 'top', 1.102),
        sig('15m', 14 * H, 'top', 1.103),
        sig('5m', 15 * H, 'top', 1.104), // the first entry: the path reaches 5m
        sig('5m', 16 * H, 'top', 1.105), // supersedes it: an entry too
        sig('3m', 17 * H, 'top', 1.106), // steps from the 5m: an entry too
        sig('5m', 18 * H, 'top', 1.1055) // short of the graph's reach: not in the graph at all
      ],
      { root: '8h', maxStep: 8 }
    )
    expect(graphs).toHaveLength(1)
    const entries = graphs[0].nodes.filter(isEntry).map((n) => `${n.signal.interval}@${n.signal.price}`)
    expect(entries).toEqual(['5m@1.104', '5m@1.105', '3m@1.106'])
  })

  test('a root is never an entry, and nothing above 5m is', () => {
    expect(isEntry({ signal: sig('5m', 0, 'top', 1), parent: -1 })).toBe(false)
    expect(isEntry({ signal: sig('15m', 0, 'top', 1), parent: 0 })).toBe(false)
    expect(isEntry({ signal: sig('5m', 0, 'top', 1), parent: 0 })).toBe(true)
    expect(isEntry({ signal: sig('3m', 0, 'top', 1), parent: 0 })).toBe(true)
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
    const out = storeGraphSignals('4h', store, FX_GRID)
    expect(out.map(({ side, price, knownAt }) => ({ side, price, knownAt }))).toEqual([
      { side: 'top', price: 1.15, knownAt: 4 * H },
      { side: 'bottom', price: 1.12, knownAt: 8 * H },
      { side: 'top', price: 1.35, knownAt: 12 * H },
      { side: 'bottom', price: 1.28, knownAt: 16 * H }
    ])
  })

  test('the newest signal, whose successor is still forming and so not in the grid, is knowable at its own close', () => {
    // The grid is `/getbars`, closed bars only: at the live edge the bar after the newest vote
    // is the forming one. The vote exists, so its bar closed -- at open + 4h.
    const store = new RegistryStore<ArevPoint>('k', (p) => p as ArevPoint)
    store.ingest([point(0, 'long'), point(4 * H, 'long')], { from: 0, to: 8 * H }, {
      [GRID_ARRAY]: [
        { date: 0, open: 1.0, close: 1.1 },
        { date: 4 * H, open: 1.1, close: 1.2 }
      ]
    })
    expect(storeGraphSignals('4h', store, FX_GRID).map((s) => s.knownAt)).toEqual([4 * H, 8 * H])
  })

  test('a signal whose candle body is not held is left out, and a price-less re-fetch keeps a known body', () => {
    const store = new RegistryStore<ArevPoint>('k', (p) => p as ArevPoint)
    store.ingest([point(0, 'long')], { from: 0, to: 8 * H }, { [GRID_ARRAY]: [{ date: 0 }, { date: 4 * H }] })
    expect(storeGraphSignals('4h', store, FX_GRID)).toEqual([])
    store.ingest([], { from: 0, to: 8 * H }, { [GRID_ARRAY]: [{ date: 0, open: 1.1, close: 1.2 }] })
    store.ingest([], { from: 0, to: 8 * H }, { [GRID_ARRAY]: [{ date: 0 }] })
    expect(storeGraphSignals('4h', store, FX_GRID).map((s) => s.price)).toEqual([1.2])
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

  test('a signal the longer graph already stepped to does not also root its own graph', () => {
    const graphs = buildRootGraphs(
      [sig('1D', 0, 'top', 1.1), sig('8h', 8 * H, 'top', 1.12), sig('1h', 9 * H, 'top', 1.13)],
      ['1D', '8h'],
      8,
      Number.NEGATIVE_INFINITY
    )
    // One graph, not two saying the same thing: the 8h signal is the 1D graph's step.
    expect(graphs.map((g) => g.root)).toEqual(['1D'])
    expect(shape(graphs[0].nodes)).toEqual(['1D@1.1', '8h@1.12 <- 1D@1.1', '1h@1.13 <- 8h@1.12'])
  })

  test('a signal the longer graph did NOT take still roots its own', () => {
    // The 8h top is the other side from the 1D bottom graph, so nothing took it.
    const graphs = buildRootGraphs(
      [sig('1D', 0, 'bottom', 1.1), sig('8h', 8 * H, 'top', 1.12), sig('1h', 9 * H, 'top', 1.13)],
      ['1D', '8h'],
      8,
      Number.NEGATIVE_INFINITY
    )
    expect(graphs.map((g) => g.root)).toEqual(['1D', '8h'])
    expect(shape(graphs[1].nodes)).toEqual(['8h@1.12', '1h@1.13 <- 8h@1.12'])
  })

  test('a taken root signal still ends the graph in force when it switches side', () => {
    const graphs = buildRootGraphs(
      [
        // An 8h top graph, then a 1D bottom graph whose step is an 8h BOTTOM signal: that
        // signal is taken, so it opens no 8h graph -- but the 8h top graph ends there all the
        // same, and the next 8h bottom that nothing took opens one.
        sig('8h', 0, 'top', 1.2),
        sig('1h', 1 * H, 'top', 1.22),
        sig('1D', 2 * H, 'bottom', 1.15),
        sig('8h', 3 * H, 'bottom', 1.14),
        sig('1h', 4 * H, 'top', 1.25),
        sig('8h', 5 * H, 'bottom', 1.16),
        sig('1h', 6 * H, 'bottom', 1.13)
      ],
      ['1D', '8h'],
      8,
      Number.NEGATIVE_INFINITY
    )
    expect(graphs.map((g) => `${g.root} ${g.side}`)).toEqual(['1D bottom', '8h top', '8h bottom'])
    expect(shape(graphs[0].nodes)).toEqual(['1D@1.15', '8h@1.14 <- 1D@1.15', '1h@1.13 <- 8h@1.14'])
    // The 8h top graph closed at the switch: the 1h top of 4H did not join it.
    expect(shape(graphs[1].nodes)).toEqual(['8h@1.2', '1h@1.22 <- 8h@1.2'])
    // The taken 8h bottom of 3H opened nothing; the untaken one of 5H did. The 1h bottom is a
    // step in both the 1D graph and this one -- the rule stops a signal ROOTING twice, not
    // stepping in two graphs.
    expect(shape(graphs[2].nodes)).toEqual(['8h@1.16', '1h@1.13 <- 8h@1.16'])
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

  test('the hide-the-rest switch round-trips, and defaults to off', () => {
    expect(MTF_DEFAULTS.graph.onlyGraph).toBe(false)
    const config = structuredClone(MTF_DEFAULTS)
    config.graph.onlyGraph = true
    expect(toStoredMtfConfig(config)).toEqual({ graph: { onlyGraph: true } })
    expect(fromStoredMtfConfig({ graph: { onlyGraph: true } })?.graph.onlyGraph).toBe(true)
    // A bad value falls back to the default; a document holding nothing else usable reads as
    // no config at all, which is what `undefined` says.
    expect(fromStoredMtfConfig({ graph: { onlyGraph: 'yes' }, '4h': { enabled: false } })?.graph.onlyGraph).toBe(false)
    expect(fromStoredMtfConfig({ graph: { onlyGraph: 'yes' } })).toBeUndefined()
  })

  test('the entry star: timeframe colour and a white outline by default, both settable', () => {
    expect(MTF_DEFAULTS.graph.starTimeframeColour).toBe(true)
    expect(MTF_DEFAULTS.graph.starOutline).toBe('#FFFFFF')
    const config = structuredClone(MTF_DEFAULTS)
    config.graph.starTimeframeColour = false
    config.graph.starColor = '#ff0000'
    config.graph.starOutline = '#000000'
    const stored = toStoredMtfConfig(config)
    expect(stored).toEqual({ graph: { starTimeframeColour: false, starColor: '#ff0000', starOutline: '#000000' } })
    expect(fromStoredMtfConfig(JSON.parse(JSON.stringify(stored)))?.graph).toEqual(config.graph)
  })

  test('the colour input writes lower case, and white in lower case is still the default', () => {
    const config = structuredClone(MTF_DEFAULTS)
    config.graph.starOutline = '#ffffff'
    expect(toStoredMtfConfig(config)).toBeUndefined()
  })

  test('a colour that is not #rrggbb falls back to the default rather than reaching the canvas', () => {
    const back = fromStoredMtfConfig({
      graph: { starColor: 'gold', starOutline: '#fff', starTimeframeColour: 'no' },
      '1h': { enabled: false }
    })
    expect(back?.graph.starColor).toBe(MTF_DEFAULTS.graph.starColor)
    expect(back?.graph.starOutline).toBe(MTF_DEFAULTS.graph.starOutline)
    expect(back?.graph.starTimeframeColour).toBe(true)
  })

  test('a config from before the star settings stores and reads as the defaults', () => {
    const config = structuredClone(MTF_DEFAULTS) as { graph: Partial<typeof MTF_DEFAULTS.graph> }
    delete config.graph.starTimeframeColour
    delete config.graph.starColor
    delete config.graph.starOutline
    expect(toStoredMtfConfig(config as typeof MTF_DEFAULTS)).toBeUndefined()
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
