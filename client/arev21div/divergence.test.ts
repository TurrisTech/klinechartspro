import { describe, expect, test } from 'bun:test'
import { AREV21_LOOKBACK, DEFAULT_PARAMS, divergences, ruleOf, swings, type Divergence, type Rule } from './divergence'

// The rule, with no chart: a swing is strict on its left and confirmed on its right, each swing is
// compared with the one immediately before it, and a divergence belongs to the bar that confirmed
// it and to nothing earlier.

const SMALL: Rule = { left: 3, right: 2, minGap: 5, maxGap: 60, minDp: 0, hidden: false }

function book(size = 24) {
  return {
    low: new Array<number>(size).fill(2),
    high: new Array<number>(size).fill(3),
    p: new Array<number>(size).fill(0.5),
    usable: new Array<boolean>(size).fill(true)
  }
}

/** A seeded random walk and a p loosely against the recent move, so divergences occur. */
function market(size: number, seed = 11) {
  let s = seed >>> 0
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
  const normal = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand())
  const close: number[] = []
  let c = 1.2
  for (let i = 0; i < size; i++) {
    c += normal() * 0.002
    close.push(c)
  }
  const spread = close.map(() => Math.abs(normal()) * 0.0015)
  const high = close.map((v, i) => v + spread[i])
  const low = close.map((v, i) => v - spread[i])
  const p = close.map((v, i) => {
    const move = i >= 8 ? v - close[i - 8] : 0
    return Math.min(1, Math.max(0, Math.round((0.48 - 8 * move + normal() * 0.03) * 200) / 200))
  })
  const usable = close.map(() => rand() >= 0.03)
  return { low, high, p, usable }
}

describe('swings', () => {
  test('strict on the left, confirmed on the right, never unconfirmed', () => {
    const low = new Array<number>(20).fill(2)
    low[5] = 1
    low[7] = 1 // an equal low two bars later neither unmakes 5 nor is a swing itself
    low[12] = 0.9
    low[19] = 0.1 // the lowest of all, but nothing after it has confirmed it
    expect(swings(low, 3, 2, 'low').flatMap((s, i) => (s ? [i] : []))).toEqual([5, 12])
  })

  test('a swing high is the mirror image', () => {
    const high = new Array<number>(20).fill(1)
    high[4] = 2
    high[11] = 2.5
    high[12] = 2.6 // tops 11 inside its confirmation window, so 11 is not a swing
    expect(swings(high, 3, 2, 'high').flatMap((s, i) => (s ? [i] : []))).toEqual([4, 12])
  })

  test("at the default left, every swing is a fresh arev21 extreme -- a bar it sampled", () => {
    const { low, high } = market(3000)
    const rule = ruleOf(DEFAULT_PARAMS)
    for (const [side, values] of [['low', low], ['high', high]] as const) {
      const at = swings(values, rule.left, rule.right, side)
      expect(at.some(Boolean)).toBe(true)
      at.forEach((isSwing, i) => {
        if (!isSwing) return
        const before = values.slice(i - AREV21_LOOKBACK, i)
        expect(side === 'low' ? values[i] < Math.min(...before) : values[i] > Math.max(...before)).toBe(true)
      })
    }
  })
})

