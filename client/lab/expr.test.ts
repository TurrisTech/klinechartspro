import { describe, expect, test } from 'bun:test'
import { callsOf, checkExpr, compileExpr, type ExprEnv, type ExprScope, exprProblem, evalExpr, parseExpr, timeframeMinutes } from './expr'

const scope: ExprScope = {
  fields: [
    { name: 'a', doc: '' },
    { name: 'b', doc: '' },
    { name: 'child.price', doc: '' },
    { name: 'parent.price', doc: '' },
    { name: 'dir', doc: '' },
    { name: 'side', doc: '' },
    { name: 'gone', doc: '' }
  ],
  prefixes: ['raw'],
  functions: [{ name: 'atr', signature: "atr(period, 'tf')", doc: '', minArgs: 1, maxArgs: 2, literal: true }]
}

function env(values: Record<string, number | string | boolean | undefined>, calls: Record<string, number> = {}): ExprEnv {
  return {
    get: (name) => values[name],
    call: (name, args) => calls[`${name}(${args.join(',')})`]
  }
}

const run = (text: string, values: Record<string, number | string | boolean | undefined> = {}, calls: Record<string, number> = {}) =>
  evalExpr(parseExpr(text), env(values, calls))

describe('parse and evaluate', () => {
  test('arithmetic precedence', () => {
    expect(run('1 + 2 * 3')).toBe(7)
    expect(run('(1 + 2) * 3')).toBe(9)
    expect(run('-2 * -3')).toBe(6)
    expect(run('7 % 4 + 10 / 4')).toBe(5.5)
    expect(run('2e3 + .5')).toBe(2000.5)
  })

  test('comparisons and logic', () => {
    expect(run('1 < 2 and 2 <= 2')).toBe(true)
    expect(run('1 > 2 or 3 >= 3')).toBe(true)
    expect(run('not 1 == 1')).toBe(false)
    expect(run('!(1 != 1) && true')).toBe(true)
    expect(run("side == 'top'", { side: 'top' })).toBe(true)
    expect(run("side != 'top'", { side: 'bottom' })).toBe(true)
  })

  test('the README example', () => {
    const text = '(child.price - parent.price) * dir > 0.5 * atr(14)'
    expect(run(text, { 'child.price': 1.2, 'parent.price': 1.19, dir: 1 }, { 'atr(14)': 0.01 })).toBe(true)
    expect(run(text, { 'child.price': 1.2, 'parent.price': 1.199, dir: 1 }, { 'atr(14)': 0.01 })).toBe(false)
    // A bottom graph: the child lower is further.
    expect(run(text, { 'child.price': 1.18, 'parent.price': 1.19, dir: -1 }, { 'atr(14)': 0.01 })).toBe(true)
  })

  test('unknown propagates, and Kleene logic decides where it can', () => {
    expect(run('gone + 1')).toBeUndefined()
    expect(run('gone > 1')).toBeUndefined()
    expect(run('gone > 1 and 1 > 2')).toBe(false)
    expect(run('gone > 1 or 2 > 1')).toBe(true)
    expect(run('gone > 1 and 2 > 1')).toBeUndefined()
    expect(run('not gone > 1')).toBeUndefined()
    expect(run('1 / 0')).toBeUndefined()
    expect(run("1 == 'x'")).toBeUndefined()
  })

  test('common functions', () => {
    expect(run('abs(-3) + min(4, 2, 9) + max(1, 5)')).toBe(10)
    expect(run('round(1.23456, 2)')).toBe(1.23)
    expect(run("tf('8h') / tf('1h')")).toBe(8)
    expect(run("tf('1D')")).toBe(1440)
    expect(run('min(gone, 1)')).toBeUndefined()
  })

  test('holds only on true', () => {
    const c = compileExpr('a > b', scope)
    expect(c.holds(env({ a: 2, b: 1 }))).toBe(true)
    expect(c.holds(env({ a: 1, b: 2 }))).toBe(false)
    expect(c.holds(env({ a: 1 }))).toBe(false)
    expect(compileExpr('a * 2', scope).number(env({ a: 3 }))).toBe(6)
  })
})

describe('refusals', () => {
  test('syntax', () => {
    expect(exprProblem('', scope)).toContain('empty')
    expect(exprProblem('a +', scope)).toContain('ends too soon')
    expect(exprProblem('(a + b', scope)).toContain('not closed')
    expect(exprProblem('a = b', scope)).toContain("'=='")
    expect(exprProblem("a < b < 'c'", scope)).toContain('chain comparisons')
    expect(exprProblem('a > 3m', scope)).toContain("tf('3m')")
    expect(exprProblem("'open", scope)).toContain('not closed')
    expect(exprProblem('a b', scope)).toContain("unexpected 'b'")
  })

  test('names and functions the slot does not offer', () => {
    expect(exprProblem('c > 1', scope)).toContain("no field 'c'")
    expect(exprProblem('raw.p > 0.5', scope)).toBe('')
    expect(exprProblem('raw > 0.5', scope)).toContain("no field 'raw'")
    expect(exprProblem('ema(14) > 1', scope)).toContain("no function 'ema'")
    expect(exprProblem('atr() > 1', scope)).toContain('takes 1 to 2')
    expect(exprProblem('atr(a) > 1', scope)).toContain('numbers and')
    expect(exprProblem("atr(14, '1h') > 1", scope)).toBe('')
    expect(checkExpr(parseExpr('c + d'), scope)).toHaveLength(2)
  })

  test('the position is reported, one-based', () => {
    expect(exprProblem('a + c', scope)).toBe("no field 'c' here (at 5)")
  })
})

test('callsOf finds literal arguments, nested too', () => {
  const ast = parseExpr("atr(14) > 2 * max(atr(7, '1h'), 1)")
  expect(callsOf(ast, 'atr')).toEqual([[14], [7, '1h']])
  expect(callsOf(parseExpr('atr(-1)'), 'atr')).toEqual([[-1]])
})

test('timeframeMinutes', () => {
  expect(timeframeMinutes('3m')).toBe(3)
  expect(timeframeMinutes('2h')).toBe(120)
  expect(timeframeMinutes('1W')).toBe(10080)
  expect(timeframeMinutes('1M')).toBeUndefined()
  expect(timeframeMinutes('bogus')).toBeUndefined()
})
