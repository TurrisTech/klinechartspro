import { describe, expect, test } from 'bun:test'

import type { KLineData } from 'klinecharts'

import swing, { swingMask } from './swing'

// The definition, written the slow way: strictly above every earlier value in the window,
// at least every later one, and both windows full.
function naiveMask(values: number[], left: number, right: number): boolean[] {
  return values.map((v, i) => {
    if (i < left || i + right > values.length - 1) return false
    for (let j = i - left; j < i; j++) if (!(v > values[j])) return false
    for (let j = i + 1; j <= i + right; j++) if (!(v >= values[j])) return false
    return true
  })
}

function bars(highs: number[], lows: number[]): KLineData[] {
  return highs.map((high, i) => ({ timestamp: i * 60_000, open: high, high, low: lows[i], close: lows[i] }))
}

describe('swingMask', () => {
  test('marks a clear peak and nothing else', () => {
    const values = [1, 2, 3, 4, 5, 4, 3, 2, 1]
    expect(swingMask(values, 2, 2)).toEqual(values.map((_, i) => i === 4))
  })

  test('a peak without a full window on either side is not a swing', () => {
    expect(swingMask([5, 1, 1, 1], 1, 1)).toEqual([false, false, false, false])
    expect(swingMask([1, 1, 1, 5], 1, 1)).toEqual([false, false, false, false])
  })

  test('a plateau of equal highs is one swing, on its first bar', () => {
    expect(swingMask([1, 5, 5, 1, 0], 1, 1)).toEqual([false, true, false, false, false])
  })

  test('matches the naive definition on random walks with ties', () => {
    let seed = 7
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed / 2 ** 31
    }
    for (const [left, right] of [[1, 1], [10, 10], [3, 17], [25, 2], [0, 5], [5, 0]]) {
      let price = 100
      // Rounded to whole ticks so equal values are common.
      const values = Array.from({ length: 3_000 }, () => (price = Math.round(price + (rand() - 0.5) * 4)))
      expect(swingMask(values, left, right)).toEqual(naiveMask(values, left, right))
    }
  })
})

describe('SWING template', () => {
  test('defaults to 10 bars on both sides, circle marker', () => {
    expect(swing.calcParams).toEqual([10, 10, 0])
  })

  test('reports the top at its high and the bottom at its low', () => {
    const highs = [3, 4, 5, 4, 3, 4, 5]
    const lows = [2, 3, 4, 1, 2, 3, 4]
    const indicator = { calcParams: [2, 2, 0] } as unknown as Parameters<NonNullable<typeof swing.calc>>[1]
    const result = swing.calc?.(bars(highs, lows), indicator) as { top?: number; bottom?: number }[]
    expect(result[2]).toEqual({ top: 5 })
    expect(result[3]).toEqual({ bottom: 1 })
    expect(result.filter((r) => r.top !== undefined || r.bottom !== undefined)).toHaveLength(2)
  })
})
