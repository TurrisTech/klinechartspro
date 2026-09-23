import type { ArevPoint } from '../arev/api'
import { resolutionDurationMs } from '../periods'
import type { GridBody } from '../tsregistry/store'
import { knowableSignals } from './shift'

// The signal GRAPH a multi-timeframe overlay can draw over its markers (user, 2026-09-21):
// from a higher timeframe's signal down to lower timeframes' signals that went further the
// same way, so each graph climbs to the top right (top signals) or falls to the bottom right
// (bottom signals).
//
// The rules, as the user gave them, and what each became here:
//
//   * a graph starts from a signal on a ROOT timeframe (1D, 8h, 4h, 2h or 1h). Several roots
//     may be on at once (user, 2026-09-21: "allow for different roots to intersect"); each
//     builds and resets its own graphs from its own signals, blind to the others, so a 1D
//     bottom graph and an 8h top graph can run over the same bars and cross (`buildRootGraphs`).
//     On prod EURUSD the 1D and 8h graphs in force point opposite ways 39% of the time;
//   * when the root timeframe's signal switches SIDE the graph resets: the root's first signal
//     of the other side starts a new graph, and nothing joins the old one after that instant.
//     A further root signal of the SAME side joins the current graph as another root;
//   * a top signal is joined to a later top signal on a LOWER timeframe that is HIGHER, a
//     bottom signal to a later bottom one that is LOWER -- and the same again from there, so a
//     path steps down the timeframes while the price keeps going the graph's way;
//   * a signal SUPERSEDES its own timeframe's last node in the graph when it is later and
//     further the graph's way -- higher for a top graph, lower for a bottom one -- and the two
//     are joined by a line (user, 2026-09-23). So a timeframe's own nodes read as a staircase
//     of its own, and the cross-timeframe step is what starts each one. A signal that does NOT
//     supersede (it fell short of its timeframe's last node) still joins where it always did,
//     from the most recent LONGER timeframe's node it may step from;
//   * a step may skip a timeframe but not too many: "8h -> 1h -> 15m -> 5m is reasonable,
//     8h -> 3m is not". That is `maxStep`, the most a step may shrink the timeframe by, as a
//     ratio of nominal lengths -- 8 by default, which is exactly 8h -> 1h. A ratio rather than
//     a count of skipped timeframes, because the ladder has uneven rungs (20m and 2h sit
//     between the original eight) and because which timeframes a pane has switched on must
//     not change what counts as a skip.
//
// Three choices the rules leave open, made here:
//
//   * A signal's HEIGHT is the top (top signal) or bottom (bottom signal) of the BODY of the
//     candle it was cast on -- the higher or the lower of its open and close (user, 2026-09-21;
//     it was the wick's high or low until then). The body is fully known by the instant the
//     signal is -- the source bar's close, where its marker sits. The bar the marker is drawn
//     on would be lookahead: it is still forming when the signal arrives. It would also make
//     the graph depend on the chart's interval.
//   * TIME is the instant each signal became knowable (shift.ts), and a step must go strictly
//     later: the multi-timeframe ordering rule in the workspace CLAUDE.md, under which two
//     signals that arrived at the same instant cannot be cause and effect.
//   * Each signal hangs from ONE parent -- the most recent signal already in the graph that it
//     may step from. Drawing every permitted edge would draw the transitive closure (a 5m
//     signal above an 8h root is usually also above the 1h node between them), which is a
//     fan of lines rather than a path. With one parent, signals that arrive in cascade order
//     make exactly the path the user described, and one that arrives beside an existing path
//     branches from it. Every edge still goes up and right (or down and right).

export type GraphSide = 'top' | 'bottom'

/** One signal as the graph sees it. */
export interface GraphSignal {
  /** The timeframe the signal was cast on. */
  interval: string
  /** That timeframe's nominal length: what orders timeframes and bounds a step. */
  durationMs: number
  /** The instant the signal became knowable, absolute. */
  knownAt: number
  /** The wire date of the bar it was cast on -- what the server's signal wire calls it. */
  sourceDate: number
  side: GraphSide
  /** The top of the body of the candle it was cast on for a top signal, the bottom of that
   * body for a bottom one. */
  price: number
}

export interface GraphNode<S extends GraphSignal = GraphSignal> {
  signal: S
  /** Index of its parent in the same graph's `nodes`, or -1 for a root. */
  parent: number
}

/** One graph: the signals from one run of same-side root signals, parents before children. */
export interface Graph<S extends GraphSignal = GraphSignal> {
  side: GraphSide
  nodes: GraphNode<S>[]
}

