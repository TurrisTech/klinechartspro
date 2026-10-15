// A STRATEGY, AS DATA: what the Strategy Lab edits, runs and saves, and what a wall pane or an
// alert names when it reads a strategy's entries.
//
//   sources   the SIGNAL POOL: published signals (arev21_outlier rank, arev21, krev...) and
//             events defined by a rule over indicators, each on the timeframes chosen
//   graph     how signals join into graphs: roots, resets, the step test, which parent a
//             signal hangs from, whether a graph only goes further, when it ends
//   entry     which graph nodes (or, without a graph, which events) are entries, a filter rule
//             read at the entry instant, and which way each side trades
//   exits     stop, target, breakeven, trailing, rule exits, a time limit
//   sizing    the simulated account
//   outcomes  what is measured after every entry
//
// Every graph rule the AREV21 outlier rank 85 overlay hard-codes (client/mtf/graph.ts) is a SLOT
// here, with that overlay's rule as its default, so `rank85Strategy()` draws the graphs the
// overlay draws (`graph.test.ts` holds the two side by side). A slot either picks a preset or
// is written in the expression language (./expr.ts), checked against the fields that slot offers
// (`SCOPES`).
//
// PURE: no fetch, no DOM.

import type { Rule } from '../alerts/types'
import { COMMON_FUNCTIONS, type ExprScope, exprProblem, type FieldSpec, type FnSpec } from './expr'

export const STRATEGY_VERSION = 1

/** Which way a graph runs: a TOP graph climbs over the price, a BOTTOM one falls under it. */
export type Side = 'top' | 'bottom'
export type Direction = 'long' | 'short'

/** Where a signal sits, read off the candle it was cast on: the body's top (a top signal) or
 * bottom (a bottom one) -- the overlay's choice -- the wick's high or low, or the close. */
export type PriceAnchor = 'body' | 'wick' | 'close'

/** The interval a rule source's operands name to mean "the event's own timeframe": one rule is
 * written once and read on every timeframe the source is switched on for. Never stored in an
 * alert -- `withInterval` replaces it before the rule is compiled. */
export const SELF_INTERVAL = '*'

/** A server plugin's published signal labels (`GET /plugins/signals`), read with `params`. */
export interface PublishedSource {
  kind: 'published'
  /** Unique in the strategy: what a node's `source` field and the entry slot name it by. */
  id: string
  title: string
  plugin: string
  variant: string
  /** Sent as the read's `params`, in the registry's declared order. */
  params: Record<string, number>
  timeframes: string[]
  /** A label's side in a graph. Labels left out are not read. */
  sides: Record<string, Side>
  price: PriceAnchor
}

/** Events defined by a rule over indicators, bar fields, stored series or signals: an event
 * fires at a bar close where the rule STARTS to hold (its edge). */
export interface RuleSource {
  kind: 'rule'
  id: string
  title: string
  timeframes: string[]
  /** Operands on `SELF_INTERVAL` read the event's own timeframe. Null: no events of that side. */
  top: Rule | null
  bottom: Rule | null
  price: PriceAnchor
}

export type SignalSource = PublishedSource | RuleSource

/** One condition of a slot that takes several, all of which must hold. */
export interface SlotCondition {
  id: string
  /** What the preset said, while the text is still the preset's. */
  label?: string
  expr: string
  enabled: boolean
}

/** Which node a signal hangs from, among the ones the step test admits.
 *
 *   supersede  its own timeframe's last node when it goes further, else the most recent node of
 *              a LONGER timeframe -- the overlay's rule (user, 2026-09-23)
 *   recent     the most recent node of any timeframe
 *   nearest    the node nearest it in price
 *   root       the graph's most recent root */
export type ParentRule = 'supersede' | 'recent' | 'nearest' | 'root'

/** What a same-side root signal does while a graph is open: JOIN it as another root (the
 * overlay), start a NEW graph, or be IGNORED (the first root of a run is the only one). */
export type RootJoin = 'join' | 'new' | 'ignore'

