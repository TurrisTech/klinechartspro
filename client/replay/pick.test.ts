import { describe, expect, test } from 'bun:test'
import { defaultRange, DEFAULT_RANGE_MS, randomStart } from './pick'
import { fromWall, intervalStart } from './timeframes'

const TZ = 'America/New_York'

function ny(text: string): number {
  const [d, t] = text.split(' ')
  const [y, m, day] = d.split('-').map(Number)
  const [h, mi, s = 0] = t.split(':').map(Number)
  return fromWall(Date.UTC(y, m - 1, day, h, mi, s), TZ)
}

/** A deterministic stand-in for Math.random, cycling the values given. */
function rngOf(values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length]
}

describe('randomStart', () => {
  const range = { from: ny('2024-03-04 00:00'), to: ny('2024-03-15 17:00') }

  test('lands on a base candle open', () => {
    for (const u of [0, 0.13, 0.37, 0.5, 0.71, 0.999]) {
      for (const base of ['5s', '1m', '15m', '1h', '1D']) {
        const at = randomStart(range, base, () => u, TZ)
        expect(at).toBe(intervalStart(base, at, TZ))
      }
    }
  })

  test('stays inside the range, bar the floor onto the candle it opens in', () => {
    for (let i = 0; i < 200; i++) {
      const at = randomStart(range, '1h', () => i / 200, TZ)
      expect(at).toBeLessThanOrEqual(range.to)
      expect(at).toBeGreaterThan(range.from - 86_400_000)
    }
  })

  test('draws inside the closed window rather than rejecting it', () => {
    // 0.42 of this range is Friday 21:00: the market is shut, and the 1h candle that most
    // recently opened is Friday's 21:00 one. The wall draws that; nothing here rejects it.
    const at = randomStart(range, '1h', rngOf([0.42]), TZ)
    expect(at).toBe(ny('2024-03-08 21:00'))
  })

  test('spreads over the range', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 100; i++) seen.add(randomStart(range, '1h', () => i / 100, TZ))
    // 11.7 days of hourly candles: every draw of 100 should be a distinct one.
    expect(seen.size).toBe(100)
  })

  test('an empty range collapses onto its own start', () => {
    const one = ny('2024-03-06 10:30')
    expect(randomStart({ from: one, to: one }, '1h', rngOf([0.9]), TZ)).toBe(ny('2024-03-06 10:00'))
    expect(randomStart({ from: one, to: one - 1 }, '1h', rngOf([0.9]), TZ)).toBe(ny('2024-03-06 10:00'))
  })
})

describe('defaultRange', () => {
  test('ends a day before the newest bar, so a pick has a session ahead of it', () => {
    const latest = ny('2024-03-15 12:00')
    const r = defaultRange(latest)
    expect(r.to).toBe(latest - 86_400_000)
    expect(latest - r.from).toBe(DEFAULT_RANGE_MS)
    expect(r.from).toBeLessThan(r.to)
  })
})
