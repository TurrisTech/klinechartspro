// A RULE, AS THE GRAPH BUILDER READS IT. A strategy's rule (model.ts `StrategyRule`) is the rank 85
// overlay's graph with one root and one side; the slotted builder (./graph.ts) builds a root's
// graphs from a spec, so a rule is compiled to one:
//
//   rule                       spec
//   ------------------------   ------------------------------------------------------------------
//   root                       roots: [root], rooted by the rule's source only
//   follows                    the graphs of that side are the rule's; the root's other-side
//                              signals are still read -- a side switch is what ends a graph
//   steps                      the signals a graph may take: the root's and the steps'
//   maxStep                    the overlay's step test: further, the same or a lower timeframe,
//                              at most `maxStep`× shorter -- plus the rule's own `stepIf`
//   entryOn                    the entry test: a node on one of those timeframes -- plus `entryIf`
//   reach, parent, rootJoin,   as they are
//   end
//
// With no steps a rule has no graph: its entries are its side's signals on the root, each read by
// `entryIf` alone (./entries.ts `entriesOfEvents`).
//
// PURE.

import { resolutionDurationMs } from '../periods'
import type { LabSignal } from './graph'
import { defaultStep, type GraphSpec, type Lookback, type SlotCondition, type StrategyRule } from './model'

/** The graph builder's spec for `rule`. */
export function ruleGraphSpec(rule: StrategyRule, lookback: Lookback): GraphSpec {
  const preset = defaultStep(rule.maxStep ?? 8).filter((c) => rule.maxStep !== null || c.id !== 'maxstep')
  return {
    enabled: rule.steps.length > 0,
    roots: [rule.root],
    rootSources: [rule.source],
    rootJoin: rule.rootJoin,
    // One root per rule: nothing else roots alongside it.
    takenDontRoot: false,
    reach: rule.reach,
    parent: rule.parent,
    step: [...preset, ...rule.stepIf],
    end: rule.end,
    lookback
  }
}

/** The entry test for `rule`: a node on one of its entry timeframes, and its own conditions. */
export function ruleEntryTest(rule: StrategyRule): SlotCondition[] {
  const on = rule.entryOn.map((tf) => `node.tf == tf('${tf}')`).join(' or ')
  return [{ id: 'entryOn', label: `on ${rule.entryOn.join(' or ') || 'no timeframe'}`, expr: on || 'false', enabled: true }, ...rule.entryIf]
}

/** Every timeframe `rule` reads its source on: the root, then the steps. */
export function ruleTimeframes(rule: StrategyRule): string[] {
  return [rule.root, ...rule.steps.filter((tf) => tf !== rule.root)]
}

/** The signals of the pool `rule` builds from: its source's on the root (both sides: a side switch
 * ends a graph) and its side's on the steps. */
export function ruleSignals(rule: StrategyRule, signals: readonly LabSignal[]): LabSignal[] {
  const steps = new Set(rule.steps)
  return signals.filter((s) => s.source === rule.source && (s.interval === rule.root || (steps.has(s.interval) && s.side === rule.follows)))
}

/** The timeframe a rule's end condition is read at: its own choice, else its shortest. */
export function ruleWatchInterval(rule: StrategyRule): string {
  if (rule.end.watch) return rule.end.watch
  return [...ruleTimeframes(rule)].sort((a, b) => resolutionDurationMs(a) - resolutionDurationMs(b))[0]
}
