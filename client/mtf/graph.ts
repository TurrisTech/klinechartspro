import type { ArevPoint } from '../arev/api'
import { resolutionDurationMs } from '../periods'
import type { GridExtremes } from '../tsregistry/store'
import { knowableSignals } from './shift'

// The signal GRAPH a multi-timeframe overlay can draw over its markers (user, 2026-09-21):
// from a higher timeframe's signal down to lower timeframes' signals that went further the
// same way, so each graph climbs to the top right (top signals) or falls to the bottom right
// (bottom signals).
//
// The rules, as the user gave them, and what each became here:
//
//   * a graph starts from a signal on the ROOT timeframe (1D, 8h, 4h, 2h or 1h);
//   * when the root timeframe's signal switches SIDE the graph resets: the root's first signal
//     of the other side starts a new graph, and nothing joins the old one after that instant.
//     A further root signal of the SAME side joins the current graph as another root;
//   * a top signal is joined to a later top signal on a LOWER timeframe that is HIGHER, a
//     bottom signal to a later bottom one that is LOWER -- and the same again from there, so a
//     path steps down the timeframes while the price keeps going the graph's way;
//   * a step may skip a timeframe but not too many: "8h -> 1h -> 15m -> 5m is reasonable,
//     8h -> 3m is not". That is `maxStep`, the most a step may shrink the timeframe by, as a
//     ratio of nominal lengths -- 8 by default, which is exactly 8h -> 1h. A ratio rather than
//     a count of skipped timeframes, because the ladder has uneven rungs (20m and 2h sit
//     between the original eight) and because which timeframes a pane has switched on must
//     not change what counts as a skip.
//
// Three choices the rules leave open, made here:
//
//   * A signal's HEIGHT is the high (top) or low (bottom) of the bar it was cast on. That is
//     the price at which `p` entered its zone, and it is fully known by the instant the
//     signal is -- the source bar's close, where its marker sits. The bar the marker is drawn
//     on would be the other candidate, and it is lookahead: its high is still forming when the
//     signal arrives. It would also make the graph depend on the chart's interval.
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
  side: GraphSide
  /** The high of the bar it was cast on for a top signal, the low for a bottom one. */
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
}

/** Whether `child` may hang from `parent`: strictly lower timeframe, by no more than
 * `maxStep`, strictly later, and strictly further the graph's way. */
export function canStep(parent: GraphSignal, child: GraphSignal, maxStep: number): boolean {
  if (child.side !== parent.side) return false
  if (!(parent.durationMs > child.durationMs)) return false
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
  for (const signal of ordered) {
    if (signal.interval === options.root) {
      if (!current || current.side !== signal.side) {
        current = { side: signal.side, nodes: [] }
        graphs.push(current)
      }
      current.nodes.push({ signal, parent: -1 })
      continue
    }
    if (!current || signal.side !== current.side) continue
    // The most recent node it may step from. Nodes are appended in the walk's order, so
    // scanning back finds the latest-known one first.
    for (let i = current.nodes.length - 1; i >= 0; i--) {
      if (canStep(current.nodes[i].signal, signal, options.maxStep)) {
        current.nodes.push({ signal, parent: i })
        break
      }
    }
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
  gridExtremes(date: number): GridExtremes | undefined
}

/** One timeframe's knowable signals as graph signals, priced at their source bars. A signal
 * whose bar's range is not held is left out rather than guessed. */
export function storeGraphSignals(interval: string, store: GraphSourceStore): GraphSignal[] {
  const durationMs = resolutionDurationMs(interval)
  const out: GraphSignal[] = []
  for (const signal of knowableSignals(interval, store.values.values(), store.grid())) {
    const extremes = store.gridExtremes(signal.sourceDate)
    if (!extremes) continue
    out.push({
      interval,
      durationMs,
      knownAt: signal.knownAt,
      side: signal.up ? 'top' : 'bottom',
      price: signal.up ? extremes.high : extremes.low
    })
  }
  return out
}
