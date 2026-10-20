// A STRATEGY, AS DATA: what the Strategy Lab edits, runs and saves, and what a wall pane or an
// alert names when it reads a strategy's entries.
//
//   sources   the SIGNALS a rule can follow: published signals (arev21_outlier rank, arev21,
//             krev...) and events defined by a rule over indicators
//   rules     the RULES, each one cascade the simple way: one root timeframe, the side of the
//             signals it follows, the shorter timeframes it steps down through, the ones it enters
//             on, and which way its entries trade. Long rules and short rules are separate; each
//             rule is measured on its own as well as with the others
//   exits     stop, target, breakeven, trailing, rule exits, a time limit
//   sizing    the simulated account, its leverage cap included
//   costs     what a trade pays beyond the spread: commission, slippage, overnight financing
//   outcomes  what is measured after every entry
//   holdout   the end of the window kept back: the results show it beside the rest
//
// A rule is the AREV21 outlier rank 85 overlay's graph with ONE root and ONE side (user,
// 2026-10-20: "each root could be its own rule. the longs can be a separate set of rules from the
// shorts"). Built by the slotted graph builder (./graph.ts) from the spec a rule compiles to
// (./rules.ts `ruleGraphSpec`), so a rule at its defaults draws the overlay's graphs of that root
// and side -- `graph.test.ts` holds the builder to the server's own output.
//
// Until 2026-10-20 (STRATEGY_VERSION 1) a strategy held one graph over several roots and both
// sides, with the rules that make several roots share it; `readStrategy` turns such a document
// into its rules (`migrateV1`).
//
// PURE: no fetch, no DOM.

import type { Rule } from '../alerts/types'
import { resolutionDurationMs } from '../periods'
import { COMMON_FUNCTIONS, type ExprScope, exprProblem, type FieldSpec, type FnSpec } from './expr'

export const STRATEGY_VERSION = 2

/** Which way a graph runs: a TOP graph climbs over the price, a BOTTOM one falls under it. */
export type Side = 'top' | 'bottom'
export type Direction = 'long' | 'short'

/** Where a signal sits, read off the candle it was cast on: the body's top (a top signal) or
 * bottom (a bottom one) -- the overlay's choice -- the wick's high or low, or the close. */
export type PriceAnchor = 'body' | 'wick' | 'close'

/** The interval a rule source's operands name to mean "the event's own timeframe": one rule is
 * written once and read on every timeframe a strategy rule follows it on. Never stored in an
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

/** The slotted graph builder's spec (./graph.ts): what a rule compiles to (./rules.ts). A
 * strategy no longer holds one; a version-1 strategy did, over several roots at once. */
export interface GraphSpec {
  /** Off: entries come straight from the events (`entry` reads each one). */
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
  end: GraphEnd
  lookback: Lookback
}

/** When a graph ends before its root switches side. */
export interface GraphEnd {
  /** After this many bars of the root's timeframe. */
  rootBars: number | null
  /** At the first close of `watch` where this holds (END scope). Empty: never. */
  when: string
  /** The timeframe `when` is read at; null for the rule's shortest. */
  watch: string | null
}

/** How far back a root is read for the graph in force at the window's start, in its own bars, and
 * the most any other timeframe reaches back -- read bounds, not rules. */
export interface Lookback {
  rootBars: number
  maxBars: number
}

/**
 * ONE RULE: the graphs that grow from one root timeframe's signals of one side, the entries they
 * produce, and which way those trade. With no step timeframes it has no graph: every signal of its
 * side on the root timeframe is an entry (an indicator event, say).
 */
