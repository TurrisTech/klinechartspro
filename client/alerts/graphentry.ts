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

import { isMtfInterval, MTF_INTERVALS, type MtfGraphAnswer, type MtfGraphRequest } from '../mtf/api'
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

export class GraphEntryEngine {
  constructor(private readonly data: GraphData) {}

  /** Nothing is held here -- the server keeps the answer, and a repeat costs a revalidation. */
  reset(): void {}

  /**
   * The operand's entries for the window `[from, to)` (absolute instants: what became knowable
   * in it). `fresh` is accepted for the live monitor's sake and changes nothing: every read is
   * the server's current answer.
   */
  async entries(symbol: string, operand: GraphOperand, from: number, to: number, _fresh = false): Promise<GraphEntries> {
    const overlay = graphOverlays().find((o) => o.id === operand.overlay)
    const clock = await this.data.grid(symbol)
    if (!overlay || !clock || to <= from) return { points: [], through: null }
    const timeframes = operand.timeframes.filter(isMtfInterval)
    const roots = operand.roots.filter((root) => (timeframes as string[]).includes(root))
    if (!(timeframes as string[]).includes(operand.interval) || roots.length === 0) return { points: [], through: null }

    const points: Point[] = []
    const seen = new Set<number>()
    let computedThrough: number | null = null
    let cursor = from
    for (let page = 0; cursor < to && page < MAX_PAGES; page++) {
      const answer = await this.data.graph({
        symbol,
        source: overlay.source,
        params: overlay.params,
        timeframes,
        roots,
        maxStep: Math.max(2, operand.maxStep),
        from: cursor,
        to,
        asof: null
      })
      computedThrough = answer.computedThrough
      // A signal that is an entry of several roots' graphs is one entry.
      for (const node of answer.nodes) {
        if (node.interval !== operand.interval || !node.entry || seen.has(node.date)) continue
        seen.add(node.date)
        points.push({ date: node.date, signal: node.side })
      }
      if (answer.nextFrom === null || answer.nextFrom <= cursor) break
      cursor = answer.nextFrom
    }
    points.sort((a, b) => a.date - b.date)
    // Final no further than this read reached: past `to` nothing was asked for, whatever the
    // server has computed there.
    const answered = computedThrough === null ? null : Math.min(computedThrough, to - 1)
    return { points, through: finalThrough(operand.interval, answered, clock) }
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
