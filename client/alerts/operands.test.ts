import { expect, test } from 'bun:test'
import { isLabelOperand, operandKey, plainLabel, readsCatalogue } from './operands'
import type { Operand } from './types'

// One entry per kind; the keys are part of a compiled rule's document, so they must not move.

const operands: Operand[] = [
  { kind: 'bar', interval: '1h', field: 'close' },
  { kind: 'indicator', interval: '4h', name: 'RSI', params: [14], output: 'rsi1' },
  { kind: 'series', interval: '1h', indicator: 'arev21', key: 'p' },
  { kind: 'signal', interval: '5m', plugin: 'mtf', variant: 'arev21' },
  { kind: 'graph', interval: '5m', overlay: 'rank85', timeframes: ['1h', '5m'], roots: ['1h'], maxStep: 3 } as Operand,
  { kind: 'time', interval: '1m', field: 'weekday', zone: 'America/New_York' },
  { kind: 'strategy', interval: '5m', strategy: 's1' }
]

test('every kind keys, reads and labels as it did in the switches', () => {
  expect(operands.map(operandKey)).toEqual([
    'bar:close@1h',
    'ind:RSI(14).rsi1@4h',
    'ser:arev21.p@1h',
    'sig:mtf/arev21@5m',
    'graph:rank85[1h,5m|1h|3]@5m',
    'time:weekday/America/New_York@1m',
    'strat:s1@5m'
  ])
  expect(operands.map(plainLabel)).toEqual(['close', 'RSI(14) rsi1', 'arev21 p', 'arev21 signal', 'rank85 graph entry', 'weekday (America/New_York)', 's1 entry'])
  expect(operands.map(isLabelOperand)).toEqual([false, false, false, true, true, true, true])
  expect(operands.map(readsCatalogue)).toEqual([false, false, true, true, false, false, false])
})

test('a kind this build does not know is no label, needs no catalogue, and has no key', () => {
  const later = { kind: 'orderflow', interval: '1m' } as unknown as Operand
  expect(isLabelOperand(later)).toBe(false)
  expect(readsCatalogue(later)).toBe(false)
  expect(plainLabel(later)).toBe('orderflow')
  expect(() => operandKey(later)).toThrow()
})