export interface StrategyRule {
  /** Unique in the strategy; what an entry names its rule by. */
  id: string
  enabled: boolean
  /** Which way its entries trade. */
  direction: Direction
  /** The id of the source (`sources`) whose signals it follows. */
  source: string
  /** The side of the signals it follows. By default a rule trades AGAINST them (user,
   * 2026-10-15): a long rule follows bottoms, a short rule tops (`followsFor`). */
  follows: Side
  /** The timeframe its graphs start from. */
  root: string
  /** The shorter timeframes a graph steps down through. Empty: no graph. */
  steps: string[]
  /** Of `steps`, the timeframes whose signals are entries (with no steps: the root). */
  entryOn: string[]
  /** A step goes to a timeframe at most this many times shorter than its parent's; null: any. */
  maxStep: number | null
  /** Every node goes beyond every node before it (the overlay); off: beyond its parent only. */
  reach: boolean
  /** Read at the entry instant; null for none. An alert rule, operands on any timeframe. */
  filter: Rule | null
  end: GraphEnd
  parent: ParentRule
  rootJoin: RootJoin
  /** Further conditions, all of which must hold, written in the expression language: on a step
   * (STEP scope), on an entry (ENTRY scope). */
  stepIf: SlotCondition[]
  entryIf: SlotCondition[]
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
  /** A position is cut to at most this multiple of the balance in notional (units x price, in
   * the quote currency); null for no cap. OANDA's retail limit on the majors is 50. Risk sizing
   * on a stop of a pip or two otherwise opens ~60:1. */
  maxLeverage: number | null
}

/** What a trade pays beyond the bid/ask spread the fill engine already charges. */
export interface CostSpec {
  /** Quote currency per million units, on each side (OANDA quotes commission per million). */
  commission: number
  /** Pips worse on every fill that is not a limit: the market entry, a stop, a rule or time exit.
   * A target is a limit and fills at its price. */
  slippagePips: number
  /** Percent a year of the notional, charged at each daily close a trade is held through, for
   * the calendar days until the next close (so a Friday close carries the weekend). Positive
   * pays, negative earns; null for none. OANDA books the FX weekend on Wednesday instead -- the
   * same total over any whole week. */
  financing: { long: number; short: number } | null
}

/** The end of the window held back from fitting: the last `percent` of it, or from an instant.
 * Everything runs over the whole window; the results show the two parts side by side. */
export type HoldoutSpec = { kind: 'percent'; percent: number } | { kind: 'from'; at: number }

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
  rules: StrategyRule[]
  lookback: Lookback
  exits: ExitSpec
  sizing: Sizing
  costs: CostSpec
  outcomes: OutcomeSpec
  holdout: HoldoutSpec | null
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

/** The overlay's step test, one condition per rule it states (the server's `can_step`). A rule's
 * own test is these with its `maxStep` (./rules.ts); the graph builder's tests read them. */
export function defaultStep(maxStep = 8): SlotCondition[] {
  return [
    { id: 'further', label: "goes further its graph's way", expr: '(child.price - parent.price) * dir > 0', enabled: true },
    { id: 'lower', label: 'on the same or a lower timeframe', expr: 'child.tf <= parent.tf', enabled: true },
    { id: 'maxstep', label: `at most ${maxStep}× shorter`, expr: `parent.tf <= child.tf * ${maxStep}`, enabled: true }
  ]
}

/** The overlay's entry: a step (not a root) on 5m or shorter (the server's `is_entry`). */
export function defaultGraphEntry(): SlotCondition[] {
  return [
    { id: 'step', label: 'a step, not a root', expr: 'not node.is_root', enabled: true },
    { id: 'short', label: 'on 5m or shorter', expr: "node.tf <= tf('5m')", enabled: true }
  ]
}

/** The timeframes the outlier overlays read (mtf/api.ts MTF_INTERVALS). */
export const RANK_TIMEFRAMES = ['3m', '5m', '15m', '20m', '30m', '1h', '2h', '4h', '8h', '1D']

/** The overlay's roots, longest first: what "+ Long rule" offers in turn. */
export const ROOT_TIMEFRAMES = ['1D', '8h', '4h', '2h', '1h']

/** The longest timeframe the overlay enters on: its stars are 5m and 3m steps. */
const ENTRY_LONGEST = '5m'

export function rank85Source(): PublishedSource {
  return {
    kind: 'published',
    id: 'rank85',
    title: 'AREV21 outlier rank 85',
    plugin: 'arev21_outlier',
    variant: 'arev21_outlier_rank',
    // The overlay's params, in the registry's order (mtf/overlays.ts `outlierRankMtf`).
    params: { bars: 200, q: 0.85, samples_only: 0 },
    sides: { long: 'top', short: 'bottom' },
    price: 'body'
  }
}

/** The graph builder's spec at the overlay's settings, on the 1D root (./graph.ts's tests). */
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
    end: defaultEnd(),
    lookback: defaultLookback()
  }
}

export function defaultEnd(): GraphEnd {
  return { rootBars: null, when: '', watch: null }
}

