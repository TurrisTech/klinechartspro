// THE SIGNAL GRAPH, WITH EVERY RULE A SLOT. A port of the AREV21 outlier rank 85 overlay's graph
// (client/mtf/graph.ts `buildGraphs` / `buildRootGraphs`) in which each rule that file hard-codes
// is read from the strategy (model.ts `GraphSpec`) instead:
//
//   overlay (graph.ts)                                  here
//   ------------------------------------------------    ---------------------------------------
//   roots 1D/8h/4h/2h/1h, each built on its own          `roots`, `rootSources`
//   a root signal of the other side starts a new graph   fixed -- it is what a graph IS
//   a same-side root joins as another root               `rootJoin`: join / new / ignore
//   a step in a longer root's graph roots nothing        `takenDontRoot`
//   canStep: same side, strictly later                   fixed -- the no-lookahead rule
//   canStep: further, lower timeframe, maxStep           `step`: conditions in the expression language
//   one parent: own timeframe's last, else longer        `parent`: supersede / recent / nearest / root
//   a graph only ever goes further (reach)               `reach`
//   --                                                   `end`: after N root bars, or a condition
//   isEntry: a step on 5m or shorter                     model.ts `EntrySpec.when`, read as a node joins
//
// With every slot at its default (model.ts `rank85Strategy`) this builds exactly the graphs the
// overlay builds from the same signals -- `graph.test.ts` runs the two side by side on generated
// signal sets. Everything else about the walk is the overlay's: signals in the order they became
// knowable, at one instant root signals first and then longer timeframes first, so a graph drawn
// over history is the graph a reader would have watched grow.
//
// PURE: signals and readings in, graphs out. What an `atr()` or `ind()` call reads comes from the
// runner (`Readings`).

import { resolutionDurationMs } from '../periods'
import { type Compiled, compileExpr, type ExprEnv, type ExprValue } from './expr'
import { type GraphSpec, SCOPES, type Side, type SlotCondition } from './model'

/** One signal of the pool, as the graph and the entries read it. A `GraphSignal`
 * (client/mtf/graph.ts) by shape, so the overlay's builder accepts it too. */
export interface LabSignal {
  /** `source|interval|sourceDate`: unique in a run. */
  key: string
  source: string
  interval: string
  /** The timeframe's nominal length: what orders timeframes. */
  durationMs: number
  /** The instant it became knowable: its candle's close, absolute. */
  knownAt: number
  /** The wire date of the candle it was cast on. */
  sourceDate: number
  side: Side
  price: number
  /** The candle it was cast on. */
  bar: { o: number; h: number; l: number; c: number }
  /** The label it carried (`long`, `top`). */
  label: string
  /** Everything else the source wrote on it (arev's `p`, `n`...). */
  raw: Record<string, unknown>
}

export interface LabNode {
  signal: LabSignal
  /** Index of its parent in the graph's `nodes`, or -1 for a root. */
  parent: number
  depth: number
  /** Whether it passed the entry test when it joined. */
  entry: boolean
}

export type EndReason = 'expired' | 'condition'

export interface LabGraph {
  /** The root timeframe it grew from. */
  root: string
  side: Side
  nodes: LabNode[]
  /** When it stopped taking nodes, if a strategy end rule closed it (a side switch is not
   * recorded: the graph simply has no later nodes). */
  endedAt: number | null
  endReason: EndReason | null
}

/** What `atr()` and `ind()` read, at an instant: the latest bar of the interval closed by then. */
export interface Readings {
  pip: number
  atr(period: number, interval: string, at: number): number | undefined
  ind(name: string, output: string, interval: string, params: number[], at: number): number | undefined
}

/** One closed bar of the timeframe an end rule watches. */
export interface WatchBar {
  /** Its close (absolute). */
  end: number
  o: number
  h: number
  l: number
  c: number
}

export interface GraphInput {
  signals: readonly LabSignal[]
  spec: GraphSpec
  /** The entry test, read as each node joins. Empty: no node is an entry. */
  entry: readonly SlotCondition[]
  /** The first instant graphs are wanted at (absolute); each root reads back from there. */
  from: number
  readings: Readings
  /** Root-timeframe bar closes, ascending, for `end.rootBars`. */
  rootCloses?: (root: string) => readonly number[]
  /** The watched timeframe's closed bars, ascending, for `end.when`. */
  watchBars?: readonly WatchBar[]
  /** The watched timeframe's code (what `atr()` defaults to in an end rule). */
  watchInterval?: string
}

