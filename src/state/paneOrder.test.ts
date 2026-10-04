import { describe, expect, test } from 'bun:test'
import {
  chartPaneStack,
  clampAbove,
  moveSubPane,
  permuteByIndex,
  subPaneMoves,
  swapOrder,
  withoutSubPane
} from './paneOrder'

describe('chartPaneStack', () => {
  test('the price pane on top by default, sub-panes below it in their own order', () => {
    expect(chartPaneStack(['VOL', 'RSI'], 0)).toEqual([null, 'VOL', 'RSI'])
  })

  test('`above` sub-panes sit over the price pane', () => {
    expect(chartPaneStack(['VOL', 'RSI', 'MACD'], 2)).toEqual(['VOL', 'RSI', null, 'MACD'])
    expect(chartPaneStack(['VOL', 'RSI'], 2)).toEqual(['VOL', 'RSI', null])
  })

  test('a stored count the pane cannot honour reads as clamped, never as a lost price pane', () => {
    expect(chartPaneStack(['VOL'], 5)).toEqual(['VOL', null])
    expect(chartPaneStack(['VOL'], -1)).toEqual([null, 'VOL'])
    expect(chartPaneStack(['VOL'], 0.5)).toEqual([null, 'VOL'])
    expect(chartPaneStack([], 3)).toEqual([null])
  })
})

describe('clampAbove', () => {
  test('whole numbers from 0 to the sub-pane count; anything else is the top', () => {
    expect(clampAbove(1, 2)).toBe(1)
    expect(clampAbove(4, 2)).toBe(2)
    expect(clampAbove(-2, 2)).toBe(0)
    expect(clampAbove(Number.NaN, 2)).toBe(0)
    expect(clampAbove(1.5, 2)).toBe(0)
  })
})

describe('moveSubPane', () => {
  test('swaps with the sub-pane above or below, leaving the price pane where it was', () => {
    expect(moveSubPane(['VOL', 'RSI', 'MACD'], 0, 'MACD', -1)).toEqual({ subIndicators: ['VOL', 'MACD', 'RSI'], above: 0 })
    expect(moveSubPane(['VOL', 'RSI', 'MACD'], 0, 'VOL', 1)).toEqual({ subIndicators: ['RSI', 'VOL', 'MACD'], above: 0 })
  })

  test('moving the top sub-pane up takes it above the price pane, and down brings it back', () => {
    const up = moveSubPane(['VOL', 'RSI'], 0, 'VOL', -1)
    expect(up).toEqual({ subIndicators: ['VOL', 'RSI'], above: 1 })
    expect(chartPaneStack(['VOL', 'RSI'], 1)).toEqual(['VOL', null, 'RSI'])
    expect(moveSubPane(['VOL', 'RSI'], 1, 'VOL', 1)).toEqual({ subIndicators: ['VOL', 'RSI'], above: 0 })
  })

  test('a sub-pane can pass its neighbour and then the price pane, ending at the very top', () => {
    expect(moveSubPane(['VOL', 'RSI'], 0, 'RSI', -1)).toEqual({ subIndicators: ['RSI', 'VOL'], above: 0 })
    expect(moveSubPane(['RSI', 'VOL'], 0, 'RSI', -1)).toEqual({ subIndicators: ['RSI', 'VOL'], above: 1 })
    expect(chartPaneStack(['RSI', 'VOL'], 1)).toEqual(['RSI', null, 'VOL'])
  })

  test('null at either end of the stack, and for a name the pane does not hold', () => {
    expect(moveSubPane(['VOL'], 1, 'VOL', -1)).toBeNull()
    expect(moveSubPane(['VOL'], 0, 'VOL', 1)).toBeNull()
    expect(moveSubPane(['VOL'], 0, 'RSI', -1)).toBeNull()
  })
})

describe('subPaneMoves', () => {
  test('up and down only where there is somewhere to go', () => {
    expect(subPaneMoves(['VOL', 'RSI'], 0, 'VOL')).toEqual({ up: true, down: true })
    expect(subPaneMoves(['VOL', 'RSI'], 0, 'RSI')).toEqual({ up: true, down: false })
    expect(subPaneMoves(['VOL', 'RSI'], 1, 'VOL')).toEqual({ up: false, down: true })
    expect(subPaneMoves(['VOL'], 0, 'RSI')).toEqual({ up: false, down: false })
  })
})

describe('withoutSubPane', () => {
  test('a removed sub-pane above the price takes one off the count', () => {
    expect(withoutSubPane(['VOL', 'RSI', 'MACD'], 2, 'VOL')).toEqual({ subIndicators: ['RSI', 'MACD'], above: 1 })
  })

  test('one below the price leaves the count alone', () => {
    expect(withoutSubPane(['VOL', 'RSI', 'MACD'], 1, 'MACD')).toEqual({ subIndicators: ['VOL', 'RSI'], above: 1 })
  })

  test('a name the pane does not hold changes nothing', () => {
    expect(withoutSubPane(['VOL'], 1, 'RSI')).toEqual({ subIndicators: ['VOL'], above: 1 })
  })
})

describe('swapOrder', () => {
  test('the identity with two positions exchanged', () => {
    expect(swapOrder(4, 0, 2)).toEqual([2, 1, 0, 3])
    expect(swapOrder(2, 1, 1)).toEqual([0, 1])
  })
})

describe('permuteByIndex', () => {
  test('an entry follows its pane to the new position', () => {
    expect(permuteByIndex({ 0: 'a', 2: 'c' }, [2, 1, 0])).toEqual({ 0: 'c', 2: 'a' })
  })

  test('a pane with nothing leaves nothing behind where the configured one used to be', () => {
    expect(permuteByIndex({ 0: 'a' }, [1, 0])).toEqual({ 1: 'a' })
  })

  test('positions beyond the order (panes the layout hides) keep their entries', () => {
    expect(permuteByIndex({ 0: 'a', 5: 'f' }, [1, 0])).toEqual({ 1: 'a', 5: 'f' })
  })
})