/** How far back the lab READS, in the browser: 300 root bars to find a run's start, 10,000 of each
 * lower timeframe's bars. The server reads every run whole; a run longer than these is cut here
 * (the overlay's own bounds until wdashboard-server 0.56.0). */
export function defaultLookback(): Lookback {
  return { rootBars: 300, maxBars: 10_000 }
}

/** Timeframes shortest first, each once. */
export function byLength(codes: Iterable<string>): string[] {
  return [...new Set(codes)].sort((a, b) => resolutionDurationMs(a) - resolutionDurationMs(b))
}

/** The side a rule of `direction` follows by default: AGAINST the signal (user, 2026-10-15) -- a
 * long buys into bottoms, a short sells into tops. */
export function followsFor(direction: Direction): Side {
  return direction === 'long' ? 'bottom' : 'top'
}

/** The timeframes a rule on `root` may step through, of those `offered`: every shorter one. */
export function stepsBelow(root: string, offered: readonly string[]): string[] {
  const rootMs = resolutionDurationMs(root)
  return byLength(offered).filter((tf) => resolutionDurationMs(tf) < rootMs)
}

/** Where a rule over `steps` enters by default: the overlay's, every step on 5m or shorter -- or
 * its shortest step when it has none that short, or its root when it has no steps. */
export function defaultEntryOn(root: string, steps: readonly string[]): string[] {
  if (steps.length === 0) return [root]
  const short = steps.filter((tf) => resolutionDurationMs(tf) <= resolutionDurationMs(ENTRY_LONGEST))
  return short.length > 0 ? byLength(short) : [byLength(steps)[0]]
}

/** A rule at the overlay's settings: from `root`, through every shorter timeframe `offered`,
 * entering on the overlay's, and trading against the signal. */
export function defaultRule(direction: Direction, root: string, offered: readonly string[], source: string, id: string): StrategyRule {
  const steps = stepsBelow(root, offered)
  return {
    id,
    enabled: true,
    direction,
    source,
    follows: followsFor(direction),
    root,
    steps,
    entryOn: defaultEntryOn(root, steps),
    maxStep: 8,
    reach: true,
    filter: null,
    end: defaultEnd(),
    parent: 'supersede',
    rootJoin: 'join',
    stepIf: [],
    entryIf: []
  }
}

/** A rule id not yet used in `strategy`. */
export function newRuleId(strategy: Pick<Strategy, 'rules'>, direction: Direction, root: string): string {
  const used = new Set(strategy.rules.map((r) => r.id))
  const base = `${direction}${root}`
  if (!used.has(base)) return base
  for (let k = 2; ; k++) if (!used.has(`${base}_${k}`)) return `${base}_${k}`
}

/** What the page calls a rule: "Long · 1D", and "Long · 1D #2" for a second one like it. */
export function ruleLabel(strategy: Pick<Strategy, 'rules'>, rule: StrategyRule): string {
  const base = `${rule.direction === 'long' ? 'Long' : 'Short'} · ${rule.root}`
  const alike = strategy.rules.filter((r) => r.direction === rule.direction && r.root === rule.root)
  const k = alike.indexOf(rule)
  return k > 0 ? `${base} #${k + 1}` : base
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
  return { balance: 100_000, mode: 'risk', units: 10_000, riskPercent: 1, maxOpen: 1, maxLeverage: 50 }
}

export function defaultCosts(): CostSpec {
  return { commission: 0, slippagePips: 0, financing: null }
}

export function defaultOutcomes(): OutcomeSpec {
  return { horizons: [1, 3, 12, 48], touches: [0.5, 1, 2], atrPeriod: 14 }
}

let counter = 0
export function newStrategyId(now = Date.now()): string {
  counter += 1
  return `st${now.toString(36)}${counter.toString(36)}`
}

/** The AREV21 outlier rank 85 overlay's graph from its 1D root, as two rules: a long one that
 * follows the bottoms and a short one that follows the tops -- every rule at the overlay's own
 * setting, so together they draw the overlay's 1D graphs. Each trades AGAINST its signal (user,
 * 2026-10-15): a top -- a `long` label -- is sold, a bottom bought. */
