import { describe, expect, test } from 'bun:test'
import { AREV22_HORIZON, buildLabels, priorCentre, type LabBar } from './labels'
import type { LabPoint } from './rules'

const bar = (date: number, close: number, open = close): LabBar => ({ date, open, close })
const sample = (date: number, atCross = true): LabPoint => ({ date, p: 0.5, n: 100, atCross })

describe('buildLabels, next-sample generations', () => {
  const bars = [bar(1, 1.0), bar(2, 1.1), bar(3, 1.2), bar(4, 1.2), bar(5, 1.0), bar(6, 1.3)]

  test("a sample's label is whether the NEXT sample closed higher, stamped at that next sample", () => {
    const labels = buildLabels('arev21', [sample(1), sample(3), sample(4), sample(6)], bars)
    // 1 -> 3 rose, 3 -> 4 is a tie (down), 4 -> 6 rose.
    expect(labels.stamps).toEqual([3, 4, 6])
    expect(Array.from(labels.ups)).toEqual([1, 0, 1])
  })

  test('non-sample bars are not samples', () => {
    const labels = buildLabels('arev19', [sample(1), sample(2, false), sample(5)], bars)
    expect(labels.stamps).toEqual([5])
    expect(Array.from(labels.ups)).toEqual([0])
  })

  test('a sample whose bar is not loaded breaks the chain rather than pairing across it', () => {
    const labels = buildLabels('arev23', [sample(1), sample(99), sample(3), sample(6)], bars)
    expect(labels.stamps).toEqual([6])
  })
})

describe('buildLabels, arev22', () => {
  test('the body midpoint HORIZON bars later against this one, stamped at that later bar', () => {
    const bars = Array.from({ length: AREV22_HORIZON + 3 }, (_, i) => bar(i, 1 + i * 0.01, 1 + i * 0.01))
    bars[AREV22_HORIZON + 1] = bar(AREV22_HORIZON + 1, 0.5, 0.5)
    const labels = buildLabels('arev22', [sample(0), sample(1), sample(2), sample(3)], bars)
    // sample 3's later bar is past the loaded bars: no label yet.
    expect(labels.stamps).toEqual([AREV22_HORIZON, AREV22_HORIZON + 1, AREV22_HORIZON + 2])
    expect(Array.from(labels.ups)).toEqual([1, 0, 1])
  })
})

describe('priorCentre', () => {
  const labels = { stamps: [10, 20, 30, 40], ups: Uint8Array.from([1, 1, 0, 0]) }

  test('counts only labels stamped strictly before the bar', () => {
    const centre = priorCentre([10, 11, 30, 41], labels, 2)
    expect(Number.isNaN(centre[0])).toBe(true) // none before 10
    expect(Number.isNaN(centre[1])).toBe(true) // one label, fewer than a window of 2
    expect(centre[2]).toBe(1) // labels at 10, 20
    expect(centre[3]).toBe(0) // the last two: 30, 40
  })

  test('the window is the last `count` labels', () => {
    expect(priorCentre([41], labels, 4)[0]).toBe(0.5)
    expect(priorCentre([41], labels, 3)[0]).toBeCloseTo(1 / 3, 12)
  })

  test('a large count draws from MIN_PRIOR_LABELS on rather than waiting for the whole window', () => {
    const many = { stamps: Array.from({ length: 60 }, (_, i) => i), ups: new Uint8Array(60).fill(1) }
    const centre = priorCentre([49, 50, 1000], many, 1000)
    expect(Number.isNaN(centre[0])).toBe(true)
    expect(centre[1]).toBe(1)
    expect(centre[2]).toBe(1)
  })
})