export interface GraphOptions {
  /** The timeframe graphs start from. Signals on longer timeframes take no part. */
  root: string
  /** The most a step may shrink the timeframe by (`parent / child` nominal lengths). */
  maxStep: number
  /** Signals knowable before this instant take no part (`graphStart`). */
  from?: number
  /** Root-timeframe signals that may NOT start a graph here, because they already step in a
   * longer root's graph (user, 2026-09-21: "if a node is already part of a higher timeframe
   * graph, don't let it be its own root"). They still END the graph in force when they switch
   * side -- the switch happened, whoever else drew the signal -- they just do not open one, so
   * the run they would have started begins at its first signal that is not already spoken for.
   * `buildRootGraphs` fills this in; a lone root has nothing to put in it. */
  taken?: ReadonlySet<GraphSignal>
}

/** Whether `child` may hang from `parent`: the same timeframe or a longer one by no more than
 * `maxStep`, strictly later, and strictly further the graph's way.
 *
 * The same timeframe is the SUPERSEDING case -- a timeframe's next node, further along than
 * its last -- and it is only ever offered the node it supersedes (`buildGraphs`); every other
 * candidate is a longer timeframe, which is what makes a path step DOWN the timeframes. */
export function canStep(parent: GraphSignal, child: GraphSignal, maxStep: number): boolean {
  if (child.side !== parent.side) return false
  if (!(parent.durationMs >= child.durationMs)) return false
  if (parent.durationMs > child.durationMs * maxStep) return false
  if (!(parent.knownAt < child.knownAt)) return false
  return child.side === 'top' ? child.price > parent.price : child.price < parent.price
}

/**
 * The graphs `signals` make, oldest first.
 *
 * Walked in the order the signals became knowable, so every decision uses only what was
 * known when it was made: a graph drawn over history is the graph a reader would have seen
 * grow live. At one instant root signals go first -- a side switch takes effect at the
 * instant it is known, so a lower-timeframe signal arriving at that same instant belongs to
 * neither graph (the old one is closed, and it cannot step from a root that arrived with it)
 * -- then longer timeframes before shorter.
 */
export function buildGraphs<S extends GraphSignal>(signals: Iterable<S>, options: GraphOptions): Graph<S>[] {
  const rootMs = resolutionDurationMs(options.root)
  const from = options.from ?? Number.NEGATIVE_INFINITY
  const ordered = [...signals]
    .filter((s) => s.durationMs <= rootMs && s.knownAt >= from && Number.isFinite(s.price))
    .sort((a, b) => {
      if (a.knownAt !== b.knownAt) return a.knownAt - b.knownAt
      const aRoot = a.interval === options.root ? 0 : 1
      const bRoot = b.interval === options.root ? 0 : 1
      if (aRoot !== bRoot) return aRoot - bRoot
      return b.durationMs - a.durationMs
    })
  const graphs: Graph<S>[] = []
  let current: Graph<S> | null = null
  // A graph reaches the answer only once it has a node: a run whose every root signal is
  // already a step in a longer root's graph opens nothing, and nothing can join it either --
  // a lower-timeframe signal needs a node to step from.
  const add = (graph: Graph<S>, node: GraphNode<S>): void => {
    if (graph.nodes.length === 0) graphs.push(graph)
    graph.nodes.push(node)
  }
  /**
   * Which node `signal` hangs from in `graph`, or -1 for none.
   *
   * Its own timeframe's last node first, when it supersedes it: that is the timeframe carrying
   * on further, and the line between the two says so. Otherwise the most recent node of a
   * LONGER timeframe it may step from, which is the cross-timeframe step. Only the LAST node
   * of its own timeframe is offered -- an older one it also beats was already superseded, and
   * hanging from that instead would draw a line across the one that replaced it.
   */
  const parentFor = (graph: Graph<S>, signal: S): number => {
    let longer = -1
    let sameSeen = false
    for (let i = graph.nodes.length - 1; i >= 0; i--) {
      const node = graph.nodes[i].signal
      if (node.interval === signal.interval) {
        // Only the last one is offered; an older one it also beats was itself superseded.
        if (!sameSeen && canStep(node, signal, options.maxStep)) return i
        sameSeen = true
        continue
      }
      if (longer < 0 && node.durationMs > signal.durationMs && canStep(node, signal, options.maxStep)) longer = i
    }
    // Nothing of its own timeframe to carry on from: the cross-timeframe step, as ever.
    return longer
  }
  for (const signal of ordered) {
    if (signal.interval === options.root) {
      if (!current || current.side !== signal.side) current = { side: signal.side, nodes: [] }
      // A root signal that supersedes the last one is that graph's root timeframe carrying on,
      // drawn as a step from it; one that does not is another root of the same graph.
      if (!options.taken?.has(signal)) add(current, { signal, parent: parentFor(current, signal) })
      continue
    }
    if (!current || signal.side !== current.side) continue
    const parent = parentFor(current, signal)
    if (parent >= 0) add(current, { signal, parent })
  }
  return graphs
}