export interface GraphSpec {
  /** Off: entries come straight from the pool's events (`EntrySpec.when` reads each one). */
  enabled: boolean
  roots: string[]
  /** The sources whose signals may root a graph; null for any. */
  rootSources: string[] | null
  rootJoin: RootJoin
  /** A signal that already STEPS in a longer root's graph does not root one of its own. */
  takenDontRoot: boolean
  /** A graph only goes further: every node is beyond every node before it. */
  reach: boolean
  parent: ParentRule
  /** The step test, beyond the two that are not slots: the same side, and strictly later. */
  step: SlotCondition[]
  /** When a graph ends before its root switches side. */
  end: {
    /** After this many bars of the root's timeframe. */
    rootBars: number | null
    /** At the first close of `watch` where this holds (END scope). Empty: never. */
    when: string
    /** The timeframe `when` is read at; null for the pool's shortest. */
    watch: string | null
  }
  /** How far back a root is read for the graph in force at the window's start, in its own
   * bars, and the most any other timeframe reaches back -- read bounds, not rules. */
  lookback: { rootBars: number; maxBars: number }
}

export interface EntrySpec {
  /** Which nodes are entries (graph on) or which events (graph off); ENTRY scope, all hold. */
  when: SlotCondition[]
  /** Read at the entry instant; null for none. An alert rule, operands on any timeframe. */
  filter: Rule | null
  /** Which way an entry of each side trades. */
  direction: Record<Side, Direction>
}

/** A stop or target distance, or a level. */
export type Level =
  | { kind: 'pips'; value: number }
  /** `mult` x ATR(`period`) of `interval` (null: the entry's own timeframe) at the entry. */
  | { kind: 'atr'; mult: number; period: number; interval: string | null }
  /** A target only: `mult` x the stop's distance. */
  | { kind: 'r'; mult: number }
  /** A price LEVEL computed at the entry (LEVEL scope). */
  | { kind: 'expr'; expr: string }

export interface ExitSpec {
  stop: Level | null
  target: Level | null
  /** Move the stop to the entry once price has gone this many R the trade's way. */
  breakevenAtR: number | null
  /** A trailing stop `distance` behind the best close, once price has gone `activateR` R. */
  trail: { distance: Level; activateR: number } | null
  /** Close a long (short) at the first close where its rule holds. */
  ruleLong: Rule | null
  ruleShort: Rule | null
  /** Close after this many bars of `interval` (null: the entry's own timeframe). */
  maxBars: { count: number; interval: string | null } | null
  /** Close on an entry the other way. */
  onOpposite: boolean
}

export interface Sizing {
  /** The simulated account's opening balance, in the instrument's QUOTE currency -- the
   * currency the fill engine counts P&L in (client/replay/engine.ts). */
  balance: number
  mode: 'units' | 'risk'
  units: number
  /** Percent of the balance lost at the stop; a trade with no stop falls back to `units`. */
  riskPercent: number
  /** At most this many trades open at once. */
  maxOpen: number
}

export interface OutcomeSpec {
  /** Forward returns after this many bars of the entry's own timeframe. */
  horizons: number[]
  /** Which of entry +/- k x ATR is touched first, for each k. */
  touches: number[]
  atrPeriod: number
}

export type WindowSpec = { kind: 'days'; days: number } | { kind: 'range'; from: number; to: number }

export interface Strategy {
  version: typeof STRATEGY_VERSION
  id: string
  name: string
  notes: string
  /** Where it is previewed and run in the lab: `vendor:TICKER`. A wall pane runs it on the
   * pane's own instrument. */
  instrument: string
  window: WindowSpec
  sources: SignalSource[]
  graph: GraphSpec
  entry: EntrySpec
  exits: ExitSpec
  sizing: Sizing
  outcomes: OutcomeSpec
  /** The bars trades are simulated and outcomes measured on; null for the longest timeframe
   * that divides every entry's (`runner.ts`). */
  pathInterval: string | null
  createdAt: number
  updatedAt: number
}

// -- scopes: what each slot may read -----------------------------------------------------------

function nodeFields(prefix: string, what: string): FieldSpec[] {
  return [
    { name: `${prefix}.price`, doc: `${what}'s price (the candle's body top or bottom, by default)` },
    { name: `${prefix}.tf`, doc: `${what}'s timeframe in minutes -- compare with tf('5m')` },
    { name: `${prefix}.time`, doc: `When ${what} became knowable: its candle's close, in ms` },
    { name: `${prefix}.depth`, doc: `Steps from the root to ${what} (a root is 0)` },
    { name: `${prefix}.is_root`, doc: `Whether ${what} is a root` },
    { name: `${prefix}.side`, doc: `'top' or 'bottom'` },
    { name: `${prefix}.source`, doc: `The id of the pool source it came from` },
    { name: `${prefix}.open`, doc: `${what}'s candle open` },
    { name: `${prefix}.high`, doc: `${what}'s candle high` },
    { name: `${prefix}.low`, doc: `${what}'s candle low` },
    { name: `${prefix}.close`, doc: `${what}'s candle close` }
  ]
}

