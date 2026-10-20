// WHAT AN EDIT CHANGED, in the editor's words: "Long · 1D · steps", "Exits · stop". The run
// history (./runs.ts) says this beside each run, so a list of runs reads as a list of experiments
// rather than of timestamps.
//
// PURE.

import { ruleLabel, type Strategy } from './model'

/** A rule's fields, in the editor's words. */
const RULE_WORDS: Record<string, string> = {
  enabled: 'on/off',
  direction: 'direction',
  source: 'signal',
  follows: 'follows',
  root: 'root',
  steps: 'steps',
  entryOn: 'entries',
  maxStep: 'longest step',
  reach: 'beyond all before',
  filter: 'only when',
  end: 'ends',
  parent: 'hangs from',
  rootJoin: 'same-side root',
  stepIf: 'step conditions',
  entryIf: 'entry conditions'
}

/** The dotted paths at which two JSON values differ (an array by index), down to a leaf. */
function diffPaths(a: unknown, b: unknown, path: string, out: string[]): void {
  if (a === b) return
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) diffPaths(a[k], b[k], path ? `${path}.${k}` : k, out)
    return
  }
  out.push(path)
}

/** Where a path is, in the editor's words; null for what is not the strategy's substance. */
function placeOf(path: string, strategy: Strategy): string | null {
  const [head, second, third, fourth] = path.split('.')
  switch (head) {
    case 'name':
    case 'notes':
    case 'id':
    case 'createdAt':
    case 'updatedAt':
    case 'version':
      return null
    case 'instrument':
      return 'Instrument'
    case 'window':
      return 'Window'
    case 'holdout':
      return 'Holdout'
    case 'pathInterval':
      return 'Simulation · path bars'
    case 'sources': {
      const source = strategy.sources[Number(second)]
      const name = source ? source.title || source.id : `source ${Number(second) + 1}`
      if (third === 'params' && fourth) return `Signals · ${name} · ${fourth}`
      return `Signals · ${name}`
    }
    case 'rules': {
      const rule = strategy.rules[Number(second)]
      if (!rule) return 'Rules'
      const name = ruleLabel(strategy, rule)
      return third === undefined ? name : `${name} · ${RULE_WORDS[third] ?? third}`
    }
    case 'lookback':
      return 'Simulation · read bounds'
    case 'exits':
      return `Exits · ${second === 'maxBars' ? 'time limit' : second === 'breakevenAtR' ? 'breakeven' : second === 'onOpposite' ? 'opposite entry' : second === 'ruleLong' || second === 'ruleShort' ? 'exit rule' : (second ?? '')}`
    case 'sizing':
      return second === 'maxLeverage' ? 'Account · leverage cap' : 'Account'
    case 'costs':
      return `Costs · ${second === 'slippagePips' ? 'slippage' : (second ?? '')}`
    case 'outcomes':
      return 'Outcomes'
    default:
      return head
  }
}

/** What `next` changed from `prev`, each place once, in the strategy's order. */
export function strategyChanges(prev: Strategy, next: Strategy): string[] {
  const paths: string[] = []
  diffPaths(prev, next, '', paths)
  const out: string[] = []
  for (const p of paths) {
    const place = placeOf(p, next.sources.length >= prev.sources.length ? next : prev)
    if (place && !out.includes(place)) out.push(place)
  }
  return out
}

/** The changes in a line: the first few, then how many more. */
export function describeChanges(changes: readonly string[], most = 3): string {
  if (changes.length === 0) return 'no change'
  const shown = changes.slice(0, most).join(', ')
  return changes.length > most ? `${shown} and ${changes.length - most} more` : shown
}
