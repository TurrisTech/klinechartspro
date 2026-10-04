// A RULE, AS DATA: the tree the editor builds (./types.ts `Rule`) and what it compiles to.
//
// The rule is NOT evaluated by anything of its own. It compiles to the condition language
// (./conditions.ts) -- the same documents, crossings, tri-state answers and combinators a
// price watch is evaluated by -- plus a table saying how each field of an observation is
// produced:
//
//   left op 30          ->  { field: <left>, op, value: 30 }
//   left op right       ->  { field: '<left> - <right>', op, value: 0 }   (a derived field)
//   left inside [a, b]  ->  { field: <left>, op: 'inside', value: [a, b] }
//   signal is long      ->  { field: <signal>, op: '==', value: 'long' }
//
// Comparing two series through their difference is exact for every operator offered against
// an operand: `a > b` is `a - b > 0`, and `a crosses above b` is `a - b` crossing 0 from below
// -- the language's crossing rule (`before < 0 <= now`) read on the difference.
//
// PURE: no chart, no fetch. The labels an operand reads by come from outside (`Labeller`),
// so this file can be tested without klinecharts.

import { type Condition, ConditionError, OPS, parse } from './conditions'
import type { Operand, Rule, RuleLeaf, RuleRight } from './types'

export class RuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuleError'
  }
}

/** Operators a NUMBER can be compared with, in the order the editor offers them. */
export const NUMERIC_OPS = ['crosses_above', 'crosses_below', 'crosses', '>', '>=', '<', '<=', 'inside', 'outside', 'changed'] as const
/** Operators against another OPERAND: the ones that read the difference's sign. */
export const OPERAND_OPS = ['crosses_above', 'crosses_below', 'crosses', '>', '>=', '<', '<='] as const
/** Operators a signal label can be compared with. */
export const LABEL_OPS = ['==', '!=', 'changed'] as const

export const OP_WORDS: Record<string, string> = {
  crosses_above: 'crosses above',
  crosses_below: 'crosses below',
  crosses: 'crosses',
  '>': '>',
  '>=': '≥',
  '<': '<',
  '<=': '≤',
  inside: 'is inside',
  outside: 'is outside',
  changed: 'changes',
  '==': 'is',
  '!=': 'is not'
}

const MAX_RULE_DEPTH = 6
const INTERVAL = /^(\d+)([smhDWMY])$/

/** An operand's identity -- its field name in an observation, and the key two leaves reading
 * the same thing share. Deterministic, so a rule compiles to the same document every time. */
export function operandKey(operand: Operand): string {
  switch (operand.kind) {
    case 'bar':
      return `bar:${operand.field}@${operand.interval}`
    case 'indicator':
      return `ind:${operand.name}(${operand.params.join(',')}).${operand.output}@${operand.interval}`
    case 'series':
      return `ser:${operand.indicator}.${operand.key}@${operand.interval}`
    case 'signal':
      return `sig:${operand.plugin}/${operand.variant}@${operand.interval}`
  }
}

export function isLeaf(rule: Rule): rule is RuleLeaf {
  return 'left' in rule
}

/** How one field of an observation is produced. */
export type FieldSpec = { kind: 'operand'; key: string } | { kind: 'diff'; a: string; b: string }

export interface CompiledRule {
  condition: Condition
  /** Field name -> how to produce it. */
  fields: Map<string, FieldSpec>
  /** Every operand the rule reads, by key. */
  operands: Map<string, Operand>
}

/** Compile a rule, or throw `RuleError` saying what is wrong with it. Called before anything
 * is stored, so a rule that could never be evaluated is refused when it is written rather
 * than silently never firing. */
export function compile(rule: Rule): CompiledRule {
  const fields = new Map<string, FieldSpec>()
  const operands = new Map<string, Operand>()
  const use = (operand: Operand): string => {
    checkOperand(operand)
    const key = operandKey(operand)
    operands.set(key, operand)
    if (!fields.has(key)) fields.set(key, { kind: 'operand', key })
    return key
  }
  const walk = (node: Rule, depth: number): Condition => {
    if (depth > MAX_RULE_DEPTH) throw new RuleError(`groups nested deeper than ${MAX_RULE_DEPTH}`)
    if (typeof node !== 'object' || node === null) throw new RuleError('a rule must be an object')
    if ('all' in node || 'any' in node) {
      const terms = 'all' in node ? node.all : (node as { any: Rule[] }).any
      if (!Array.isArray(terms) || terms.length === 0) throw new RuleError('a group needs at least one condition')
      const parsed = terms.map((term) => walk(term, depth + 1))
      return 'all' in node ? { all: parsed } : { any: parsed }
    }
    if ('not' in node) return { not: walk(node.not, depth + 1) }
    if (!isLeaf(node)) throw new RuleError('not a condition')
    return leaf(node, use, fields)
  }
  const condition = walk(rule, 0)
  try {
    return { condition: parse(condition), fields, operands }
  } catch (err) {
    throw new RuleError(err instanceof ConditionError ? err.message : String(err))
  }
}