const GRAPH_FIELDS: FieldSpec[] = [
  { name: 'graph.extreme', doc: 'The furthest the graph has reached: its highest node (top) or lowest (bottom)' },
  { name: 'graph.nodes', doc: 'Nodes in the graph so far' },
  { name: 'graph.entries', doc: 'Entries the graph has produced so far' },
  { name: 'graph.age', doc: 'Minutes since the graph started' }
]

const COMMON_FIELDS: FieldSpec[] = [
  { name: 'dir', doc: '+1 in a top graph, -1 in a bottom one: (a - b) * dir > 0 means "a is further"' },
  { name: 'pip', doc: "The instrument's pip size in price units" }
]

const READ_FUNCTIONS: FnSpec[] = [
  {
    name: 'atr',
    signature: "atr(period, 'tf')",
    doc: "ATR(period) -- MT4's simple mean of the true range, as the ATR pane draws it -- on the node's own timeframe, or on 'tf', at the latest bar closed by then",
    minArgs: 1,
    maxArgs: 2,
    literal: true
  },
  {
    name: 'ind',
    signature: "ind('EMA', 'ema1', 'tf', 200)",
    doc: "A chart indicator's line at the latest bar of 'tf' ('*' for the node's own) closed by then, computed by the chart's own template with the parameters after it",
    minArgs: 3,
    maxArgs: 8,
    literal: true
  }
]

const RAW_DOC = 'and .raw.<field> for anything the signal’s plugin wrote (child.raw.p is arev’s P(up))'

export interface SlotScope extends ExprScope {
  title: string
  note: string
}

export const SCOPES = {
  /** May `child` hang from `parent`? Read for every candidate pair. */
  step: {
    title: 'Step test',
    note: `Read for each node a signal could hang from. The same side and strictly later are always required. ${RAW_DOC}.`,
    fields: [...nodeFields('child', 'the new signal'), ...nodeFields('parent', 'the node it would hang from'), ...nodeFields('root', "the graph's root"), ...GRAPH_FIELDS, ...COMMON_FIELDS],
    prefixes: ['child.raw', 'parent.raw', 'root.raw'],
    functions: READ_FUNCTIONS
  },
  /** Is this node (graph on) or event (graph off) an entry? */
  entry: {
    title: 'Entry test',
    note: `Read for each node as it joins its graph (or each event, with the graph off -- then a node has no parent or root). ${RAW_DOC}.`,
    fields: [...nodeFields('node', 'the node'), ...nodeFields('parent', 'its parent'), ...nodeFields('root', "its graph's root"), ...GRAPH_FIELDS, ...COMMON_FIELDS],
    prefixes: ['node.raw', 'parent.raw', 'root.raw'],
    functions: READ_FUNCTIONS
  },
  /** Does the graph end at this close? */
  end: {
    title: 'Graph ends when',
    note: 'Read at every close of the watched timeframe while a graph is open. bar.* is the bar that just closed.',
    fields: [
      { name: 'bar.open', doc: 'The bar that just closed' },
      { name: 'bar.high', doc: '' },
      { name: 'bar.low', doc: '' },
      { name: 'bar.close', doc: '' },
      { name: 'bar.time', doc: 'Its close, in ms' },
      ...nodeFields('root', "the graph's root"),
      ...GRAPH_FIELDS,
      ...COMMON_FIELDS
    ],
    prefixes: ['root.raw'],
    functions: READ_FUNCTIONS
  },
  /** A stop or target price, at the entry. */
  level: {
    title: 'Price level',
    note: 'A PRICE, read at the entry. entry.dir is +1 for a long, -1 for a short: entry.price - entry.dir * 2 * atr(14) is two ATR behind it.',
    fields: [
      { name: 'entry.price', doc: 'The entry bar’s close' },
      { name: 'entry.dir', doc: '+1 long, -1 short' },
      ...nodeFields('node', 'the entry node'),
      ...nodeFields('parent', 'its parent'),
      ...nodeFields('root', "its graph's root"),
      ...GRAPH_FIELDS,
      ...COMMON_FIELDS
    ],
    prefixes: ['node.raw', 'parent.raw', 'root.raw'],
    functions: READ_FUNCTIONS
  }
} satisfies Record<string, SlotScope>

export type ScopeName = keyof typeof SCOPES