export function rank85Strategy(now = Date.now()): Strategy {
  return {
    version: STRATEGY_VERSION,
    id: newStrategyId(now),
    name: 'AREV21 rank 85 rules',
    notes: '',
    instrument: 'oanda:EURUSD',
    window: { kind: 'days', days: 30 },
    sources: [rank85Source()],
    rules: [defaultRule('long', '1D', RANK_TIMEFRAMES, 'rank85', 'long1D'), defaultRule('short', '1D', RANK_TIMEFRAMES, 'rank85', 'short1D')],
    lookback: defaultLookback(),
    exits: defaultExits(),
    sizing: defaultSizing(),
    costs: defaultCosts(),
    outcomes: defaultOutcomes(),
    holdout: null,
    pathInterval: null,
    createdAt: now,
    updatedAt: now
  }
}

/** A strategy with no graph: an indicator event straight to an entry, one rule each way. */
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
        top: { left: { kind: 'indicator', interval: SELF_INTERVAL, name: 'RSI', params: [14], output: 'rsi1' }, op: 'crosses_below', right: { value: 70 } },
        bottom: { left: { kind: 'indicator', interval: SELF_INTERVAL, name: 'RSI', params: [14], output: 'rsi1' }, op: 'crosses_above', right: { value: 30 } },
        price: 'close'
      }
    ],
    rules: [defaultRule('long', '1h', [], 'rsi', 'long1h'), defaultRule('short', '1h', [], 'rsi', 'short1h')]
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

  // The signals.
  if (strategy.sources.length === 0) add('Signals', 'there are no signals: add a published signal or a rule event')
  const ids = new Set<string>()
  for (const source of strategy.sources) {
    const where = `Signals · ${source.title || source.id}`
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(source.id)) add(where, `an id is a letter then letters, digits or _ (not '${source.id}')`)
    if (ids.has(source.id)) add(where, `two sources are called '${source.id}'`)
    ids.add(source.id)
    if (source.kind === 'published') {
      if (!source.plugin) add(where, 'choose a signal')
      if (Object.keys(source.sides).length === 0) add(where, 'map at least one label to a side')
      for (const [name, value] of Object.entries(source.params)) if (!Number.isFinite(value)) add(where, `parameter ${name} is not a number`)
    } else if (!source.top && !source.bottom) add(where, 'write a rule for tops, bottoms or both')
  }

  // The rules: each one checked by its own name, so a problem takes the page to its card.
  if (!strategy.rules.some((r) => r.enabled)) add('Rules', 'switch on at least one rule')
  const ruleIds = new Set<string>()
  for (const rule of strategy.rules) {
    const name = ruleLabel(strategy, rule)
    if (ruleIds.has(rule.id)) add(name, `two rules are called '${rule.id}'`)
    ruleIds.add(rule.id)
    if (!rule.enabled) continue
    const checkConditions = (slot: string, conditions: SlotCondition[], scope: SlotScope): void => {
      conditions.forEach((condition, i) => {
        if (!condition.enabled) return
        const problem = exprProblem(condition.expr, scope)
        if (problem) add(`${name} · ${slot} ${i + 1}`, problem)
      })
    }
    if (!ids.has(rule.source)) add(`${name} · signal`, `no signal '${rule.source}' in Signals`)
    if (!INTERVAL.test(rule.root)) add(`${name} · root`, `not a timeframe: '${rule.root}'`)
    const rootMs = resolutionDurationMs(rule.root)
    for (const tf of rule.steps) {
      if (!INTERVAL.test(tf)) add(`${name} · steps`, `not a timeframe: '${tf}'`)
      else if (!(resolutionDurationMs(tf) < rootMs)) add(`${name} · steps`, `${tf} is not shorter than the root, ${rule.root}`)
    }
    const enterable = rule.steps.length > 0 ? rule.steps : [rule.root]
    if (rule.entryOn.length === 0) add(`${name} · entries`, 'choose the timeframes it enters on')
    for (const tf of rule.entryOn) if (!enterable.includes(tf)) add(`${name} · entries`, rule.steps.length > 0 ? `${tf} is not one of the timeframes it steps through` : `with no steps it enters on its root, ${rule.root}`)
    if (rule.maxStep !== null && !(rule.maxStep >= 1)) add(`${name} · steps`, 'a step is at most 1× shorter or more')
    checkConditions('step condition', rule.stepIf, SCOPES.step)
    checkConditions('entry condition', rule.entryIf, SCOPES.entry)
    if (rule.end.when.trim()) {
      const problem = exprProblem(rule.end.when, SCOPES.end)
      if (problem) add(`${name} · ends when`, problem)
    }
    if (rule.end.watch !== null && !INTERVAL.test(rule.end.watch)) add(`${name} · ends when`, `not a timeframe: '${rule.end.watch}'`)
    if (rule.end.rootBars !== null && !(rule.end.rootBars >= 1)) add(`${name} · ends`, 'the root-bar limit is at least 1')
  }
  if (!(strategy.lookback.rootBars >= 1) || !(strategy.lookback.maxBars >= 1)) add('Simulation', 'the read bounds are at least one bar')

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
  if (strategy.sizing.maxLeverage !== null && !(strategy.sizing.maxLeverage > 0)) add('Sizing', 'the leverage cap is more than 0')
  if (!(strategy.costs.commission >= 0)) add('Costs', 'commission is 0 or more')
  if (!(strategy.costs.slippagePips >= 0)) add('Costs', 'slippage is 0 or more pips')
  const financing = strategy.costs.financing
  if (financing && (!Number.isFinite(financing.long) || !Number.isFinite(financing.short))) add('Costs', 'a financing rate is not a number')
  const holdout = strategy.holdout
  if (holdout?.kind === 'percent' && !(holdout.percent > 0 && holdout.percent < 100)) add('Window', 'the holdout is between 0 and 100% of the window')
  if (holdout?.kind === 'from' && !Number.isFinite(holdout.at)) add('Window', 'the holdout has no start')
  if (strategy.outcomes.horizons.some((h) => !(h >= 1))) add('Outcomes', 'a horizon is at least one bar')
  if (strategy.pathInterval !== null && !INTERVAL.test(strategy.pathInterval)) add('Simulation', `not a timeframe: '${strategy.pathInterval}'`)
  return out
}

