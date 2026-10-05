// A MULTI-TIMEFRAME OVERLAY'S GRAPH ENTRIES, headless: which bars of a timeframe carry a signal
// the overlay would draw as an entry STAR (client/mtf/graph.ts `isEntry` -- a 5m-or-shorter
// signal stepped to, through the graph, from a root).
//
// Nothing here decides what a graph is. The signals are the overlay's own fetch
// (`MtfOverlay.fetchPoints`, the rank-85 params and all), priced at their candles' bodies and
// placed at the instant they became knowable by the overlay's own `storeGraphSignals`, and the
// graphs are its own `buildRootGraphs` -- so an alert stars the bars the chart stars. What the
// alert keeps of its own is only the SETTINGS (timeframes, roots, largest step), copied from a
// pane when it was written, and the window: the overlay builds from the chart's loaded left
// edge, an alert from the first instant it evaluates. For every instant after that edge the
// answer is the same either way -- the graph in force at an instant began at a root signal no
// later than it, inside the root's lookback (`graphStart`).
//
// One difference from a pane is deliberate: a pane draws no timeframe finer than its chart, so
// a 15m chart has no 5m stars at all. An alert builds from every timeframe it was given, which
// is the graph a chart fine enough to show them all would draw.

import type { ArevPoint } from '../arev/api'
import { isMtfInterval, MTF_INTERVALS } from '../mtf/api'
import { enabledIntervals, graphConfig, graphRoots, type MtfConfig } from '../mtf/config'
import { buildRootGraphs, ENTRY_MAX_INTERVAL, type GraphSourceStore, graphStart, isEntry, rootLookbackMs, storeGraphSignals } from '../mtf/graph'
import { MTF_OVERLAYS, type MtfOverlay } from '../mtf/overlays'
import { resolutionDurationMs } from '../periods'
import type { CandleGrid } from '../replay/timeframes'
import type { GridBody } from '../tsregistry/store'
import type { AlertBar } from './compute'
import type { Point } from './data'
import type { Operand } from './types'

/** A timeframe below a root reaches back at most this many of its own bars for the graph in
 * force -- the overlay's own bound (mtf/plugin.ts `GRAPH_LOOKBACK_MAX_BARS`). */
const GRAPH_LOOKBACK_MAX_BARS = 10_000

/** Fetched behind every window: a vote cast just before it is knowable inside it. */
const BACK_PAD_MS = 4 * 86_400_000

/** How much of a timeframe's tail a fresh read (the live monitor) reads again: a late vote, or
 * a bar that was still forming at the last read, lands there. */
const TAIL_BARS = 4

/** The overlays whose graph an alert can read. */
export function graphOverlays(): MtfOverlay[] {
  return MTF_OVERLAYS.filter((overlay) => overlay.graph === true)
}

export type GraphOperand = Extract<Operand, { kind: 'graph' }>

/** What the engine reads. `HttpAlertData` is one. */
export interface GraphData {
  grid(symbol: string): Promise<CandleGrid | null>
  /** Bars of `interval` opening in `[from, to)` (store clock). */
  bars(symbol: string, interval: string, from: number, to: number): Promise<AlertBar[]>
  /** An overlay's votes on `interval` dated in `[from, to)` (wire dates). */
  votes(overlay: MtfOverlay, symbol: string, interval: string, from: number, to: number): Promise<ArevPoint[]>
}

export interface GraphEntries {
  /** One per entry on the operand's timeframe: the bar's wire date and the graph's side. */
  points: Point[]
  /** The newest wire date on the operand's timeframe whose answer is final: every timeframe
   * the graph reads has been served past the instant that bar's signal became knowable. A bar
   * after it may still gain an entry. Null when nothing is final. */
  through: number | null
}

/** One timeframe's votes and candle bodies, as a `GraphSourceStore`. */
class TimeframeData implements GraphSourceStore {
  values = new Map<number, ArevPoint>()
  private bodies = new Map<number, GridBody | null>()
  private sorted: number[] | null = null
  private lo: number | null = null
  private hi: number | null = null

  constructor(
    private readonly read: (from: number, to: number) => Promise<{ bars: AlertBar[]; votes: ArevPoint[] }>,
    private readonly interval: string
  ) {}

  grid(): number[] {
    this.sorted ??= [...this.bodies.keys()].sort((a, b) => a - b)
    return this.sorted
  }

  gridBody(date: number): GridBody | undefined {
    return this.bodies.get(date) ?? undefined
  }

  /** The newest vote's date, or null. */
  newestVote(): number | null {
    let out: number | null = null
    for (const date of this.values.keys()) if (out === null || date > out) out = date
    return out
  }