// -- compiled slots ----------------------------------------------------------------------------

export interface CompiledGraph {
  step: Compiled[]
  entry: Compiled[]
  end: Compiled | null
}

/** The slots compiled once per run. Throws `ExprError` on the first one that does not compile
 * (model.ts `strategyProblems` reports them all, before a run). */
export function compileGraph(spec: GraphSpec, entry: readonly SlotCondition[]): CompiledGraph {
  const on = (conditions: readonly SlotCondition[], scope: typeof SCOPES.step | typeof SCOPES.entry): Compiled[] =>
    conditions.filter((c) => c.enabled).map((c) => compileExpr(c.expr, scope))
  return {
    step: on(spec.step, SCOPES.step),
    entry: on(entry, SCOPES.entry),
    end: spec.end.when.trim() ? compileExpr(spec.end.when, SCOPES.end) : null
  }
}

// -- the environment a slot is read in ---------------------------------------------------------

interface NodeView {
  signal: LabSignal
  depth: number
  isRoot: boolean
}

/** A node's fields under `prefix` (`child.price`), or undefined when the name is not one. */
function nodeField(view: NodeView | null, field: string): ExprValue {
  if (!view) return undefined
  const s = view.signal
  switch (field) {
    case 'price':
      return s.price
    case 'tf':
      return s.durationMs / 60_000
    case 'time':
      return s.knownAt
    case 'depth':
      return view.depth
    case 'is_root':
      return view.isRoot
    case 'side':
      return s.side
    case 'source':
      return s.source
    case 'open':
      return s.bar.o
    case 'high':
      return s.bar.h
    case 'low':
      return s.bar.l
    case 'close':
      return s.bar.c
    default: {
      if (!field.startsWith('raw.')) return undefined
      const v = s.raw[field.slice(4)]
      return typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : undefined
    }
  }
}

/** What a graph has done so far, as `graph.*` reads it. */
export interface GraphState {
  side: Side
  extreme: number | null
  nodes: number
  entries: number
  startedAt: number | null
}

export interface EnvParts {
  nodes: Record<string, NodeView | null>
  graph: GraphState | null
  /** The node whose timeframe and instant `atr()` and `ind()` default to. */
  subject: { interval: string; at: number }
  readings: Readings
  /** `dir`: the graph's side, or the subject's when there is no graph. */
  side: Side
  extra?: Record<string, ExprValue>
}

/** The environment one slot evaluation reads. Exported for the entries and the levels. */
export function slotEnv(parts: EnvParts): ExprEnv {
  return {
    get(name) {
      if (parts.extra && name in parts.extra) return parts.extra[name]
      if (name === 'dir') return parts.side === 'top' ? 1 : -1
      if (name === 'pip') return parts.readings.pip
      const dot = name.indexOf('.')
      if (dot < 0) return undefined
      const head = name.slice(0, dot)
      const field = name.slice(dot + 1)
      if (head === 'graph') {
        const g = parts.graph
        if (!g) return undefined
        if (field === 'extreme') return g.extreme ?? undefined
        if (field === 'nodes') return g.nodes
        if (field === 'entries') return g.entries
        if (field === 'age') return g.startedAt === null ? undefined : (parts.subject.at - g.startedAt) / 60_000
        return undefined
      }
      if (head in parts.nodes) return nodeField(parts.nodes[head], field)
      return undefined
    },
    call(name, args) {
      const { subject, readings } = parts
      if (name === 'atr') {
        const period = args[0]
        const interval = typeof args[1] === 'string' && args[1] !== '*' ? args[1] : subject.interval
        return typeof period === 'number' ? readings.atr(period, interval, subject.at) : undefined
      }
      if (name === 'ind') {
        const [indicator, output, tf, ...params] = args
        if (typeof indicator !== 'string' || typeof output !== 'string') return undefined
        const interval = typeof tf === 'string' && tf !== '*' ? tf : subject.interval
        if (!params.every((p) => typeof p === 'number')) return undefined
        return readings.ind(indicator, output, interval, params as number[], subject.at)
      }
      return undefined
    }
  }
}

