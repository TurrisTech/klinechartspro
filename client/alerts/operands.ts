// WHAT EACH KIND OF OPERAND IS, in one table: its identity, how it reads in a sentence, whether its
// values are labels, what makes one malformed, and whether reading it needs the server's catalogue.
// A new kind is one entry here -- the mapped type refuses a table that leaves a kind out -- plus
// what only its own context can say: how it is computed (compute.ts), titled from the catalogue
// (catalogue.ts) and edited (ruletree.ts). Until 2026-11-28 these five facts were five switches and
// two copied conditions across rules.ts, search.ts and monitor.ts.

import { isInterval } from '../time/intervals'
import type { Operand, TimeField } from './types'

type Kind = Operand['kind']
type Of<K extends Kind> = Extract<Operand, { kind: K }>

interface OperandKind<K extends Kind> {
  /** Its identity: its field name in an observation, and the key two leaves reading the same thing
   * share. Deterministic, so a rule compiles to the same document every time. */
  key(operand: Of<K>): string
  /** How it reads in a sentence where the catalogue has no title for it: its own spelling. */
  label(operand: Of<K>): string
  /** Whether its values are labels (a signal's side, a weekday), compared with `is` / `is not`. */
  labels(operand: Of<K>): boolean
  /** What is wrong with it, or null. Every kind's interval is checked before this. */
  problem(operand: Of<K>): string | null
  /** Whether its points come from a server plugin, so reading it needs the catalogue. */
  readsCatalogue: boolean
}

/** What each time field is called. */
export const TIME_FIELD_NAMES: Record<TimeField, string> = { minute: 'time of day', weekday: 'weekday', datetime: 'date and time' }

const isTimeframes = (list: unknown): list is string[] => Array.isArray(list) && list.every((i) => typeof i === 'string' && isInterval(i))

const OPERAND_KINDS: { [K in Kind]: OperandKind<K> } = {
  bar: {
    key: (o) => `bar:${o.field}@${o.interval}`,
    label: (o) => o.field,
    labels: () => false,
    problem: (o) => (['open', 'high', 'low', 'close', 'volume'].includes(o.field) ? null : `not a bar field: ${o.field}`),
    readsCatalogue: false
  },
  indicator: {
    key: (o) => `ind:${o.name}(${o.params.join(',')}).${o.output}@${o.interval}`,
    label: (o) => `${o.name}(${o.params.join(',')})${o.output ? ` ${o.output}` : ''}`,
    labels: () => false,
    problem: (o) => {
      if (!o.name) return 'choose an indicator'
      if (!Array.isArray(o.params) || !o.params.every((p) => typeof p === 'number' && Number.isFinite(p))) return `${o.name}: its parameters must be numbers`
      return o.output ? null : `${o.name}: choose which line`
    },
    readsCatalogue: false
  },
  series: {
    key: (o) => `ser:${o.indicator}.${o.key}@${o.interval}`,
    label: (o) => `${o.indicator} ${o.key}`,
    labels: () => false,
    problem: (o) => (o.indicator && o.key ? null : 'choose a server indicator and its series'),
    readsCatalogue: true
  },
  signal: {
    key: (o) => `sig:${o.plugin}/${o.variant}@${o.interval}`,
    label: (o) => `${o.variant || o.plugin} signal`,
    labels: () => true,
    problem: (o) => (o.plugin ? null : 'choose a signal'),
    readsCatalogue: true
  },
  graph: {
    key: (o) => `graph:${o.overlay}[${o.timeframes.join(',')}|${o.roots.join(',')}|${o.maxStep}]@${o.interval}`,
    label: (o) => `${o.overlay} graph entry`,
    labels: () => true,
    problem: (o) => {
      if (!o.overlay) return 'choose an overlay'
      if (!isTimeframes(o.timeframes) || !isTimeframes(o.roots)) return 'graph timeframes must be timeframes'
      if (!o.timeframes.includes(o.interval)) return `the graph does not read ${o.interval}, so it can have no entry there`
      if (!o.roots.some((root) => o.timeframes.includes(root))) return 'switch on a root timeframe the graph reads'
      return Number.isFinite(o.maxStep) && o.maxStep >= 2 ? null : 'the largest step is at least 2'
    },
    readsCatalogue: false
  },
  time: {
    key: (o) => `time:${o.field}/${o.zone}@${o.interval}`,
    label: (o) => `${TIME_FIELD_NAMES[o.field]} (${o.zone})`,
    labels: (o) => o.field === 'weekday',
    problem: (o) => {
      if (!(o.field in TIME_FIELD_NAMES)) return `not a time field: ${o.field}`
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: o.zone })
      } catch {
        return `not a time zone: ${JSON.stringify(o.zone)}`
      }
      return null
    },
    readsCatalogue: false
  },
  strategy: {
    key: (o) => `strat:${o.strategy}@${o.interval}`,
    label: (o) => `${o.strategy} entry`,
    labels: () => true,
    problem: (o) => (o.strategy ? null : 'choose a saved strategy'),
    readsCatalogue: false
  }
}

/** The table's entry for `operand`'s kind, or undefined for a kind it does not know (a stored
 * rule from a later build, or a malformed one). */
export function operandKind(operand: Operand): OperandKind<Kind> | undefined {
  return (OPERAND_KINDS as Record<string, OperandKind<Kind> | undefined>)[operand.kind]
}

function known(operand: Operand): OperandKind<Kind> {
  const kind = operandKind(operand)
  if (!kind) throw new Error(`unknown operand kind ${JSON.stringify(operand.kind)}`)
  return kind
}

/** An operand's identity (see `OperandKind.key`). */
export function operandKey(operand: Operand): string {
  return known(operand).key(operand)
}

/** Whether an operand's values are labels, compared with `is` / `is not` rather than numbers. An
 * unknown kind's are not. */
export function isLabelOperand(operand: Operand): boolean {
  return operandKind(operand)?.labels(operand) ?? false
}

/** An operand in words, by its own spelling; an unknown kind by its kind. */
export function plainLabel(operand: Operand): string {
  return operandKind(operand)?.label(operand) ?? String(operand.kind)
}

/** Whether reading the operand needs the server's catalogue. An unknown kind does not. */
export function readsCatalogue(operand: Operand): boolean {
  return operandKind(operand)?.readsCatalogue ?? false
}