function leaf(node: RuleLeaf, use: (operand: Operand) => string, fields: Map<string, FieldSpec>): Condition {
  const { op, right } = node
  if (!OPS.includes(op)) throw new RuleError(`unknown operator ${JSON.stringify(op)}`)
  const left = use(node.left)

  if (node.left.kind === 'signal') {
    if (!(LABEL_OPS as readonly string[]).includes(op)) throw new RuleError(`a signal is compared with ${LABEL_OPS.join(', ')}`)
    if (op === 'changed') return { field: left, op }
    if (!right || !('label' in right) || !right.label) throw new RuleError('choose which signal')
    return { field: left, op, value: right.label }
  }

  if (op === 'changed') return { field: left, op }
  if (!right) throw new RuleError(`'${OP_WORDS[op] ?? op}' needs something to compare with`)
  if ('operand' in right) {
    if (!(OPERAND_OPS as readonly string[]).includes(op)) throw new RuleError(`'${OP_WORDS[op] ?? op}' compares with a number, not a series`)
    if (right.operand.kind === 'signal') throw new RuleError('a signal can only be compared with its own labels')
    const other = use(right.operand)
    if (other === left) throw new RuleError('a series compared with itself')
    const field = `${left} - ${other}`
    fields.set(field, { kind: 'diff', a: left, b: other })
    return { field, op, value: 0 }
  }
  if (op === 'inside' || op === 'outside') {
    if (!('band' in right)) throw new RuleError(`'${OP_WORDS[op]}' takes a low and a high`)
    return { field: left, op, value: [...right.band] }
  }
  if (!('value' in right) || !Number.isFinite(right.value)) throw new RuleError(`'${OP_WORDS[op] ?? op}' takes a number`)
  if (!(NUMERIC_OPS as readonly string[]).includes(op)) throw new RuleError(`'${OP_WORDS[op] ?? op}' is not offered against a number`)
  return { field: left, op, value: right.value }
}

function checkOperand(operand: Operand): void {
  if (typeof operand !== 'object' || operand === null) throw new RuleError('an operand must be an object')
  if (typeof operand.interval !== 'string' || !INTERVAL.test(operand.interval)) {
    throw new RuleError(`not a timeframe: ${JSON.stringify((operand as { interval?: unknown }).interval)}`)
  }
  switch (operand.kind) {
    case 'bar':
      if (!['open', 'high', 'low', 'close', 'volume'].includes(operand.field)) throw new RuleError(`not a bar field: ${operand.field}`)
      return
    case 'indicator':
      if (!operand.name) throw new RuleError('choose an indicator')
      if (!Array.isArray(operand.params) || !operand.params.every((p) => typeof p === 'number' && Number.isFinite(p))) {
        throw new RuleError(`${operand.name}: its parameters must be numbers`)
      }
      if (!operand.output) throw new RuleError(`${operand.name}: choose which line`)
      return
    case 'series':
      if (!operand.indicator || !operand.key) throw new RuleError('choose a server indicator and its series')
      return
    case 'signal':
      if (!operand.plugin) throw new RuleError('choose a signal')
      return
    default:
      throw new RuleError(`unknown operand kind ${JSON.stringify((operand as { kind?: unknown }).kind)}`)
  }
}

/** Every operand a rule reads, deduplicated by key, in first-use order. Never throws: an
 * unfinished rule in the editor still has operands worth listing. */
export function operandsOf(rule: Rule): Operand[] {
  const seen = new Map<string, Operand>()
  const walk = (node: Rule): void => {
    if ('all' in node) node.all.forEach(walk)
    else if ('any' in node) node.any.forEach(walk)
    else if ('not' in node) walk(node.not)
    else if (isLeaf(node)) {
      seen.set(operandKey(node.left), node.left)
      if (node.right && 'operand' in node.right) seen.set(operandKey(node.right.operand), node.right.operand)
    }
  }
  walk(rule)
  return [...seen.values()]
}

/** The timeframes a rule reads, deduplicated. */
export function intervalsOf(rule: Rule): string[] {
  return [...new Set(operandsOf(rule).map((o) => o.interval))]
}

// -- words -----------------------------------------------------------------------------------

/** How an operand reads in a sentence ("RSI(14)", "AREV21 p"). Supplied by the catalogue,
 * which knows the titles; the fallback here is the operand's own spelling. */
export type Labeller = (operand: Operand) => string

export function plainLabel(operand: Operand): string {
  switch (operand.kind) {
    case 'bar':
      return operand.field
    case 'indicator':
      return `${operand.name}(${operand.params.join(',')})${operand.output ? ` ${operand.output}` : ''}`
    case 'series':
      return `${operand.indicator} ${operand.key}`
    case 'signal':
      return `${operand.variant || operand.plugin} signal`
  }
}

/** One line for a rule: `RSI(14) 1h crosses below 30 and close 1h > EMA(200) 4h`. Groups
 * are bracketed only where they are not the whole rule. */
export function describeRule(rule: Rule, label: Labeller = plainLabel): string {
  const walk = (node: Rule, top: boolean): string => {
    if ('all' in node || 'any' in node) {
      const terms = 'all' in node ? node.all : node.any
      const text = terms.map((t) => walk(t, false)).join('all' in node ? ' and ' : ' or ')
      return top || terms.length === 1 ? text : `(${text})`
    }
    if ('not' in node) return `not ${walk(node.not, false)}`
    return describeLeaf(node, label)
  }
  return walk(rule, true)
}

export function describeLeaf(node: RuleLeaf, label: Labeller = plainLabel): string {
  const left = `${label(node.left)} ${node.left.interval}`
  const words = OP_WORDS[node.op] ?? node.op
  if (node.op === 'changed') return `${left} ${words}`
  return `${left} ${words} ${describeRight(node.right, label)}`
}

function describeRight(right: RuleRight | undefined, label: Labeller): string {
  if (!right) return '…'
  if ('operand' in right) return `${label(right.operand)} ${right.operand.interval}`
  if ('band' in right) return `${right.band[0]}–${right.band[1]}`
  if ('label' in right) return right.label || '…'
  return String(right.value)
}