// -- the walk ------------------------------------------------------------------------------------

interface Building extends LabGraph {
  extreme: number | null
  entries: number
  startedAt: number | null
}

function view(graph: Building, index: number): NodeView {
  const node = graph.nodes[index]
  return { signal: node.signal, depth: node.depth, isRoot: node.parent < 0 }
}

/** The root a node's chain hangs from. */
function rootOf(graph: Building, index: number): number {
  let i = index
  while (i >= 0 && graph.nodes[i].parent >= 0) i = graph.nodes[i].parent
  return i
}

function stateOf(graph: Building): GraphState {
  return { side: graph.side, extreme: graph.extreme, nodes: graph.nodes.length, entries: graph.entries, startedAt: graph.startedAt }
}

/** Whether `signal` goes further than `than`, `side`'s way. */
function further(side: Side, price: number, than: number): boolean {
  return side === 'top' ? price > than : price < than
}

/**
 * The graphs one root grows, oldest first: `buildGraphs` in client/mtf/graph.ts, with the
 * strategy's slots where that file has its own rules.
 */
export function buildGraphs(
  input: GraphInput,
  root: string,
  from: number,
  compiled: CompiledGraph,
  taken: ReadonlySet<string>
): LabGraph[] {
  const { spec, readings } = input
  const rootMs = resolutionDurationMs(root)
  const isRootSignal = (s: LabSignal): boolean => s.interval === root && (spec.rootSources === null || spec.rootSources.includes(s.source))
  const ordered = input.signals
    .filter((s) => s.durationMs <= rootMs && s.knownAt >= from && Number.isFinite(s.price))
    .slice()
    .sort((a, b) => {
      if (a.knownAt !== b.knownAt) return a.knownAt - b.knownAt
      const aRoot = isRootSignal(a) ? 0 : 1
      const bRoot = isRootSignal(b) ? 0 : 1
      if (aRoot !== bRoot) return aRoot - bRoot
      return b.durationMs - a.durationMs
    })

  const graphs: LabGraph[] = []
  let current: Building | null = null

  // -- end rules ---------------------------------------------------------------------------
  const rootCloses = spec.end.rootBars !== null ? (input.rootCloses?.(root) ?? []) : []
  const watch = compiled.end ? (input.watchBars ?? []) : []
  let watchAt = 0
  /** Close `graph` if an end rule fired at or before `t`, and say so. */
  const endedBy = (graph: Building, t: number): boolean => {
    if (graph.endedAt !== null) return true
    if (graph.startedAt === null) return false
    let at: number | null = null
    let reason: EndReason | null = null
    if (spec.end.rootBars !== null) {
      // The Nth root bar to close after the graph started.
      let count = 0
      for (const close of rootCloses) {
        if (close <= graph.startedAt) continue
        count++
        if (count >= spec.end.rootBars) {
          if (close <= t) {
            at = close
            reason = 'expired'
          }
          break
        }
      }
    }
    if (compiled.end) {
      while (watchAt < watch.length && watch[watchAt].end <= graph.startedAt) watchAt++
      while (watchAt < watch.length && watch[watchAt].end <= t && (at === null || watch[watchAt].end < at)) {
        const bar = watch[watchAt]
        const env = slotEnv({
          nodes: { root: view(graph, 0) },
          graph: stateOf(graph),
          subject: { interval: input.watchInterval ?? graph.nodes[0].signal.interval, at: bar.end },
          readings,
          side: graph.side,
          extra: { 'bar.open': bar.o, 'bar.high': bar.h, 'bar.low': bar.l, 'bar.close': bar.c, 'bar.time': bar.end }
        })
        if (compiled.end.holds(env)) {
          at = bar.end
          reason = 'condition'
          break
        }
        watchAt++
      }
    }
    if (at === null) return false
    graph.endedAt = at
    graph.endReason = reason
    return true
  }

  // -- the step test -----------------------------------------------------------------------
  const canStep = (graph: Building, parentIndex: number, child: LabSignal): boolean => {
    const parent = graph.nodes[parentIndex]
    if (child.side !== parent.signal.side) return false
    if (child.knownAt <= parent.signal.knownAt) return false
    if (compiled.step.length === 0) return true
    const rootIndex = rootOf(graph, parentIndex)
    const env = slotEnv({
      nodes: {
        child: { signal: child, depth: parent.depth + 1, isRoot: false },
        parent: view(graph, parentIndex),
        root: rootIndex >= 0 ? view(graph, rootIndex) : null
      },
      graph: stateOf(graph),
      subject: { interval: child.interval, at: child.knownAt },
      readings,
      side: graph.side
    })
    for (const condition of compiled.step) if (!condition.holds(env)) return false
    return true
  }

  /** Which node `signal` hangs from, or -1 (graph.ts `parentFor`, generalised). */
  const parentFor = (graph: Building, signal: LabSignal): number => {
    switch (spec.parent) {
      case 'supersede': {
        let stepDown = -1
        let sameSeen = false
        for (let i = graph.nodes.length - 1; i >= 0; i--) {
          const node = graph.nodes[i].signal
          if (node.interval === signal.interval) {
            // Only the last one is offered; an older one it also beats was itself superseded.
            if (!sameSeen && canStep(graph, i, signal)) return i
            sameSeen = true
            continue
          }
          if (stepDown < 0 && canStep(graph, i, signal)) stepDown = i
        }
        return stepDown
      }
      case 'recent': {
        for (let i = graph.nodes.length - 1; i >= 0; i--) if (canStep(graph, i, signal)) return i
        return -1
      }
      case 'nearest': {
        let best = -1
        let gap = Number.POSITIVE_INFINITY
        for (let i = graph.nodes.length - 1; i >= 0; i--) {
          if (!canStep(graph, i, signal)) continue
          const d = Math.abs(graph.nodes[i].signal.price - signal.price)
          if (d < gap) {
            gap = d
            best = i
          }
        }
        return best
      }
      case 'root': {
        for (let i = graph.nodes.length - 1; i >= 0; i--) if (graph.nodes[i].parent < 0 && canStep(graph, i, signal)) return i
        return -1
      }
    }
  }

  const beyondReach = (graph: Building, signal: LabSignal): boolean =>
    !spec.reach || graph.extreme === null || further(graph.side, signal.price, graph.extreme)

  const isEntry = (graph: Building, signal: LabSignal, parent: number, depth: number): boolean => {
    if (compiled.entry.length === 0) return false
    const rootIndex = parent >= 0 ? rootOf(graph, parent) : -1
    const env = slotEnv({
      nodes: {
        node: { signal, depth, isRoot: parent < 0 },
        parent: parent >= 0 ? view(graph, parent) : null,
        root: rootIndex >= 0 ? view(graph, rootIndex) : { signal, depth: 0, isRoot: true }
      },
      graph: stateOf(graph),
      subject: { interval: signal.interval, at: signal.knownAt },
      readings,
      side: graph.side
    })
    return compiled.entry.every((condition) => condition.holds(env))
  }

  const add = (graph: Building, signal: LabSignal, parent: number): void => {
    const depth = parent >= 0 ? graph.nodes[parent].depth + 1 : 0
    const entry = isEntry(graph, signal, parent, depth)
    if (graph.nodes.length === 0) {
      graphs.push(graph)
      graph.startedAt = signal.knownAt
    }
    graph.nodes.push({ signal, parent, depth, entry })
    if (entry) graph.entries++
    if (graph.extreme === null || further(graph.side, signal.price, graph.extreme)) graph.extreme = signal.price
  }

  const fresh = (side: Side): Building => ({ root, side, nodes: [], endedAt: null, endReason: null, extreme: null, entries: 0, startedAt: null })

  for (const signal of ordered) {
    if (current && endedBy(current, signal.knownAt)) current = null
    if (isRootSignal(signal)) {
      if (!current || current.side !== signal.side) current = fresh(signal.side)
      if (taken.has(signal.key)) continue
      if (spec.rootJoin === 'new' && current.nodes.length > 0) {
        current = fresh(signal.side)
        add(current, signal, -1)
        continue
      }
      if (spec.rootJoin === 'ignore' && current.nodes.length > 0) continue
      // A root signal that supersedes the last one is that graph's root timeframe carrying on,
      // drawn as a step from it; one that does not is another root of the same graph. Either
      // way it has to go further than the graph already has.
      if (beyondReach(current, signal)) add(current, signal, current.nodes.length > 0 ? parentFor(current, signal) : -1)
      continue
    }
    if (!current || signal.side !== current.side) continue
    if (!beyondReach(current, signal)) continue
    const parent = parentFor(current, signal)
    if (parent >= 0) add(current, signal, parent)
  }
  // Strip the walk's bookkeeping.
  return graphs.map(({ root: r, side, nodes, endedAt, endReason }) => ({ root: r, side, nodes, endedAt, endReason }))
}

