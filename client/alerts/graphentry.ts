// A MULTI-TIMEFRAME OVERLAY'S GRAPH ENTRIES, headless: which bars of a timeframe carry a signal
// the overlay draws as an entry STAR -- a 5m-or-shorter signal stepped to, through the graph,
// from a root.
//
// Nothing here decides what a graph is, and since wdashboard-server 0.56.0 nothing here builds
// one either: the overlay's graph is the server's (`GET /mtf/graph`, services/mtfgraph.py), and an
// alert asks for exactly what a pane asks for -- the overlay's own signal family and params, the
// timeframes, the roots and the largest step -- and keeps the entries on its timeframe. So an
// alert stars the bars the chart stars by construction. What the alert keeps of its own is only
// the SETTINGS, copied from a pane when it was written.
//
// The server builds every graph whole, from the first signal of its root's run, so the answer
// for any instant is the same however far back a window starts: the chart's left edge and the
// alert's first evaluated instant no longer have to agree.
//
// One difference from a pane is deliberate: a pane draws no timeframe finer than its chart, so
// a 15m chart has no 5m stars at all. An alert builds from every timeframe it was given, which
// is the graph a chart fine enough to show them all would draw.

import { isMtfInterval, MTF_INTERVALS, type MtfGraphAnswer, type MtfGraphRequest, type MtfNodeRow } from '../mtf/api'
import { enabledIntervals, graphConfig, graphRoots, type MtfConfig } from '../mtf/config'
import { MTF_OVERLAYS, type MtfOverlay } from '../mtf/overlays'
import { resolutionDurationMs } from '../periods'
import type { CandleGrid } from '../replay/timeframes'
import type { Point } from './data'
import type { Operand } from './types'

/** The longest timeframe an entry may be cast on (the server's `ENTRY_MAX_INTERVAL`). */
export const ENTRY_MAX_INTERVAL = '5m'

/** The most pages one read follows: a runaway `nextFrom` must not turn one alert into a crawl. */
const MAX_PAGES = 200

/** The overlays whose graph an alert can read. */
export function graphOverlays(): MtfOverlay[] {
  return MTF_OVERLAYS.filter((overlay) => overlay.graph === true)
}

export type GraphOperand = Extract<Operand, { kind: 'graph' }>

/** What the engine reads. `HttpAlertData` is one. */
export interface GraphData {
  grid(symbol: string): Promise<CandleGrid | null>
  /** One page of the server's graph answer, past any replay clock. */
  graph(request: MtfGraphRequest): Promise<MtfGraphAnswer>
}

export interface GraphEntries {
  /** One per entry on the operand's timeframe: the bar's wire date and the graph's side. */
  points: Point[]
  /** The newest wire date on the operand's timeframe whose answer is final: every timeframe
   * the graph reads has been computed past the instant that bar's signal became knowable. A bar
   * after it may still gain an entry. Null when nothing is final. */
  through: number | null
}

/** One graph's entries as far as the server has answered them FINALLY: every entry node knowable
 * in `[lo, hi)`, sorted by `knownAt`. `hi` never passes the server's `computedThrough`, so a span
 * held here cannot change under it, and a later read asks only for what lies past it. */
interface HeldGraph {
  lo: number
  hi: number
  nodes: MtfNodeRow[]
  /** The server's `computedThrough` at the last read, absolute. */
  computedThrough: number | null
  /** Reads of this graph run one at a time, so a second operand on the same settings -- the 3m
   * and the 5m star of one alert -- waits for the first and finds the span held. */
  queue: Promise<unknown>
}

/** Entry nodes held per graph before the oldest are dropped: entries are a few a day, so this is
 * years of them. */
const MAX_HELD_NODES = 50_000

export class GraphEntryEngine {
  private readonly held = new Map<string, HeldGraph>()

  constructor(private readonly data: GraphData) {}

  /** Forget every held graph (the instrument changed). */
  reset(): void {
    this.held.clear()
  }

  /**
   * The operand's entries for the window `[from, to)` (absolute instants: what became knowable
   * in it). `fresh` is accepted for the live monitor's sake and changes nothing: what is held is
   * only what the server had already answered as final, and everything past that is read again.
   *
   * One graph -- the same settings -- is read ONCE for every operand on it and every window over
   * it: a span already held is not asked for again, so a search walking forward a chunk at a
   * time, or an alert reading the 3m and the 5m stars of one graph, asks the server only for
   * the instants it has not answered yet.
   */
  async entries(symbol: string, operand: GraphOperand, from: number, to: number, _fresh = false): Promise<GraphEntries> {
    const overlay = graphOverlays().find((o) => o.id === operand.overlay)
    const clock = await this.data.grid(symbol)
    if (!overlay || !clock || to <= from) return { points: [], through: null }
    const timeframes = operand.timeframes.filter(isMtfInterval)
    const roots = operand.roots.filter((root) => (timeframes as string[]).includes(root))
    if (!(timeframes as string[]).includes(operand.interval) || roots.length === 0) return { points: [], through: null }

    const request: Omit<MtfGraphRequest, 'from' | 'to'> = {
      symbol,
      source: overlay.source,
      params: overlay.params,
      timeframes,
      roots,
      maxStep: Math.max(2, operand.maxStep),
      asof: null
    }
    const key = JSON.stringify(request)
    let held = this.held.get(key)
    if (!held) {
      held = { lo: from, hi: from, nodes: [], computedThrough: null, queue: Promise.resolve() }
      this.held.set(key, held)
    }
    const graph = held
    const read = graph.queue.then(() => this.read(graph, request, from, to))
    graph.queue = read.catch(() => {})
    const { nodes, computedThrough } = await read

    const points: Point[] = []
    const seen = new Set<number>()
    for (const node of nodes) {
      // A signal that is an entry of several roots' graphs is one entry.
      if (node.interval !== operand.interval || seen.has(node.date)) continue
      seen.add(node.date)
      points.push({ date: node.date, signal: node.side })
    }
    points.sort((a, b) => a.date - b.date)
    // Final no further than this read reached: past `to` nothing was asked for, whatever the
    // server has computed there.
    const answered = computedThrough === null ? null : Math.min(computedThrough, to - 1)
    return { points, through: finalThrough(operand.interval, answered, clock) }
  }