  /** Hold `[from, to)` (store clock). `fresh` reads the held tail again as well. */
  async ensure(from: number, to: number, fresh: boolean): Promise<void> {
    if (this.lo === null || this.hi === null || to < this.lo || from > this.hi) {
      await this.fill(from, to)
      this.lo = from
      this.hi = to
      return
    }
    if (from < this.lo) {
      await this.fill(from, this.lo)
      this.lo = from
    }
    const tail = fresh ? Math.max(this.lo, this.hi - TAIL_BARS * resolutionDurationMs(this.interval)) : this.hi
    if (to > tail) {
      await this.fill(tail, to)
      this.hi = Math.max(this.hi, to)
    }
  }

  private async fill(from: number, to: number): Promise<void> {
    if (to <= from) return
    const { bars, votes } = await this.read(from, to)
    for (const bar of bars) {
      this.bodies.set(bar.date, { top: Math.max(bar.o, bar.c), bottom: Math.min(bar.o, bar.c) })
    }
    for (const vote of votes) this.values.set(vote.date, vote)
    this.sorted = null
  }
}

export class GraphEntryEngine {
  private readonly held = new Map<string, TimeframeData>()

  constructor(private readonly data: GraphData) {}

  /** Forget everything read. */
  reset(): void {
    this.held.clear()
  }

  /**
   * The operand's entries for a window starting at `from` (absolute; the first instant an
   * entry is wanted), reading every timeframe up to `to`. `fresh` re-reads each timeframe's
   * tail -- what the live monitor needs, and a search over history does not.
   */
  async entries(symbol: string, operand: GraphOperand, from: number, to: number, fresh = false): Promise<GraphEntries> {
    const overlay = graphOverlays().find((o) => o.id === operand.overlay)
    const clock = await this.data.grid(symbol)
    if (!overlay || !clock) return { points: [], through: null }
    const timeframes: string[] = operand.timeframes.filter(isMtfInterval)
    const roots = operand.roots.filter((root) => timeframes.includes(root))
    if (!timeframes.includes(operand.interval) || roots.length === 0) return { points: [], through: null }

    // Roots first: each looks back a fixed number of its own bars for the run in force at
    // `from`, and where the earliest of those runs began is how far back the rest must read.
    for (const root of roots) await this.store(overlay, symbol, root, clock).ensure(from - rootLookbackMs(root) - BACK_PAD_MS, to, fresh)
    let start = from
    for (const root of roots) {
      const signals = storeGraphSignals(root, this.store(overlay, symbol, root, clock), clock)
      start = Math.min(start, graphStart(signals, from, rootLookbackMs(root)))
    }
    for (const interval of timeframes) {
      if (roots.includes(interval)) continue
      const length = resolutionDurationMs(interval)
      const reach = Math.max(start, from - GRAPH_LOOKBACK_MAX_BARS * length)
      await this.store(overlay, symbol, interval, clock).ensure(reach - BACK_PAD_MS, to, fresh)
    }

    const signals = timeframes.flatMap((interval) => storeGraphSignals(interval, this.store(overlay, symbol, interval, clock), clock))
    const graphs = buildRootGraphs(signals, roots, operand.maxStep, from)
    const points: Point[] = []
    for (const graph of graphs) {
      for (const node of graph.nodes) {
        if (node.signal.interval === operand.interval && isEntry(node)) points.push({ date: node.signal.sourceDate, signal: graph.side })
      }
    }
    return { points, through: this.through(overlay, symbol, operand.interval, timeframes, clock) }
  }

  /** The newest date on `interval` that every timeframe has been served past (`GraphEntries`). */
  private through(overlay: MtfOverlay, symbol: string, interval: string, timeframes: readonly string[], clock: CandleGrid): number | null {
    // A timeframe whose newest vote is on bar B can produce no later signal knowable before the
    // close of the bar after B: up to there, what it has said is all it will say.
    //
    // A timeframe the server has served NOTHING for over the whole window is skipped: it puts no
    // signal in the graph (the chart draws without it too), and waiting on it would make
    // nothing final ever -- dev computes no arev21 on 3m or 2h at all.
    let served = Number.POSITIVE_INFINITY
    for (const tf of timeframes) {
      const newest = this.store(overlay, symbol, tf, clock).newestVote()
      if (newest === null) continue
      const open = clock.fromWire(tf, newest)
      served = Math.min(served, clock.end(tf, clock.nextStart(tf, open)) - 1)
    }
    if (served === Number.POSITIVE_INFINITY) return null
    let out: number | null = null
    for (const date of this.store(overlay, symbol, interval, clock).grid()) {
      if (clock.end(interval, clock.fromWire(interval, date)) <= served) out = date
    }
    return out
  }

  private store(overlay: MtfOverlay, symbol: string, interval: string, clock: CandleGrid): TimeframeData {
    const key = `${overlay.id}|${symbol}|${interval}`
    let held = this.held.get(key)
    if (!held) {
      held = new TimeframeData(async (from, to) => {
        const [bars, votes] = await Promise.all([
          this.data.bars(symbol, interval, from, to),
          this.data.votes(overlay, symbol, interval, clock.toWire(interval, from), clock.toWire(interval, to))
        ])
        return { bars, votes }
      }, interval)
      this.held.set(key, held)
    }
    return held
  }
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
