import { describe, expect, test } from 'bun:test'
import { evaluate } from './conditions'
import { compile, describeRule, intervalsOf, operandKey, operandsOf, RuleError } from './rules'
import type { Operand, Rule } from './types'

const rsi: Operand = { kind: 'indicator', interval: '1h', name: 'RSI', params: [14], output: 'rsi1' }
const close: Operand = { kind: 'bar', interval: '1h', field: 'close' }
const ema: Operand = { kind: 'indicator', interval: '4h', name: 'EMA', params: [200], output: 'ema1' }
const arev: Operand = { kind: 'signal', interval: '4h', plugin: 'arev', variant: 'arev21' }

describe('compile', () => {
  test('a number comparison is one leaf on the operand', () => {
    const { condition, fields } = compile({ left: rsi, op: 'crosses_below', right: { value: 30 } })
    expect(condition).toEqual({ field: operandKey(rsi), op: 'crosses_below', value: 30 })
    expect(fields.get(operandKey(rsi))).toEqual({ kind: 'operand', key: operandKey(rsi) })
  })

  test('two operands compare through their difference against 0', () => {
    const { condition, fields } = compile({ left: close, op: 'crosses_above', right: { operand: ema } })
    const field = `${operandKey(close)} - ${operandKey(ema)}`
    expect(condition).toEqual({ field, op: 'crosses_above', value: 0 })
    expect(fields.get(field)).toEqual({ kind: 'diff', a: operandKey(close), b: operandKey(ema) })
  })

  test('the difference crosses exactly when the two series do', () => {
    const { condition } = compile({ left: close, op: 'crosses_above', right: { operand: ema } })
    const field = `${operandKey(close)} - ${operandKey(ema)}`
    // close went from under the EMA to over it
    expect(evaluate(condition, { [field]: { value: 0.2 } }, { [field]: { value: -0.1 } })).toBe(true)
    // already over it
    expect(evaluate(condition, { [field]: { value: 0.2 } }, { [field]: { value: 0.1 } })).toBe(false)
    // touching from below counts, as the crossing rule says (before < 0 <= now)
    expect(evaluate(condition, { [field]: { value: 0 } }, { [field]: { value: -0.1 } })).toBe(true)
  })

  test('a group compiles to the language combinators', () => {
    const rule: Rule = { all: [{ left: rsi, op: '<', right: { value: 30 } }, { not: { left: arev, op: '==', right: { label: 'short' } } }] }
    expect(compile(rule).condition).toEqual({
      all: [
        { field: operandKey(rsi), op: '<', value: 30 },
        { not: { field: operandKey(arev), op: '==', value: 'short' } }
      ]
    })
  })

  test('a band and a change', () => {
    expect(compile({ left: rsi, op: 'inside', right: { band: [70, 30] } }).condition).toEqual({ field: operandKey(rsi), op: 'inside', value: [30, 70] })
    expect(compile({ left: arev, op: 'changed' }).condition).toEqual({ field: operandKey(arev), op: 'changed' })
  })

  test('refuses what could never be evaluated, when it is written', () => {
    const refused: Rule[] = [
      { all: [] },
      { left: rsi, op: 'crosses_below' },
      { left: rsi, op: 'inside', right: { operand: close } },
      { left: rsi, op: '>', right: { operand: rsi } },
      { left: arev, op: '>', right: { value: 1 } },
      { left: arev, op: '==', right: { label: '' } },
      { left: close, op: '>', right: { operand: arev } },
      { left: { ...rsi, interval: 'hourly' }, op: '>', right: { value: 1 } },
      { left: { ...rsi, params: [Number.NaN] }, op: '>', right: { value: 1 } },
      { left: rsi, op: 'nonsense', right: { value: 1 } }
    ]
    for (const rule of refused) expect(() => compile(rule)).toThrow(RuleError)
  })
})

describe('reading a rule', () => {
  const rule: Rule = {
    any: [
      { all: [{ left: rsi, op: 'crosses_below', right: { value: 30 } }, { left: close, op: '>', right: { operand: ema } }] },
      { left: arev, op: '==', right: { label: 'long' } }
    ]
  }

  test('operands and timeframes, deduplicated', () => {
    expect(operandsOf(rule).map(operandKey)).toEqual([rsi, close, ema, arev].map(operandKey))
    expect(intervalsOf(rule).sort()).toEqual(['1h', '4h'])
  })

  test('one sentence, bracketing only the inner groups', () => {
    expect(describeRule(rule)).toBe(
      '(RSI(14) rsi1 1h crosses below 30 and close 1h > EMA(200) ema1 4h) or arev21 signal 4h is long'
    )
  })
})