/** Every function a slot can call, the common ones included -- for the field list. */
export function scopeFunctions(scope: ExprScope): FnSpec[] {
  return [...COMMON_FUNCTIONS, ...scope.functions]
}

// -- presets -----------------------------------------------------------------------------------

/** The overlay's step test, one condition per rule it states (graph.ts `canStep`). */
export function defaultStep(maxStep = 8): SlotCondition[] {
  return [
    { id: 'further', label: "goes further its graph's way", expr: '(child.price - parent.price) * dir > 0', enabled: true },
    { id: 'lower', label: 'on the same or a lower timeframe', expr: 'child.tf <= parent.tf', enabled: true },
    { id: 'maxstep', label: `at most ${maxStep}× shorter`, expr: `parent.tf <= child.tf * ${maxStep}`, enabled: true }
  ]
}

/** The overlay's entry: a step (not a root) on 5m or shorter (graph.ts `isEntry`). */
export function defaultGraphEntry(): SlotCondition[] {
  return [
    { id: 'step', label: 'a step, not a root', expr: 'not node.is_root', enabled: true },
    { id: 'short', label: 'on 5m or shorter', expr: "node.tf <= tf('5m')", enabled: true }
  ]
}

/** The timeframes the outlier overlays read (mtf/api.ts MTF_INTERVALS). */
export const RANK_TIMEFRAMES = ['3m', '5m', '15m', '20m', '30m', '1h', '2h', '4h', '8h', '1D']

export function rank85Source(): PublishedSource {
  return {
    kind: 'published',
    id: 'rank85',
    title: 'AREV21 outlier rank 85',
    plugin: 'arev21_outlier',
    variant: 'arev21_outlier_rank',
    // The overlay's params, in the registry's order (mtf/overlays.ts `outlierRankMtf`).
    params: { bars: 200, q: 0.85, samples_only: 0 },
    timeframes: [...RANK_TIMEFRAMES],
    sides: { long: 'top', short: 'bottom' },
    price: 'body'
  }
}

export function defaultGraph(): GraphSpec {
  return {
    enabled: true,
    roots: ['1D'],
    rootSources: null,
    rootJoin: 'join',
    takenDontRoot: true,
    reach: true,
    parent: 'supersede',
    step: defaultStep(),
    end: { rootBars: null, when: '', watch: null },
    // mtf/graph.ts ROOT_LOOKBACK_BARS and mtf/plugin.ts GRAPH_LOOKBACK_MAX_BARS.
    lookback: { rootBars: 300, maxBars: 10_000 }
  }
}

export function defaultExits(): ExitSpec {
  return {
    stop: { kind: 'atr', mult: 1.5, period: 14, interval: null },
    target: { kind: 'r', mult: 1 },
    breakevenAtR: null,
    trail: null,
    ruleLong: null,
    ruleShort: null,
    maxBars: { count: 48, interval: null },
    onOpposite: false
  }
}

export function defaultSizing(): Sizing {
  return { balance: 100_000, mode: 'risk', units: 10_000, riskPercent: 1, maxOpen: 1 }
}

export function defaultOutcomes(): OutcomeSpec {
  return { horizons: [1, 3, 12, 48], touches: [0.5, 1, 2], atrPeriod: 14 }
}

let counter = 0
export function newStrategyId(now = Date.now()): string {
  counter += 1
  return `st${now.toString(36)}${counter.toString(36)}`
}

/** The AREV21 outlier rank 85 overlay's graph, every rule at the overlay's own setting: roots on
 * 1D, every timeframe it offers, entries where a 5m or 3m signal steps in. */
export function rank85Strategy(now = Date.now()): Strategy {
  return {
    version: STRATEGY_VERSION,
    id: newStrategyId(now),
    name: 'AREV21 rank 85 graph',
    notes: '',
    instrument: 'oanda:EURUSD',
    window: { kind: 'days', days: 30 },
    sources: [rank85Source()],
    graph: defaultGraph(),
    entry: { when: defaultGraphEntry(), filter: null, direction: { top: 'long', bottom: 'short' } },
    exits: defaultExits(),
    sizing: defaultSizing(),
    outcomes: defaultOutcomes(),
    pathInterval: null,
    createdAt: now,
    updatedAt: now
  }
}

