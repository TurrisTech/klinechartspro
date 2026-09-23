import { describe, expect, test } from 'bun:test'
import builtin from '../config/indicators'
import { coverage, holds, resolveParams, sharedParam, usedIndicators, withParam } from './indicatorMatrix'

const pane = (main: string[], sub: string[]) => ({ mainIndicators: main, subIndicatorNames: sub })

describe('usedIndicators', () => {
  test('the union over panes, price-pane rows before sub-pane rows, first appearance first', () => {
    const rows = usedIndicators([pane(['MA'], ['VOL', 'RSI']), pane(['BOLL', 'MA'], ['MACD', 'VOL'])])
    expect(rows).toEqual([
      { name: 'MA', main: true },
      { name: 'BOLL', main: true },
      { name: 'VOL', main: false },
      { name: 'RSI', main: false },
      { name: 'MACD', main: false }
    ])
  })

  test('one template on the price pane and in a sub-pane is two rows', () => {
    const rows = usedIndicators([pane(['EMA'], []), pane([], ['EMA'])])
    expect(rows).toEqual([
      { name: 'EMA', main: true },
      { name: 'EMA', main: false }
    ])
  })

  test('a retained row survives once no pane holds it, in its place', () => {
    const shown = usedIndicators([pane(['MA'], ['VOL', 'RSI'])])
    const rows = usedIndicators([pane(['MA'], ['RSI'])], shown)
    expect(rows).toEqual(shown)
  })

  test('an empty wall has no rows', () => {
    expect(usedIndicators([pane([], []), pane([], [])])).toEqual([])
  })
})

describe('coverage', () => {
  const panes = [pane(['MA'], ['VOL']), pane(['MA'], [])]
  test('all, some and none', () => {
    expect(coverage(panes, { name: 'MA', main: true })).toBe('all')
    expect(coverage(panes, { name: 'VOL', main: false })).toBe('some')
    expect(coverage(panes, { name: 'VOL', main: true })).toBe('none')
  })

  test('placement is part of the question', () => {
    expect(holds(panes[0], { name: 'VOL', main: false })).toBe(true)
    expect(holds(panes[0], { name: 'VOL', main: true })).toBe(false)
  })
})

describe('withParam', () => {
  test('replaces one slot of the live params', () => {
    expect(withParam([5, 10, 30, 60], 1, 20)).toEqual([5, 20, 30, 60])
  })

  test('a slot past the end is padded as empty up to it', () => {
    expect(withParam([5, 10], 3, 60)).toEqual([5, 10, '', 60])
  })

  test('a cleared cell is empty, and a non-number held value reads as empty', () => {
    expect(withParam([12, 26, 9], 2, '')).toEqual([12, 26, ''])
    expect(withParam([12, null, 9], 0, 14)).toEqual([14, '', 9])
  })
})

describe('resolveParams', () => {
  test('numbers within bounds pass through', () => {
    expect(resolveParams([20, 2.5], builtin.BOLL)).toEqual({ params: [20, 2.5] })
  })

  test('an empty cell takes the setting default, as the settings dialog does', () => {
    expect(resolveParams(['', 3], builtin.BOLL)).toEqual({ params: [20, 3] })
  })

  test('an empty optional line is left out and the later ones close up', () => {
    // MA1..MA5 have no default: clearing MA2 removes that line rather than sending a hole.
    expect(resolveParams([5, '', 30, 60], builtin.MA)).toEqual({ params: [5, 30, 60] })
    // MA5 filled in on a four-line MA adds a fifth line.
    expect(resolveParams([5, 10, 30, 60, 120], builtin.MA)).toEqual({ params: [5, 10, 30, 60, 120] })
  })

  test('refuses a value below the minimum or above the maximum, naming the slot', () => {
    expect(resolveParams([0, 2], builtin.BOLL)).toEqual({ problem: { kind: 'below', index: 0, bound: 1 } })
    expect(resolveParams([8, 2, 1], builtin.SESSIONS)).toEqual({ problem: { kind: 'above', index: 1, bound: 1 } })
  })

  test('refuses a fraction where the setting is a whole number', () => {
    expect(resolveParams([20.5, 2], builtin.BOLL)).toEqual({ problem: { kind: 'fraction', index: 0 } })
  })

  test('refuses clearing every optional line', () => {
    expect(resolveParams(['', '', '', '', ''], builtin.MA)).toEqual({ problem: { kind: 'empty' } })
  })

  test('a slot the settings do not describe passes through unchecked', () => {
    expect(resolveParams([10, 10, 0, 7], builtin.SWING)).toEqual({ params: [10, 10, 0, 7] })
  })
})

describe('sharedParam', () => {
  test('the value every holding pane agrees on; panes not holding the row do not count', () => {
    expect(sharedParam([[5, 10], null, [5, 20]], 0)).toBe(5)
  })

  test('mixed where holding panes differ', () => {
    expect(sharedParam([[5, 10], [5, 20]], 1)).toBe('mixed')
  })

  test('empty where no holding pane sets the slot, or no pane holds the row', () => {
    expect(sharedParam([[5, 10, 30, 60], [5, 10, 30, 60]], 4)).toBe('')
    expect(sharedParam([null, null], 0)).toBe('')
  })

  test('a slot set on one pane and unset on another is mixed', () => {
    expect(sharedParam([[5, 10, 30, 60, 120], [5, 10, 30, 60]], 4)).toBe('mixed')
  })
})
