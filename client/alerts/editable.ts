// THE EDITOR'S SHAPE OF A RULE: always a group at the top, each group one of
//
//   all   every condition holds
//   any   at least one holds
//   none  no condition holds          (`not` over `any` in the stored rule)
//
// so "simple" and "compound" are one editor: a simple rule is a group of one condition, and
// is stored as that one condition. Any stored rule reads back into this shape -- a `not` over
// something other than `any` becomes a `none` group of that one thing, which means the same.
//
// PURE: no DOM. client/alerts/editor.ts draws it.

import { isLeaf } from './rules'
import type { Operand, Rule, RuleLeaf } from './types'

export type GroupMode = 'all' | 'any' | 'none'

export interface GroupNode {
  kind: 'group'
  mode: GroupMode
  terms: EditNode[]
}

export interface LeafNode {
  kind: 'leaf'
  leaf: RuleLeaf
}

export type EditNode = GroupNode | LeafNode

export function group(mode: GroupMode, terms: EditNode[]): GroupNode {
  return { kind: 'group', mode, terms }
}

/** A stored rule as an editable tree, whose root is always a group. */
export function toEditable(rule: Rule): GroupNode {
  const node = toNode(structuredClone(rule))
  return node.kind === 'group' ? node : group('all', [node])
}

function toNode(rule: Rule): EditNode {
  if (isLeaf(rule)) return { kind: 'leaf', leaf: rule }
  if ('all' in rule) return group('all', rule.all.map(toNode))
  if ('any' in rule) return group('any', rule.any.map(toNode))
  const inner = rule.not
  if ('any' in inner) return group('none', inner.any.map(toNode))
  return group('none', [toNode(inner)])
}

/** The tree as a stored rule. A group of one condition is stored as the condition itself (a
 * simple rule), and a `none` of one as a plain `not`. */
export function fromEditable(root: GroupNode): Rule {
  return fromNode(root)
}

function fromNode(node: EditNode): Rule {
  if (node.kind === 'leaf') return structuredClone(node.leaf)
  const terms = node.terms.map(fromNode)
  if (node.mode === 'none') return { not: terms.length === 1 ? terms[0] : { any: terms } }
  if (terms.length === 1) return terms[0]
  return node.mode === 'all' ? { all: terms } : { any: terms }
}

/** The first condition a new alert, or a new row, starts with. */
export function defaultLeaf(interval: string): RuleLeaf {
  return {
    left: { kind: 'indicator', interval, name: 'RSI', params: [14], output: 'rsi1' },
    op: 'crosses_below',
    right: { value: 30 }
  }
}

/** What to compare a series with when the user switches a row from a number to a series: a
 * price against its moving average, anything else against the close. */
export function defaultRightOperand(left: Operand): Operand {
  return left.kind === 'bar'
    ? { kind: 'indicator', interval: left.interval, name: 'MA', params: [20], output: 'ma1' }
    : { kind: 'bar', interval: left.interval, field: 'close' }
}

/** How many conditions a tree holds -- the editor refuses to remove the last one. */
export function leafCount(node: EditNode): number {
  return node.kind === 'leaf' ? 1 : node.terms.reduce((n, term) => n + leafCount(term), 0)
}
