// ONE RUN of a strategy over a window of one instrument: everything the lab shows, and what a
// wall pane or an alert reads a strategy's entries from.
//
//   1. check it (model.ts `strategyProblems`), compile its slots
//   2. read what it needs -- each source's signals on each of its timeframes, those timeframes'
//      bars (for the candles signals are priced on, and for `atr()` / `ind()`), the bars and
//      points its rules read -- each back as far as the graph in force at the window's start
//      needs it, and no further
//   3. signals -> graphs -> entries -> filter (events.ts, graph.ts, entries.ts)
//   4. what happened after each entry (outcomes.ts) and the entries as trades (trades.ts), on
//      the PATH timeframe: the longest stored one that divides every entry's, so each entry's
//      close is a path bar's close
//
// Reads go through `LabData`, which holds them for the page: a second run with an edited rule
// reads nothing new.

import type { Point } from '../alerts/data'
import { indexPoints, type PointIndex } from '../alerts/compute'
import { leadInFor, type ServerCatalogue } from '../alerts/catalogue'
import { operandKey } from '../alerts/rules'
import { pointSource } from '../alerts/search'
import type { Operand } from '../alerts/types'
import { resolutionDurationMs } from '../periods'
import type { ReplayBar } from '../replay/cache'
import { type CandleGrid, defaultBase, nominalMs, STORED_LADDER } from '../replay/timeframes'
import type { LabData } from './data'
import { applyFilter, entriesOfEvents, entriesOfGraphs, graphStateAt, type LabEntry, RuleAtInstant, rootIndex } from './entries'
import { type Ast, compileExpr, type ExprEnv } from './expr'
import { publishedSignals, ruleOperands, ruleSignals } from './events'
import { buildRootGraphs, compileGraph, graphStart, type LabGraph, type LabSignal, slotEnv } from './graph'
import { type Problem, SCOPES, type Strategy, strategyProblems } from './model'
import { type EntryOutcome, measureOutcome, type OutcomeSummary, pathIndex, summariseOutcomes } from './outcomes'
import { computeReadings, leadIn, needsOf, type ReadingNeed, type SeriesReadings } from './readings'
import { type SimResult, simulate } from './trades'

export class RunError extends Error {
  constructor(
    message: string,
    readonly problems: Problem[] = []
  ) {
    super(message)
    this.name = 'RunError'
  }
}

export class RunCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'RunCancelled'
  }
}

export interface RunOptions {
  /** Run on this instrument instead of the strategy's own (a wall pane's). */
  symbol?: string
  /** The window, absolute; defaults to the strategy's. */
  from?: number
  to?: number
  /** The server catalogue, for rules that read a stored series or a signal. */
  catalogue: ServerCatalogue | null
  /** Skip the simulated trades (a wall pane draws the graph and entries only). */
  simulate?: boolean
  onProgress?: (stage: string) => void
  /** Asked between stages: true abandons the run (it throws `RunCancelled`). */
  isCancelled?: () => boolean
  now?: number
}

export interface SourceCount {
  source: string
  interval: string
  signals: number
}

export interface LabRun {
  strategy: Strategy
  symbol: string
  from: number
  to: number
  grid: CandleGrid
  pip: number
  /** Every signal of the pool read for the run (including the lead-in before `from`). */
  signals: LabSignal[]
  counts: SourceCount[]
  graphs: LabGraph[]
  /** Entries in `[from, to]` that passed the filter. */
  entries: LabEntry[]
  /** Entries the filter took out. */
  filtered: LabEntry[]
  outcomes: Map<string, EntryOutcome>
  summary: { all: OutcomeSummary; long: OutcomeSummary; short: OutcomeSummary }
  sim: SimResult | null
  pathInterval: string | null
  readings: SeriesReadings
  warnings: string[]
  timings: Array<{ stage: string; ms: number }>
}

const DAY = 86_400_000
/** Added behind every read: a span in nominal bars crosses weekends that hold none. */
const BACK_PAD_MS = 4 * DAY