/**
 * Where each root's walk begins for a window starting at `from` -- the server's `walk_starts`
 * (wdashboard-server services/mtfgraph.py), within the strategy's read bound.
 *
 * A root's own graphs need only its run in force at `from`: a side switch resets everything a
 * graph carries. But which of its signals may ROOT a graph depends on the longer roots' steps,
 * so every longer root starts from its run in force at the earliest start of the shorter ones.
 * Shortest root first, each pulling the edge the next one is read at back to its own start. With
 * a bound that reaches every run's start this is the overlay's graph exactly; where a run began
 * before the bound it is cut there (`lookback.rootBars`).
 */
export function graphStarts(input: Pick<GraphInput, 'signals' | 'spec' | 'from'>): Map<string, number> {
  const out = new Map<string, number>()
  let edge = input.from
  for (const root of [...input.spec.roots].sort((a, b) => resolutionDurationMs(a) - resolutionDurationMs(b))) {
    const rootMs = resolutionDurationMs(root)
    if (!Number.isFinite(rootMs)) continue
    const rootSignals = input.signals.filter((s) => s.interval === root && (input.spec.rootSources === null || input.spec.rootSources.includes(s.source)))
    const start = graphStart(rootSignals, edge, input.spec.lookback.rootBars * rootMs)
    out.set(root, start)
    edge = Math.min(edge, start)
  }
  return out
}