/** A strategy with no graph: an indicator event straight to an entry. */
export function ruleStrategy(now = Date.now()): Strategy {
  const base = rank85Strategy(now)
  return {
    ...base,
    name: 'RSI(14) crosses',
    sources: [
      {
        kind: 'rule',
        id: 'rsi',
        title: 'RSI(14) leaves 30 / 70',
        timeframes: ['1h'],
        top: { left: { kind: 'indicator', interval: SELF_INTERVAL, name: 'RSI', params: [14], output: 'rsi1' }, op: 'crosses_below', right: { value: 70 } },
        bottom: { left: { kind: 'indicator', interval: SELF_INTERVAL, name: 'RSI', params: [14], output: 'rsi1' }, op: 'crosses_above', right: { value: 30 } },
        price: 'close'
      }
    ],
    graph: { ...defaultGraph(), enabled: false, roots: ['1h'] },
    entry: { when: [], filter: null, direction: { top: 'short', bottom: 'long' } }
  }
}

// -- reading a rule on a timeframe ----------------------------------------------------------

/** `rule` with every operand on `SELF_INTERVAL` moved to `interval`. */
export function withInterval(rule: Rule, interval: string): Rule {
  const fix = <T extends { interval: string }>(operand: T): T => (operand.interval === SELF_INTERVAL ? { ...operand, interval } : operand)
  const walk = (node: Rule): Rule => {
    if ('all' in node) return { all: node.all.map(walk) }
    if ('any' in node) return { any: node.any.map(walk) }
    if ('not' in node) return { not: walk(node.not) }
    const right = node.right && 'operand' in node.right ? { operand: fix(node.right.operand) } : node.right
    return { ...node, left: fix(node.left), ...(right !== undefined ? { right } : {}) }
  }
  return walk(rule)
}

// -- checking -----------------------------------------------------------------------------------

export interface Problem {
  /** Where, in words: "Graph · step test 2". */
  where: string
  message: string
}

const INTERVAL = /^(\d+)([smhDWMY])$/

/** Everything that stops the strategy running, in the order the editor shows its sections. An
 * empty list means it can be run. Rules are compiled by the runner (they need the catalogue); the
 * expressions and the structure are checked here. */