describe('divergences', () => {
  test('a lower low with a higher p is bullish, dated at its confirmation', () => {
    const b = book()
    ;[b.low[5], b.p[5]] = [1, 0.4]
    ;[b.low[12], b.p[12]] = [0.9, 0.45]
    expect(divergences(b.low, b.high, b.p, b.usable, SMALL)).toEqual([
      { side: 'low', label: 'bull', confirm: 14, swing: 12, previous: 5 }
    ])
  })

  test('a higher high with a lower p is bearish', () => {
    const b = book()
    ;[b.high[6], b.p[6]] = [4, 0.6]
    ;[b.high[15], b.p[15]] = [4.2, 0.52]
    expect(divergences(b.low, b.high, b.p, b.usable, SMALL)).toEqual([
      { side: 'high', label: 'bear', confirm: 17, swing: 15, previous: 6 }
    ])
  })

  test('agreement is not a divergence', () => {
    const b = book()
    ;[b.low[5], b.p[5]] = [1, 0.45]
    ;[b.low[12], b.p[12]] = [0.9, 0.4] // the model followed price down
    expect(divergences(b.low, b.high, b.p, b.usable, SMALL)).toEqual([])
  })

  test('hidden divergences only when asked for', () => {
    const b = book()
    ;[b.low[5], b.p[5]] = [1, 0.45]
    ;[b.low[12], b.p[12]] = [1.1, 0.4] // higher low, lower p
    expect(divergences(b.low, b.high, b.p, b.usable, SMALL)).toEqual([])
    const found = divergences(b.low, b.high, b.p, b.usable, { ...SMALL, hidden: true })
    expect(found.map((d) => [d.label, d.confirm])).toEqual([['hidden_bull', 14]])
  })

  test('minDp refuses a divergence of one vote', () => {
    const b = book()
    ;[b.low[5], b.p[5]] = [1, 0.4]
    ;[b.low[12], b.p[12]] = [0.9, 0.405]
    expect(divergences(b.low, b.high, b.p, b.usable, SMALL)).toHaveLength(1)
    expect(divergences(b.low, b.high, b.p, b.usable, { ...SMALL, minDp: 0.01 })).toEqual([])
  })

  test.each([
    [5, 60, 1],
    [8, 60, 0],
    [1, 6, 0]
  ])('the swings must be minGap..maxGap bars apart (%i..%i)', (minGap, maxGap, count) => {
    const b = book()
    ;[b.low[5], b.p[5]] = [1, 0.4]
    ;[b.low[12], b.p[12]] = [0.9, 0.45] // seven bars apart
    expect(divergences(b.low, b.high, b.p, b.usable, { ...SMALL, minGap, maxGap })).toHaveLength(count)
  })

  test('a swing without a usable p is never compared', () => {
    const b = book()
    ;[b.low[5], b.p[5]] = [1, 0.4]
    ;[b.low[12], b.p[12]] = [0.9, 0.45]
    b.usable[5] = false
    expect(divergences(b.low, b.high, b.p, b.usable, SMALL)).toEqual([])
  })

  test('each swing is compared with the one immediately before it', () => {
    // Skipping a swing with no p would compare across whatever it did to price: here the skipped
    // swing is the lowest of the three, and 14-against-5 would read as a divergence.
    const b = book(30)
    ;[b.low[5], b.p[5]] = [1, 0.4]
    b.low[9] = 0.8
    b.usable[9] = false
    ;[b.low[14], b.p[14]] = [0.95, 0.45]
    expect(divergences(b.low, b.high, b.p, b.usable, SMALL)).toEqual([])
  })

  test('nothing after the confirming bar changes a divergence', () => {
    // The no-lookahead property, directly: cut the series anywhere, and the divergences found on
    // what is left are exactly the whole series' ones confirmed before the cut.
    const m = market(2500)
    const rule = { ...ruleOf(DEFAULT_PARAMS), hidden: true }
    const key = (d: Divergence) => `${d.side}|${d.label}|${d.confirm}|${d.swing}|${d.previous}`
    const whole = divergences(m.low, m.high, m.p, m.usable, rule)
    expect(new Set(whole.map((d) => d.label))).toEqual(new Set(['bull', 'bear', 'hidden_bull', 'hidden_bear']))
    for (const cut of [300, 777, 1234, 2001, 2499]) {
      const seen = divergences(m.low.slice(0, cut), m.high.slice(0, cut), m.p.slice(0, cut), m.usable.slice(0, cut), rule)
      expect(new Set(seen.map(key))).toEqual(new Set(whole.filter((d) => d.confirm < cut).map(key)))
    }
  })
})

describe('the rule from the settings dialog', () => {
  test('the defaults', () => {
    expect(ruleOf(DEFAULT_PARAMS)).toEqual({ left: 10, right: 5, minGap: 5, maxGap: 60, minDp: 0, hidden: false })
    expect(ruleOf(undefined)).toEqual(ruleOf(DEFAULT_PARAMS))
  })

  test('clamped, coerced, and junk falls back to the default', () => {
    expect(ruleOf([1, '7', 5, 1e6, 'x', 1])).toEqual({ left: 2, right: 7, minGap: 5, maxGap: 1000, minDp: 0, hidden: true })
    expect(ruleOf([10.4, 5, 5, 60, 0.0123, 0]).left).toBe(10)
    expect(ruleOf([10, 5, 5, 60, 0.0123, 0]).minDp).toBeCloseTo(0.0123)
  })

  test('an inverted gap window is widened rather than left to match nothing', () => {
    expect(ruleOf([10, 5, 90, 20, 0, 0]).maxGap).toBe(90)
  })
})
