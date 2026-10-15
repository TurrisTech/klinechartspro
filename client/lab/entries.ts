// WHICH SIGNALS ARE ENTRIES, and which way each trades.
//
//   graph on    the nodes that passed the entry test as they joined their graph (graph.ts),
//               once per signal however many graphs it is in
//   graph off   every event of the pool that passes the entry test, read with no graph -- a
//               node then has no parent and is its own root
//
// then the FILTER -- an alert rule (client/alerts) read at the entry instant, each operand on its
// own timeframe at its latest bar CLOSED by then -- and the direction each side trades.
//
// PURE but for the filter's indicators, which klinecharts' templates compute.

import { buildTrack, type PointIndex } from '../alerts/compute'
import { evaluate } from '../alerts/conditions'
import { compile } from '../alerts/rules'
import { observe, type Track, type Value } from '../alerts/timeline'
import type { Operand, Rule } from '../alerts/types'
import type { ReplayBar } from '../replay/cache'
import { compileExpr } from './expr'
import { graphEntries, type GraphState, type LabGraph, type LabSignal, type Readings, slotEnv } from './graph'
import { type Direction, type EntrySpec, SCOPES, type Side, type SlotCondition } from './model'

export interface LabEntry {
  /** The signal's key: one entry per signal. */
  id: string
  signal: LabSignal
  /** When it can be taken: the signal's close. */
  at: number
  side: Side
  direction: Direction
  /** The graph it was found in and its node index, or null / -1 without a graph. */
  graph: LabGraph | null
  node: number
}

/** The graph as it stood when node `index` joined: what `graph.*` read then. */
export function graphStateAt(graph: LabGraph, index: number): GraphState {
  let extreme: number | null = null
  let entries = 0
  for (let i = 0; i < index; i++) {
    const n = graph.nodes[i]
    if (extreme === null || (graph.side === 'top' ? n.signal.price > extreme : n.signal.price < extreme)) extreme = n.signal.price
    if (n.entry) entries++
  }
  return { side: graph.side, extreme, nodes: index, entries, startedAt: graph.nodes[0]?.signal.knownAt ?? null }
}

/** The root a node hangs from. */
export function rootIndex(graph: LabGraph, index: number): number {
  let i = index
  while (i >= 0 && graph.nodes[i].parent >= 0) i = graph.nodes[i].parent
  return i
}

/** The entries of a graph run. */
export function entriesOfGraphs(graphs: readonly LabGraph[], direction: Record<Side, Direction>): LabEntry[] {
  return graphEntries(graphs).map(({ graph, node, index }) => ({
    id: node.signal.key,
    signal: node.signal,
    at: node.signal.knownAt,
    side: graph.side,
    direction: direction[graph.side],
    graph,
    node: index
  }))
}

/** The entries of a run with the graph off: the events passing the test. */
export function entriesOfEvents(events: readonly LabSignal[], when: readonly SlotCondition[], direction: Record<Side, Direction>, readings: Readings): LabEntry[] {
  const tests = when.filter((c) => c.enabled).map((c) => compileExpr(c.expr, SCOPES.entry))
  const out: LabEntry[] = []
  const seen = new Set<string>()
  for (const signal of [...events].sort((a, b) => a.knownAt - b.knownAt)) {
    if (seen.has(signal.key)) continue
    const self = { signal, depth: 0, isRoot: true }
    const env = slotEnv({
      nodes: { node: self, parent: null, root: self },
      graph: null,
      subject: { interval: signal.interval, at: signal.knownAt },
      readings,
      side: signal.side
    })
    if (!tests.every((t) => t.holds(env))) continue
    seen.add(signal.key)
    out.push({ id: signal.key, signal, at: signal.knownAt, side: signal.side, direction: direction[signal.side], graph: null, node: -1 })
  }
  return out
}

// -- the filter ---------------------------------------------------------------------------------

/** An alert rule read at arbitrary instants: each operand at its own timeframe's latest close. */
export class RuleAtInstant {
  private constructor(
    private readonly condition: ReturnType<typeof compile>['condition'],
    private readonly fields: ReturnType<typeof compile>['fields'],
    private readonly tracks: Track[],
    /** Every close of every track, ascending: where "the instant before" is. */
    private readonly closes: number[]
  ) {}

  static async build(rule: Rule, bars: (interval: string) => readonly ReplayBar[], points: (operand: Operand) => PointIndex | undefined): Promise<RuleAtInstant> {
    const compiled = compile(rule)
    const operands = [...compiled.operands.values()]
    const intervals = [...new Set(operands.map((o) => o.interval))]
    const tracks = await Promise.all(intervals.map((iv) => buildTrack(iv, bars(iv), operands, points)))
    const closes = [...new Set(tracks.flatMap((t) => [...t.at]))].sort((a, b) => a - b)
    return new RuleAtInstant(compiled.condition, compiled.fields, tracks, closes)
  }

  /** The operands the rule reads, for the runner to fetch. */
  static operands(rule: Rule): Operand[] {
    return [...compile(rule).operands.values()]
  }

  private observationAt(t: number) {
    const reading = new Map<string, Value>()
    for (const track of this.tracks) {
      let lo = 0
      let hi = track.at.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (track.at[mid] <= t) lo = mid + 1
        else hi = mid
      }
      const p = lo - 1
      for (const [key, values] of track.values) reading.set(key, p >= 0 ? values[p] : undefined)
    }
    return observe(this.fields, reading)
  }

  /** Whether the rule holds at `t`: true only when it is knowably true. A crossing compares `t`
   * with the latest close of any timeframe the rule reads before it. */
  holdsAt(t: number): boolean {
    let lo = 0
    let hi = this.closes.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.closes[mid] < t) lo = mid + 1
      else hi = mid
    }
    const before = lo > 0 ? this.observationAt(this.closes[lo - 1]) : null
    return evaluate(this.condition, this.observationAt(t), before) === true
  }
}

export function applyFilter(entries: readonly LabEntry[], filter: RuleAtInstant | null): { kept: LabEntry[]; filtered: LabEntry[] } {
  if (!filter) return { kept: [...entries], filtered: [] }
  const kept: LabEntry[] = []
  const filtered: LabEntry[] = []
  for (const entry of entries) (filter.holdsAt(entry.at) ? kept : filtered).push(entry)
  return { kept, filtered }
}

export type { EntrySpec }
