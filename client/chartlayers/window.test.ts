import { describe, expect, test } from 'bun:test'
import type { LayerWindow } from './types'
import { contains, missingWindows, PREFETCH_FRACTION, targetWindow } from './window'

// The arithmetic that decides whether moving the view costs a request. Its contract is
// stated once, in missingWindows' own comment: the rectangles it returns tile
// `target \ loaded` exactly, so fetching them and merging is the same answer as refetching
// `target` whole -- and everything already held is paid for once.

function w(priceMin: number, priceMax: number, from: number, to: number): LayerWindow {
  return { priceMin, priceMax, from, to }
}

const VIEW = w(1.0, 1.1, 1000, 2000)

describe('contains', () => {
  test('a window contains itself and anything inside it', () => {
    expect(contains(VIEW, VIEW)).toBe(true)
    expect(contains(VIEW, w(1.02, 1.08, 1200, 1800))).toBe(true)
  })
  test('one axis reaching past it is enough to miss', () => {
    expect(contains(VIEW, w(0.99, 1.1, 1000, 2000))).toBe(false)
    expect(contains(VIEW, w(1.0, 1.11, 1000, 2000))).toBe(false)
    expect(contains(VIEW, w(1.0, 1.1, 999, 2000))).toBe(false)
    expect(contains(VIEW, w(1.0, 1.1, 1000, 2001))).toBe(false)
  })
})

describe('targetWindow', () => {
  test('the first fetch buys the margin on every side', () => {
    const first = targetWindow(null, VIEW)
    expect(first).toEqual(w(1.0 - 0.05, 1.1 + 0.05, 1000 - 500, 2000 + 500))
    expect(contains(first, VIEW)).toBe(true)
  })

  test('a pan to the right extends only to the right', () => {
    const held = w(0.95, 1.15, 500, 2500)
    const target = targetWindow(held, w(1.0, 1.1, 1750, 2750))
    expect(target).toEqual(w(0.95, 1.15, 500, 2750 + 500))
    expect(missingWindows(held, target)).toHaveLength(1)
  })

  test('a price-axis rescale downwards extends only downwards', () => {
    const held = w(0.95, 1.15, 500, 2500)
    const target = targetWindow(held, w(0.9, 1.1, 1000, 2000))
    expect(target).toEqual(w(0.9 - 0.1, 1.15, 500, 2500))  // pad = half the 0.2 needed span
    expect(missingWindows(held, target)).toHaveLength(1)
  })

  test('the margin is a fraction of the VISIBLE span, never of the accumulated one', () => {
    // Otherwise a pane that has panned all morning grows its window by a fraction of that
    // width per step, and each request is bigger than the last.
    const wide = w(0.5, 2.0, 0, 100_000)
    const target = targetWindow(wide, w(1.0, 1.1, 100_000, 101_000))
    expect(target.to).toBe(101_000 + 1000 * PREFETCH_FRACTION)
  })

  test('always contains both what is held and what is needed', () => {
    const held = w(0.95, 1.15, 500, 2500)
    for (const needed of [w(0.9, 1.2, 0, 3000), w(1.0, 1.1, 1000, 2000), w(1.1, 1.3, 2400, 2600)]) {
      const target = targetWindow(held, needed)
      expect(contains(target, held)).toBe(true)
      expect(contains(target, needed)).toBe(true)
    }
  })
})

describe('missingWindows', () => {
  test('nothing is missing when the target is already held', () => {
    expect(missingWindows(VIEW, VIEW)).toEqual([])
    expect(missingWindows(w(0.9, 1.2, 0, 3000), VIEW)).toEqual([])
  })

  test('a pan to the right asks only for the new time span, at the held price band', () => {
    const target = w(1.0, 1.1, 1000, 2500)
    const gaps = missingWindows(VIEW, target)
    expect(gaps).toEqual([w(1.0, 1.1, 2000, 2500)])
  })

  test('a price-axis rescale asks only for the new bands, across the whole time span', () => {
    const target = w(0.9, 1.2, 1000, 2000)
    const gaps = missingWindows(VIEW, target)
    expect(gaps).toEqual([w(0.9, 1.0, 1000, 2000), w(1.1, 1.2, 1000, 2000)])
  })

  test('growing on both axes tiles the difference in four rectangles', () => {
    const target = w(0.9, 1.2, 500, 2500)
    const gaps = missingWindows(VIEW, target)
    expect(gaps).toHaveLength(4)
    expect(area(gaps)).toBeCloseTo(area([target]) - area([VIEW]), 9)
    for (const gap of gaps) expect(overlapArea(gap, VIEW)).toBeCloseTo(0, 12)
    for (let i = 0; i < gaps.length; i++) {
      for (let j = i + 1; j < gaps.length; j++) {
        expect(overlapArea(gaps[i], gaps[j])).toBeCloseTo(0, 12)
      }
    }
  })

  test('over a long session of panning the held window grows a screen at a time', () => {
    // Sixteen pans of a quarter-screen each: what is fetched must stay bounded by the pan,
    // not compound. This is what stops a chart left open all day from re-reading the book.
    let held = targetWindow(null, VIEW)
    let fetched = 0
    for (let step = 1; step <= 16; step++) {
      const view = w(1.0, 1.1, 1000 + step * 250, 2000 + step * 250)
      if (contains(held, view)) continue
      const target = targetWindow(held, view)
      fetched += missingWindows(held, target).length
      held = target
      expect(contains(held, view)).toBe(true)
    }
    // A quarter-screen pan inside a half-screen margin leaves the held window every other
    // step at worst, and each miss is a SINGLE rectangle -- the price band never moved, so
    // nothing is fetched for it. Padding the union all round instead gives 20.
    expect(fetched).toBeLessThanOrEqual(8)
  })
})

function area(windows: readonly LayerWindow[]): number {
  return windows.reduce((sum, x) => sum + (x.priceMax - x.priceMin) * (x.to - x.from), 0)
}

function overlapArea(a: LayerWindow, b: LayerWindow): number {
  const price = Math.max(0, Math.min(a.priceMax, b.priceMax) - Math.max(a.priceMin, b.priceMin))
  const time = Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from))
  return price * time
}