  /** The entry nodes knowable in `[from, to)`, reading from the server only what is not held. */
  private async read(
    graph: HeldGraph,
    request: Omit<MtfGraphRequest, 'from' | 'to'>,
    from: number,
    to: number
  ): Promise<{ nodes: MtfNodeRow[]; computedThrough: number | null }> {
    // A window that does not touch the held span replaces it: two spans with a hole between
    // would read as one with nothing in the hole.
    if (from < graph.lo || from > graph.hi) {
      graph.lo = from
      graph.hi = from
      graph.nodes = []
    }
    let tail: MtfNodeRow[] = []
    if (to > graph.hi) {
      // Read on past `to` by the window's own length: a search moving forward a few bars at a
      // time then finds the next window held instead of asking for each few bars.
      const fetched = await this.fetch(request, graph.hi, to + (to - from))
      graph.computedThrough = fetched.computedThrough
      tail = fetched.nodes
      // Keep only what was final when it was answered; the rest is read again next time.
      const finalTo = fetched.computedThrough === null ? graph.hi : Math.min(to + (to - from), Math.max(graph.hi, fetched.computedThrough + 1))
      graph.nodes.push(...tail.filter((n) => n.knownAt < finalTo))
      graph.hi = finalTo
      if (graph.nodes.length > MAX_HELD_NODES) {
        const drop = graph.nodes.length - MAX_HELD_NODES
        graph.lo = graph.nodes[drop].knownAt
        graph.nodes = graph.nodes.slice(drop)
      }
    }
    const nodes = graph.nodes.filter((n) => n.knownAt >= from && n.knownAt < to)
    // What was read past the final edge is this answer's, though not kept.
    for (const n of tail) if (n.knownAt >= graph.hi && n.knownAt < to) nodes.push(n)
    return { nodes, computedThrough: graph.computedThrough }
  }

  /** Every entry node knowable in `[from, to)`, following the server's pages. */
  private async fetch(
    request: Omit<MtfGraphRequest, 'from' | 'to'>,
    from: number,
    to: number
  ): Promise<{ nodes: MtfNodeRow[]; computedThrough: number | null }> {
    const nodes: MtfNodeRow[] = []
    let computedThrough: number | null = null
    let cursor = from
    for (let page = 0; cursor < to && page < MAX_PAGES; page++) {
      const answer = await this.data.graph({ ...request, from: cursor, to })
      computedThrough = answer.computedThrough
      for (const node of answer.nodes) if (node.entry) nodes.push(node)
      if (answer.nextFrom === null || answer.nextFrom <= cursor) break
      cursor = answer.nextFrom
    }
    nodes.sort((a, b) => a.knownAt - b.knownAt)
    return { nodes, computedThrough }
  }
}

/** The newest wire date on `interval` whose bar closed by `computedThrough` (absolute,
 * inclusive): a signal on it is knowable at that close, which is final. Null when nothing is. */
export function finalThrough(interval: string, computedThrough: number | null, clock: CandleGrid): number | null {
  if (computedThrough === null) return null
  let open = clock.start(interval, computedThrough)
  if (clock.end(interval, open) > computedThrough) open = clock.start(interval, open - 1)
  if (clock.end(interval, open) > computedThrough) return null
  return clock.toWire(interval, open)
}

/** The graph settings an alert keeps, and where they came from (for the editor to say). */
export interface GraphSettings {
  timeframes: string[]
  roots: string[]
  maxStep: number
  /** "pane 2", or "overlay defaults". */
  from: string
}

/** A pane's overlay settings as an alert keeps them: the timeframes it has switched on, the
 * roots among them, and the largest step. */
export function graphSettingsOf(config: MtfConfig | undefined, from: string): GraphSettings {
  const timeframes: string[] = enabledIntervals(config)
  return {
    timeframes,
    roots: graphRoots(config).filter((root) => timeframes.includes(root)),
    maxStep: graphConfig(config).maxStep,
    from
  }
}

/** What a graph entry starts from when no pane carries the overlay: EVERY timeframe on, rooted
 * at 1D (the overlay's default root), the default step. Not the overlay's own defaults, which
 * switch on 1h and longer only -- a graph that cannot step below 1h has no entry to find. */
export function defaultGraphSettings(): GraphSettings {
  return {
    timeframes: [...MTF_INTERVALS],
    roots: graphRoots(undefined).length > 0 ? graphRoots(undefined) : ['1D'],
    maxStep: graphConfig(undefined).maxStep,
    from: 'defaults: every timeframe, rooted at 1D'
  }
}

/** The timeframes a graph entry can be on: the overlay's timeframes no longer than an entry's. */
export function entryIntervals(): string[] {
  return MTF_INTERVALS.filter((interval) => resolutionDurationMs(interval) <= resolutionDurationMs(ENTRY_MAX_INTERVAL))
}