/** How many of its own bars back the root is searched for the run in force at the chart's
 * left edge. On EURUSD 8h the rank-85 signal switched side 13 times in 558 bars on dev, so a
 * run is ~45 bars and this finds its start with room to spare; a run longer than this is cut
 * at it. Cheap at every root timeframe, the shortest of which is 1h. */
export const ROOT_LOOKBACK_BARS = 300

/** `ROOT_LOOKBACK_BARS` of `root`, nominally. */
export function rootLookbackMs(root: string): number {
  return ROOT_LOOKBACK_BARS * resolutionDurationMs(root)
}

/** A graph and the root timeframe it grew from. */
export interface RootedGraph<S extends GraphSignal = GraphSignal> extends Graph<S> {
  root: string
}

/**
 * Every root's graphs, each root built on its own: its own signals start and reset its
 * graphs, from its own `graphStart`, over the same pool of signals. Graphs of different roots
 * overlap in time and may run opposite ways. Longest root first, which is also what lets a
 * root see what the longer ones have already taken.
 *
 * A signal that STEPS in a longer root's graph does not also start one of its own (user,
 * 2026-09-21): an 8h signal the 1D graph has already stepped to is that graph's continuation,
 * and rooting an 8h graph at it drew a second graph over the same signal saying the same
 * thing. It still closes the 8h graph in force if it switches side -- see `GraphOptions.taken`.
 * An 8h signal the 1D graph did not take -- the other side, or not far enough -- roots the 8h
 * graphs as before.
 */
export function buildRootGraphs<S extends GraphSignal>(
  signals: readonly S[],
  roots: readonly string[],
  maxStep: number,
  loadedFrom: number
): RootedGraph<S>[] {
  const out: RootedGraph<S>[] = []
  const taken = new Set<GraphSignal>()
  for (const root of [...roots].sort((a, b) => resolutionDurationMs(b) - resolutionDurationMs(a))) {
    const rootSignals = signals.filter((s) => s.interval === root)
    const from = graphStart(rootSignals, loadedFrom, rootLookbackMs(root))
    for (const graph of buildGraphs(signals, { root, maxStep, from, taken })) out.push({ ...graph, root })
    // Steps only: a root node is this root's own, and the roots still to come are all shorter,
    // so it can never be one of their signals anyway.
    for (const graph of out) for (const node of graph.nodes) if (node.parent >= 0) taken.add(node.signal)
  }
  return out
}

/**
 * The instant graphs are built from, for a chart whose loaded bars begin at `loadedFrom`
 * (absolute): the first signal of the run of same-side root signals in force there, looked
 * for no further back than `lookbackMs`. `loadedFrom` itself when no root signal falls in
 * that span -- the first graph then starts at the first root signal on the chart.
 *
 * The bound is what makes it the same answer everywhere it is asked. The plugin sizes its
 * fetches from it and the template builds from it, over a root store that may also hold
 * windows from earlier pans with a gap in between; stopping at the look-back keeps the walk
 * inside the one span the fetch guarantees is contiguous. A run older than the look-back is
 * cut there, and the graph drawn at the loaded left edge is then the part of it that starts
 * inside the span.
 */
export function graphStart(rootSignals: readonly GraphSignal[], loadedFrom: number, lookbackMs: number): number {
  const earliest = loadedFrom - lookbackMs
  const inSpan = rootSignals
    .filter((s) => s.knownAt >= earliest && s.knownAt <= loadedFrom)
    .sort((a, b) => a.knownAt - b.knownAt)
  if (inSpan.length === 0) return loadedFrom
  let first = inSpan.length - 1
  while (first > 0 && inSpan[first - 1].side === inSpan[first].side) first--
  return inSpan[first].knownAt
}

/** What a store must offer for its signals to be read into a graph (a `RegistryStore` does). */
export interface GraphSourceStore {
  values: Map<number, ArevPoint>
  grid(): number[]
  gridBody(date: number): GridBody | undefined
}

/** One timeframe's knowable signals as graph signals, priced at their source candles' bodies.
 * A signal whose candle's body is not held is left out rather than guessed. */
export function storeGraphSignals(interval: string, store: GraphSourceStore): GraphSignal[] {
  const durationMs = resolutionDurationMs(interval)
  const out: GraphSignal[] = []
  for (const signal of knowableSignals(interval, store.values.values(), store.grid())) {
    const body = store.gridBody(signal.sourceDate)
    if (!body) continue
    out.push({
      interval,
      durationMs,
      knownAt: signal.knownAt,
      sourceDate: signal.sourceDate,
      side: signal.up ? 'top' : 'bottom',
      price: signal.up ? body.top : body.bottom
    })
  }
  return out
}