// -- stored documents -------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A stored strategy, or null when it is not one. Missing sections take their defaults, so a
 * document written before a section existed still reads; a version-1 document becomes rules
 * (`migrateV1`). */
export function readStrategy(input: unknown): Strategy | null {
  if (!isRecord(input) || typeof input.id !== 'string' || !Array.isArray(input.sources)) return null
  const raw = input.version === 1 ? migrateV1(input) : input
  if (raw.version !== STRATEGY_VERSION || !Array.isArray(raw.rules)) return null
  const base = rank85Strategy(typeof raw.createdAt === 'number' ? raw.createdAt : Date.now())
  const ruleBase = defaultRule('long', '1D', RANK_TIMEFRAMES, 'rank85', 'rule')
  const rules = (raw.rules as unknown[]).filter(isRecord).map((r) => {
    const rule = { ...ruleBase, follows: followsFor(r.direction === 'short' ? 'short' : 'long'), ...r } as StrategyRule
    rule.end = { ...defaultEnd(), ...(isRecord(r.end) ? r.end : {}) }
    return rule
  })
  return {
    ...base,
    ...raw,
    rules,
    lookback: { ...base.lookback, ...(isRecord(raw.lookback) ? raw.lookback : {}) },
    exits: { ...base.exits, ...(isRecord(raw.exits) ? raw.exits : {}) },
    sizing: { ...base.sizing, ...(isRecord(raw.sizing) ? raw.sizing : {}) },
    costs: { ...base.costs, ...(isRecord(raw.costs) ? raw.costs : {}) },
    outcomes: { ...base.outcomes, ...(isRecord(raw.outcomes) ? raw.outcomes : {}) },
    holdout: isRecord(raw.holdout) ? (raw.holdout as HoldoutSpec) : null
  } as Strategy
}

/**
 * A version-1 strategy -- one graph over several roots and both sides -- as rules: one per root
 * and side, each with the graph's settings. Its sources' timeframes become each rule's steps (the
 * pool's timeframes shorter than its root); its step and entry tests become a rule's own fields
 * where they are the overlay's presets (the 8 of `parent.tf <= child.tf * 8` its `maxStep`,
 * `node.tf <= tf('5m')` its entries on 5m and shorter) and its extra conditions otherwise.
 *
 * One thing has no rule: a version-1 graph with several roots let a signal stepping in a longer
 * root's graph root nothing in a shorter one (`takenDontRoot`). Rules are independent, so a 1h rule
 * now also roots where a 1D rule is stepping -- the point of splitting them.
 */
