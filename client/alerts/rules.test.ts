import { describe, expect, test } from 'bun:test'
import { evaluate } from './conditions'
import { compile, describeRule, formatMinute, intervalsOf, operandKey, operandsOf, RuleError } from './rules'
import { ANY_LABEL, type Operand, type Rule } from './types'

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

describe('graph entries and the clock', () => {
  const entry: Operand = { kind: 'graph', interval: '5m', overlay: 'mtf_arev21_outlier_rank_85', timeframes: ['3m', '5m', '1h', '1D'], roots: ['1D'], maxStep: 8 }
  const nyMinute: Operand = { kind: 'time', interval: '5m', field: 'minute', zone: 'America/New_York' }
  const weekday: Operand = { kind: 'time', interval: '5m', field: 'weekday', zone: 'America/New_York' }

  test('"is any side" is "is not the empty label"', () => {
    expect(compile({ left: entry, op: '==', right: { label: ANY_LABEL } }).condition).toEqual({ field: operandKey(entry), op: '!=', value: '' })
    expect(compile({ left: entry, op: '!=', right: { label: ANY_LABEL } }).condition).toEqual({ field: operandKey(entry), op: '==', value: '' })
    expect(compile({ left: entry, op: '==', right: { label: 'top' } }).condition).toEqual({ field: operandKey(entry), op: '==', value: 'top' })
  })

  test('a time of day compares as minutes; a weekday as a label', () => {
    expect(compile({ left: nyMinute, op: 'inside', right: { band: [480, 660] } }).condition).toEqual({ field: operandKey(nyMinute), op: 'inside', value: [480, 660] })
    expect(compile({ left: weekday, op: '==', right: { label: 'Mon' } }).condition).toEqual({ field: operandKey(weekday), op: '==', value: 'Mon' })
  })

  test('refuses a graph that cannot have an entry there, and a clock that is not one', () => {
    const refused: Rule[] = [
      { left: { ...entry, timeframes: ['1h', '1D'] }, op: '==', right: { label: ANY_LABEL } },
      { left: { ...entry, roots: ['4h'] }, op: '==', right: { label: ANY_LABEL } },
      { left: { ...entry, maxStep: 1 }, op: '==', right: { label: ANY_LABEL } },
      { left: entry, op: '>', right: { value: 1 } },
      { left: { ...nyMinute, zone: 'Mars/Olympus' }, op: '>=', right: { value: 1 } },
      { left: { kind: 'bar', interval: '5m', field: 'close' }, op: '>', right: { operand: weekday } }
    ]
    for (const rule of refused) expect(() => compile(rule)).toThrow(RuleError)
  })

  test('reads as a sentence, the clock in hours and minutes', () => {
    const rule: Rule = {
      all: [
        { left: entry, op: '==', right: { label: ANY_LABEL } },
        { left: nyMinute, op: 'inside', right: { band: [480, 660] } }
      ]
    }
    expect(describeRule(rule)).toBe(
      'mtf_arev21_outlier_rank_85 graph entry 5m is any side and time of day (America/New_York) at 5m closes is between 08:00 and 11:00'
    )
    expect(describeRule({ left: nyMinute, op: 'crosses_above', right: { value: 570 } })).toBe('time of day (America/New_York) at 5m closes reaches 09:30')
    expect(formatMinute(0)).toBe('00:00')
    expect(formatMinute(1439)).toBe('23:59')
  })
})