export function strategyProblems(strategy: Strategy): Problem[] {
  const out: Problem[] = []
  const add = (where: string, message: string): void => {
    out.push({ where, message })
  }
  if (!/^[a-z0-9_]+:[A-Za-z0-9_.-]+$/.test(strategy.instrument)) add('Instrument', `not an instrument: '${strategy.instrument}' (want vendor:TICKER)`)
  if (strategy.window.kind === 'days' && !(strategy.window.days > 0)) add('Window', 'the window needs at least one day')
  if (strategy.window.kind === 'range' && !(strategy.window.to > strategy.window.from)) add('Window', 'the window ends before it starts')

  // The pool.
  if (strategy.sources.length === 0) add('Signals', 'the pool is empty: add a signal or a rule event')
  const ids = new Set<string>()
  for (const source of strategy.sources) {
    const where = `Signals · ${source.title || source.id}`
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(source.id)) add(where, `an id is a letter then letters, digits or _ (not '${source.id}')`)
    if (ids.has(source.id)) add(where, `two sources are called '${source.id}'`)
    ids.add(source.id)
    if (source.timeframes.length === 0) add(where, 'switch on at least one timeframe')
    for (const tf of source.timeframes) if (!INTERVAL.test(tf)) add(where, `not a timeframe: '${tf}'`)
    if (source.kind === 'published') {
      if (!source.plugin) add(where, 'choose a signal')
      if (Object.keys(source.sides).length === 0) add(where, 'map at least one label to a side')
      for (const [name, value] of Object.entries(source.params)) if (!Number.isFinite(value)) add(where, `parameter ${name} is not a number`)
    } else if (!source.top && !source.bottom) add(where, 'write a rule for tops, bottoms or both')
  }
  const pooled = new Set(strategy.sources.flatMap((s) => s.timeframes))

  const checkConditions = (section: string, conditions: SlotCondition[], scope: SlotScope): void => {
    conditions.forEach((condition, i) => {
      if (!condition.enabled) return
      const problem = exprProblem(condition.expr, scope)
      if (problem) add(`${section} ${i + 1}`, problem)
    })
  }

  // The graph.
  const graph = strategy.graph
  if (graph.enabled) {
    if (graph.roots.length === 0) add('Graph · roots', 'switch on a root timeframe')
    for (const root of graph.roots) if (!pooled.has(root)) add('Graph · roots', `no source in the pool is on ${root}, so nothing can root a graph there`)
    if (graph.rootSources) for (const id of graph.rootSources) if (!ids.has(id)) add('Graph · roots', `no source '${id}' in the pool`)
    checkConditions('Graph · step test', graph.step, SCOPES.step)
    if (graph.end.when.trim()) {
      const problem = exprProblem(graph.end.when, SCOPES.end)
      if (problem) add('Graph · ends when', problem)
    }
    if (graph.end.watch !== null && !INTERVAL.test(graph.end.watch)) add('Graph · ends when', `not a timeframe: '${graph.end.watch}'`)
    if (graph.end.rootBars !== null && !(graph.end.rootBars >= 1)) add('Graph · ends', 'the root-bar limit is at least 1')
    if (!(graph.lookback.rootBars >= 1) || !(graph.lookback.maxBars >= 1)) add('Graph · history', 'the read bounds are at least one bar')
  }

  // Entries.
  checkConditions('Entries · test', strategy.entry.when, SCOPES.entry)

  // Exits.
  const level = (where: string, value: Level | null, target: boolean): void => {
    if (!value) return
    if (value.kind === 'pips' && !(value.value > 0)) add(where, 'a distance in pips is more than 0')
    if (value.kind === 'atr' && (!(value.mult > 0) || !(value.period >= 1))) add(where, 'an ATR distance needs a multiple over 0 and a period of at least 1')
    if (value.kind === 'r' && !target) add(where, 'only a target is measured in R')
    if (value.kind === 'r' && !(value.mult > 0)) add(where, 'an R multiple is more than 0')
    if (value.kind === 'expr') {
      const problem = exprProblem(value.expr, SCOPES.level)
      if (problem) add(where, problem)
    }
  }
  level('Exits · stop', strategy.exits.stop, false)
  level('Exits · target', strategy.exits.target, true)
  if (strategy.exits.target?.kind === 'r' && !strategy.exits.stop) add('Exits · target', 'an R target needs a stop to measure R by')
  if (strategy.exits.trail) {
    level('Exits · trailing stop', strategy.exits.trail.distance, false)
    if (!strategy.exits.stop && strategy.exits.trail.activateR > 0) add('Exits · trailing stop', 'activating at R needs a stop to measure R by')
  }
  if (strategy.exits.breakevenAtR !== null && !strategy.exits.stop) add('Exits · breakeven', 'breakeven at R needs a stop to measure R by')
  if (strategy.exits.maxBars && !(strategy.exits.maxBars.count >= 1)) add('Exits · time', 'a time limit is at least one bar')

  if (!(strategy.sizing.balance > 0)) add('Sizing', 'the opening balance is more than 0')
  if (strategy.sizing.mode === 'units' && !(strategy.sizing.units > 0)) add('Sizing', 'units are more than 0')
  if (strategy.sizing.mode === 'risk' && !(strategy.sizing.riskPercent > 0)) add('Sizing', 'the risk is more than 0%')
  if (!(strategy.sizing.maxOpen >= 1)) add('Sizing', 'at least one trade may be open')
  if (strategy.outcomes.horizons.some((h) => !(h >= 1))) add('Outcomes', 'a horizon is at least one bar')
  if (strategy.pathInterval !== null && !INTERVAL.test(strategy.pathInterval)) add('Simulation', `not a timeframe: '${strategy.pathInterval}'`)
  return out
}

// -- stored documents -------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A stored strategy, or null when it is not one. Missing sections take their defaults, so a
 * document written before a section existed still reads. */
export function readStrategy(raw: unknown): Strategy | null {
  if (!isRecord(raw) || raw.version !== STRATEGY_VERSION || typeof raw.id !== 'string' || !Array.isArray(raw.sources)) return null
  const base = rank85Strategy(typeof raw.createdAt === 'number' ? raw.createdAt : Date.now())
  const merged = {
    ...base,
    ...raw,
    graph: { ...base.graph, ...(isRecord(raw.graph) ? raw.graph : {}) },
    entry: { ...base.entry, ...(isRecord(raw.entry) ? raw.entry : {}) },
    exits: { ...base.exits, ...(isRecord(raw.exits) ? raw.exits : {}) },
    sizing: { ...base.sizing, ...(isRecord(raw.sizing) ? raw.sizing : {}) },
    outcomes: { ...base.outcomes, ...(isRecord(raw.outcomes) ? raw.outcomes : {}) }
  } as Strategy
  merged.graph.end = { ...base.graph.end, ...(isRecord(merged.graph.end) ? merged.graph.end : {}) }
  merged.graph.lookback = { ...base.graph.lookback, ...(isRecord(merged.graph.lookback) ? merged.graph.lookback : {}) }
  return merged
}
