import { describe, expect, test } from 'bun:test'
import { coverage, holds, usedIndicators } from './indicatorMatrix'

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