/** The window a strategy runs over, absolute. */
export function runWindow(strategy: Strategy, options: Pick<RunOptions, 'from' | 'to' | 'now'> = {}): { from: number; to: number } {
  const now = options.now ?? Date.now()
  if (options.from !== undefined && options.to !== undefined) return { from: options.from, to: options.to }
  if (strategy.window.kind === 'range') return { from: strategy.window.from, to: strategy.window.to }
  return { from: now - strategy.window.days * DAY, to: now }
}

/** The bars of `interval` that tile every one of `entryIntervals`, among what is stored. */
export function autoPathInterval(entryIntervals: readonly string[]): string | null {
  if (entryIntervals.length === 0) return null
  return defaultBase([...new Set(entryIntervals)], STORED_LADDER)
}

export async function runStrategy(strategy: Strategy, data: LabData, options: RunOptions): Promise<LabRun> {
  const timings: Array<{ stage: string; ms: number }> = []
  let mark = performance.now()
  const stage = (name: string): void => {
    const now = performance.now()
    timings.push({ stage: name, ms: now - mark })
    mark = now
    if (options.isCancelled?.()) throw new RunCancelled()
  }
  const progress = (text: string): void => {
    options.onProgress?.(text)
    if (options.isCancelled?.()) throw new RunCancelled()
  }

  const problems = strategyProblems(strategy)
  if (problems.length > 0) throw new RunError(`${problems.length} problem${problems.length === 1 ? '' : 's'} to fix first`, problems)

  const symbol = options.symbol ?? strategy.instrument
  const { from, to } = runWindow(strategy, options)
  const warnings: string[] = []
  progress('Reading the instrument')
  const [grid, pip] = await Promise.all([data.grid(symbol), data.pip(symbol)])
  if (!grid) throw new RunError(`${symbol} has no market hours on the server, so its bars have no closes to evaluate at`)

  // -- compile -------------------------------------------------------------------------------
  const spec = strategy.graph
  const compiledGraph = compileGraph(spec, strategy.entry.when)
  const level = (expr: string | undefined) => (expr ? compileExpr(expr, SCOPES.level) : undefined)
  const levels = {
    stop: strategy.exits.stop?.kind === 'expr' ? level(strategy.exits.stop.expr) : undefined,
    target: strategy.exits.target?.kind === 'expr' ? level(strategy.exits.target.expr) : undefined,
    trail: strategy.exits.trail?.distance.kind === 'expr' ? level(strategy.exits.trail.distance.expr) : undefined
  }

  // -- what to read ---------------------------------------------------------------------------
  const pool = [...new Set(strategy.sources.flatMap((s) => s.timeframes))]
  const watchInterval = spec.end.watch ?? [...pool].sort((a, b) => resolutionDurationMs(a) - resolutionDurationMs(b))[0]
  const needs: ReadingNeed[] = []
  const addNeeds = (ast: Ast | undefined, self: readonly string[]): void => {
    if (ast) needs.push(...needsOf(ast, self))
  }
  if (spec.enabled) {
    for (const c of compiledGraph.step) addNeeds(c.ast, pool)
    if (compiledGraph.end) addNeeds(compiledGraph.end.ast, [watchInterval])
  }
  for (const c of compiledGraph.entry) addNeeds(c.ast, pool)
  for (const c of Object.values(levels)) addNeeds(c?.ast, pool)
  const atrLevel = (l: Strategy['exits']['stop']): void => {
    if (l?.kind !== 'atr') return
    for (const interval of l.interval ? [l.interval] : pool) needs.push({ kind: 'atr', period: l.period, interval })
  }
  atrLevel(strategy.exits.stop)
  atrLevel(strategy.exits.target)
  atrLevel(strategy.exits.trail?.distance ?? null)
  for (const interval of pool) needs.push({ kind: 'atr', period: strategy.outcomes.atrPeriod, interval })

  // The rules' operands: rule sources, the filter, the exit rules.
  const ruleOps: Operand[] = []
  for (const source of strategy.sources) if (source.kind === 'rule') for (const tf of source.timeframes) ruleOps.push(...ruleOperands(source, tf))
  const filterOps = strategy.entry.filter ? RuleAtInstant.operands(strategy.entry.filter) : []
  const exitOps = [strategy.exits.ruleLong, strategy.exits.ruleShort].flatMap((r) => (r ? RuleAtInstant.operands(r) : []))
  const operands = [...ruleOps, ...filterOps, ...exitOps]

  // How far back each pool timeframe is read. A root: its lookback, for the graph in force at
  // `from`. Every other timeframe: back to where the earliest such graph began (found once the
  // roots are read), capped at `lookback.maxBars` of its own -- the overlay's own bounds.
  const roots = spec.enabled ? spec.roots.filter((r) => pool.includes(r)) : []
  const lookbackOf = (root: string): number => spec.lookback.rootBars * resolutionDurationMs(root)

  // -- read ------------------------------------------------------------------------------------
  const now = options.now ?? Date.now()
  const barsHeld = new Map<string, { start: number; end: number; bars: ReplayBar[] }>()
  /** Bars of `interval` over `[start, end)`, read once per run over the widest span asked for
   * (the data layer holds what it has read, so widening costs only the new part). */
  const readBars = async (interval: string, start: number, end = to): Promise<readonly ReplayBar[]> => {
    const held = barsHeld.get(interval)
    if (held && held.start <= start && held.end >= end) return held.bars
    const span = { start: Math.min(start, held?.start ?? start), end: Math.max(end, held?.end ?? end) }
    const bars = await data.bars(symbol, interval, span.start, span.end, 'core')
    barsHeld.set(interval, { ...span, bars })
    return bars
  }
  const barsOf = (interval: string): readonly ReplayBar[] => barsHeld.get(interval)?.bars ?? []

  // Lead-in in bars, per timeframe: indicator warm-up for every reading and rule operand on it.
  const leadInOf = (interval: string): number =>
    Math.max(2, leadInFor(operands, interval), ...needs.filter((n) => n.interval === interval).map(leadIn))

  const signals: LabSignal[] = []
  const counts: SourceCount[] = []
  const signalStart = new Map<string, number>()

  const readPool = async (intervals: readonly string[], startOf: (interval: string) => number): Promise<void> => {
    for (const source of strategy.sources) {
      for (const interval of source.timeframes) {
        if (!intervals.includes(interval)) continue
        const start = startOf(interval)
        signalStart.set(interval, Math.min(signalStart.get(interval) ?? start, start))
        progress(`Reading ${source.title} ${interval}`)
        const bars = await readBars(interval, start - leadInOf(interval) * nominalMs(interval))
        let found: LabSignal[] = []
        if (source.kind === 'published') {
          const points = await data.signals(
            { plugin: source.plugin, variant: source.variant, params: source.params },
            symbol,
            interval,
            grid.toWire(interval, start),
            grid.toWire(interval, to)
          )
          found = publishedSignals(source, interval, points, bars)
        } else {
          for (const op of ruleOperands(source, interval)) await readOperand(op, start)
          found = await ruleSignals({ source, interval, bars: barsOf, points: pointsOf, from: start })
        }
        signals.push(...found)
        counts.push({ source: source.id, interval, signals: found.filter((s) => s.knownAt >= from && s.knownAt <= to).length })
      }
    }
  }

  // Server points for series and signal operands of the rules.
  const pointIndex = new Map<string, PointIndex>()
  const pointsOf = (operand: Operand): PointIndex | undefined => pointIndex.get(operandKey(operand))
  const readOperand = async (operand: Operand, start: number, end = to): Promise<void> => {
    const lead = leadInFor([operand], operand.interval) * nominalMs(operand.interval)
    await readBars(operand.interval, start - lead - BACK_PAD_MS, end)
    if (operand.kind !== 'series' && operand.kind !== 'signal') return
    const key = operandKey(operand)
    if (pointIndex.has(key)) return
    const source = options.catalogue ? pointSource(operand, options.catalogue) : null
    if (!source) {
      warnings.push(`${operand.kind === 'series' ? operand.indicator : operand.plugin} is not in this server's catalogue: it reads as missing`)
      pointIndex.set(key, { rows: new Map(), through: null })
      return
    }
    const points: Point[] = await data.points(source, symbol, operand.interval, grid.toWire(operand.interval, start - lead - BACK_PAD_MS), grid.toWire(operand.interval, end))
    pointIndex.set(key, indexPoints(points, source.foldBy))
  }

  // Roots first: where their graphs in force began decides how far back everything else reads.
  if (roots.length > 0) await readPool(roots, (root) => from - lookbackOf(root) - BACK_PAD_MS)
  let graphFrom = from
  for (const root of roots) {
    const rootSignals = signals.filter((s) => s.interval === root && (spec.rootSources === null || spec.rootSources.includes(s.source)))
    graphFrom = Math.min(graphFrom, graphStart(rootSignals, from, lookbackOf(root)))
  }
  await readPool(
    pool.filter((tf) => !roots.includes(tf)),
    (tf) => (spec.enabled ? Math.max(graphFrom, from - spec.lookback.maxBars * resolutionDurationMs(tf)) : from) - BACK_PAD_MS
  )
  // The filter is read inside the window; an exit rule as long as a trade can run past it.
  const simEnd = Math.min(now, to + 60 * DAY)
  for (const op of filterOps) await readOperand(op, from)
  for (const op of exitOps) await readOperand(op, from, simEnd)
  // Readings on timeframes no source reads (an `atr(14, '4h')` on a 1h pool).
  for (const need of needs) if (!barsHeld.has(need.interval)) await readBars(need.interval, from - BACK_PAD_MS - leadIn(need) * nominalMs(need.interval))
  if (spec.enabled && compiledGraph.end && !barsHeld.has(watchInterval)) await readBars(watchInterval, graphFrom - BACK_PAD_MS)
  stage('read')

  const readings = await computeReadings(needs, barsOf, pip)
  stage('readings')

  // -- graphs and entries ------------------------------------------------------------------------
  progress('Building graphs')
  let graphs: LabGraph[] = []
  let candidates: LabEntry[]
  if (spec.enabled) {
    graphs = buildRootGraphs(
      {
        signals,
        spec,
        entry: strategy.entry.when,
        from,
        readings,
        rootCloses: (root) => barsOf(root).map((b) => b.end),
        watchBars: barsOf(watchInterval).map((b) => ({ end: b.end, o: b.o, h: b.h, l: b.l, c: b.c })),
        watchInterval
      },
      compiledGraph
    )
    candidates = entriesOfGraphs(graphs, strategy.entry.direction)
  } else {
    candidates = entriesOfEvents(
      signals.filter((s) => s.knownAt >= from),
      strategy.entry.when,
      strategy.entry.direction,
      readings
    )
  }
  candidates = candidates.filter((e) => e.at >= from && e.at <= to)
  const filter = strategy.entry.filter ? await RuleAtInstant.build(strategy.entry.filter, barsOf, pointsOf) : null
  const { kept: entries, filtered } = applyFilter(candidates, filter)
  stage('graphs')

  // -- path: outcomes and trades --------------------------------------------------------------
  const pathInterval = strategy.pathInterval ?? autoPathInterval(entries.map((e) => e.signal.interval))
  const outcomes = new Map<string, EntryOutcome>()
  let sim: SimResult | null = null
  if (pathInterval && entries.length > 0) {
    const pathMs = nominalMs(pathInterval)
    const longestEntry = Math.max(...entries.map((e) => e.signal.durationMs))
    const horizon = Math.max(1, ...strategy.outcomes.horizons) * longestEntry
    const pathFrom = entries[0].at - pathMs - BACK_PAD_MS
    const pathTo = Math.min(now, Math.max(...entries.map((e) => e.at)) + horizon + BACK_PAD_MS)
    progress(`Reading ${pathInterval} path bars`)
    const pathBars = await data.bars(symbol, pathInterval, pathFrom, pathTo, 'core')
    const path = pathIndex(pathBars, pathMs)
    for (const entry of entries) {
      const outcome = measureOutcome(entry, path, strategy.outcomes, pip, readings.atr(strategy.outcomes.atrPeriod, entry.signal.interval, entry.at))
      if (outcome) outcomes.set(entry.id, outcome)
    }
    if (outcomes.size < entries.length) warnings.push(`${entries.length - outcomes.size} entries have no ${pathInterval} bar closing at them, so no outcome`)
    stage('outcomes')

    if (options.simulate !== false) {
      const exitEnd = strategy.exits.maxBars ? strategy.exits.maxBars.count * (strategy.exits.maxBars.interval ? nominalMs(strategy.exits.maxBars.interval) : longestEntry) : 30 * DAY
      progress(`Reading ${pathInterval} bid/ask bars`)
      const simBars = await data.bars(symbol, pathInterval, pathFrom, Math.min(simEnd, to + exitEnd + BACK_PAD_MS), 'all')
      if (simBars.length > 0 && simBars.every((b) => !b.bid)) warnings.push(`the ${pathInterval} bars carry no bid/ask here: trades fill at mid, without spread`)
      const exitRules = {
        long: strategy.exits.ruleLong ? await RuleAtInstant.build(strategy.exits.ruleLong, barsOf, pointsOf) : null,
        short: strategy.exits.ruleShort ? await RuleAtInstant.build(strategy.exits.ruleShort, barsOf, pointsOf) : null
      }
      sim = simulate({
        symbol,
        entries,
        bars: simBars,
        pathMs,
        exits: strategy.exits,
        sizing: strategy.sizing,
        pip,
        readings,
        levels,
        levelEnv: (entry, reference) => levelEnv(entry, reference, readings),
        exitRule: (direction) => {
          const rule = direction === 'long' ? exitRules.long : exitRules.short
          return rule ? (t) => rule.holdsAt(t) : null
        }
      })
      stage('trades')
    }
  }

  const outcomeList = (dir?: 'long' | 'short') =>
    entries.filter((e) => !dir || e.direction === dir).flatMap((e) => (outcomes.has(e.id) ? [outcomes.get(e.id) as EntryOutcome] : []))
  return {
    strategy,
    symbol,
    from,
    to,
    grid,
    pip,
    signals,
    counts,
    graphs,
    entries,
    filtered,
    outcomes,
    summary: {
      all: summariseOutcomes(outcomeList(), strategy.outcomes),
      long: summariseOutcomes(outcomeList('long'), strategy.outcomes),
      short: summariseOutcomes(outcomeList('short'), strategy.outcomes)
    },
    sim,
    pathInterval,
    readings,
    warnings,
    timings
  }
}

/** A level expression's environment for one entry. */
function levelEnv(entry: LabEntry, reference: number, readings: SeriesReadings): ExprEnv {
  const graph = entry.graph
  const nodeView = { signal: entry.signal, depth: graph ? graph.nodes[entry.node].depth : 0, isRoot: graph ? graph.nodes[entry.node].parent < 0 : true }
  let parent = null
  let root = nodeView
  if (graph) {
    const p = graph.nodes[entry.node].parent
    if (p >= 0) parent = { signal: graph.nodes[p].signal, depth: graph.nodes[p].depth, isRoot: graph.nodes[p].parent < 0 }
    const r = rootIndex(graph, entry.node)
    if (r >= 0) root = { signal: graph.nodes[r].signal, depth: 0, isRoot: true }
  }
  return slotEnv({
    nodes: { node: nodeView, parent, root },
    graph: graph ? graphStateAt(graph, entry.node) : null,
    subject: { interval: entry.signal.interval, at: entry.at },
    readings,
    side: entry.side,
    extra: { 'entry.price': reference, 'entry.dir': entry.direction === 'long' ? 1 : -1 }
  })
}