/**
 * Every root's graphs (the server's `build_root_graphs`): longest root first, each from where
 * `graphStarts` says, and -- with `takenDontRoot` -- a signal that steps in a longer root's graph
 * roots nothing here.
 */
export function buildRootGraphs(input: GraphInput, compiled: CompiledGraph = compileGraph(input.spec, input.entry)): LabGraph[] {
  const out: LabGraph[] = []
  const taken = new Set<string>()
  const starts = graphStarts(input)
  const roots = [...input.spec.roots].sort((a, b) => resolutionDurationMs(b) - resolutionDurationMs(a))
  for (const root of roots) {
    const from = starts.get(root)
    if (from === undefined) continue
    const built = buildGraphs(input, root, from, compiled, input.spec.takenDontRoot ? taken : new Set())
    out.push(...built)
    if (input.spec.takenDontRoot) for (const graph of built) for (const node of graph.nodes) if (node.parent >= 0) taken.add(node.signal.key)
  }
  return out
}

/** The first signal of the run of same-side root signals in force at `from`, within
 * `lookbackMs` of it; `from` when none falls there (the server's `run_start`, bounded). */
export function graphStart(rootSignals: readonly LabSignal[], from: number, lookbackMs: number): number {
  const earliest = from - lookbackMs
  const inSpan = rootSignals.filter((s) => s.knownAt >= earliest && s.knownAt <= from).sort((a, b) => a.knownAt - b.knownAt)
  if (inSpan.length === 0) return from
  let first = inSpan.length - 1
  while (first > 0 && inSpan[first - 1].side === inSpan[first].side) first--
  return inSpan[first].knownAt
}

/** Every entry node, once per signal (the longest root's graph first), oldest first. */
export function graphEntries(graphs: readonly LabGraph[]): Array<{ graph: LabGraph; node: LabNode; index: number }> {
  const seen = new Set<string>()
  const out: Array<{ graph: LabGraph; node: LabNode; index: number }> = []
  for (const graph of graphs) {
    graph.nodes.forEach((node, index) => {
      if (!node.entry || seen.has(node.signal.key)) return
      seen.add(node.signal.key)
      out.push({ graph, node, index })
    })
  }
  return out.sort((a, b) => a.node.signal.knownAt - b.node.signal.knownAt)
}