export function migrateV1(raw: Record<string, unknown>): Record<string, unknown> {
  const graph = isRecord(raw.graph) ? raw.graph : {}
  const entry = isRecord(raw.entry) ? raw.entry : {}
  const sources = (raw.sources as unknown[]).filter(isRecord)
  const tfsOf = (source: Record<string, unknown>): string[] => (Array.isArray(source.timeframes) ? source.timeframes.filter((t): t is string => typeof t === 'string') : [])
  const pool = byLength(sources.flatMap(tfsOf))
  const direction: Record<Side, Direction> = { top: 'short', bottom: 'long' }
  if (isRecord(entry.direction)) for (const side of ['top', 'bottom'] as const) if (entry.direction[side] === 'long' || entry.direction[side] === 'short') direction[side] = entry.direction[side]
  const rootSources = Array.isArray(graph.rootSources) ? graph.rootSources.filter((x): x is string => typeof x === 'string') : null
  const sourceFor = (tf: string): string => {
    const onIt = sources.filter((s) => tfsOf(s).includes(tf) && (!rootSources || rootSources.includes(String(s.id))))
    return String((onIt[0] ?? sources[0])?.id ?? 'rank85')
  }

  // The step test: the presets become fields, anything else a condition of the rule's own.
  const conditions = (value: unknown, fallback: SlotCondition[]): SlotCondition[] => (Array.isArray(value) ? (value.filter(isRecord) as unknown as SlotCondition[]) : fallback)
  const step = conditions(graph.step, defaultStep())
  let maxStep: number | null = null
  const stepIf: SlotCondition[] = []
  for (const c of step) {
    if (!c.enabled) continue
    const expr = c.expr.trim()
    if (expr === '(child.price - parent.price) * dir > 0' || expr === 'child.tf <= parent.tf') continue
    const max = /^parent\.tf <= child\.tf \* (\d+(?:\.\d+)?)$/.exec(expr)
    if (max && maxStep === null) maxStep = Number(max[1])
    else stepIf.push({ ...c })
  }
  const when = conditions(entry.when, defaultGraphEntry())
  let shortOnly = false
  const entryIf: SlotCondition[] = []
  for (const c of when) {
    if (!c.enabled) continue
    const expr = c.expr.trim()
    if (expr === 'not node.is_root') continue
    if (expr === "node.tf <= tf('5m')") shortOnly = true
    else entryIf.push({ ...c })
  }

  const enabled = graph.enabled !== false
  const roots = enabled ? byLength(Array.isArray(graph.roots) ? graph.roots.filter((x): x is string => typeof x === 'string') : ['1D']).reverse() : pool
  const end = { ...defaultEnd(), ...(isRecord(graph.end) ? graph.end : {}) } as GraphEnd
  const rules: StrategyRule[] = []
  for (const root of roots) {
    for (const side of ['bottom', 'top'] as const) {
      const steps = enabled ? stepsBelow(root, pool) : []
      const entryOn = !enabled || steps.length === 0 ? [root] : shortOnly ? defaultEntryOn(root, steps) : steps
      const dir = direction[side]
      rules.push({
        id: `${dir}${root}${rules.some((r) => r.id === `${dir}${root}`) ? `_${side}` : ''}`,
        enabled: true,
        direction: dir,
        source: sourceFor(root),
        follows: side,
        root,
        steps,
        entryOn,
        maxStep,
        reach: graph.reach !== false,
        filter: (entry.filter as Rule | null | undefined) ?? null,
        end: { ...end },
        parent: (graph.parent as ParentRule | undefined) ?? 'supersede',
        rootJoin: (graph.rootJoin as RootJoin | undefined) ?? 'join',
        stepIf: stepIf.map((c) => ({ ...c })),
        entryIf: entryIf.map((c) => ({ ...c }))
      })
    }
  }
  const { graph: _graph, entry: _entry, ...rest } = raw
  return {
    ...rest,
    version: STRATEGY_VERSION,
    sources: sources.map(({ timeframes: _t, ...source }) => source),
    rules,
    lookback: { ...defaultLookback(), ...(isRecord(graph.lookback) ? graph.lookback : {}) }
  }
}
