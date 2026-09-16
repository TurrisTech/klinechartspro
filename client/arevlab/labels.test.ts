import { describe, expect, test } from 'bun:test'
import { AREV22_HORIZON, MIN_PRIOR_LABELS, buildLabels, priorCentre, type LabBar } from './labels'
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
  const DAY = 86_400_000
  /** `count` labels a day apart from day 1, the first `ups` of them up. */
  const daily = (count: number, ups: number) => ({
    stamps: Array.from({ length: count }, (_, i) => (i + 1) * DAY),
    ups: Uint8Array.from(Array.from({ length: count }, (_, i) => (i < ups ? 1 : 0)))
  })

  test('counts the labels stamped in [date - span, date)', () => {
    const labels = daily(40, 20) // days 1..20 up, 21..40 down
    const centre = priorCentre([21 * DAY, 41 * DAY], labels, 20 * DAY)
    // At day 21 the window holds days 1..20, every one of them up.
    expect(centre[0]).toBe(1)
    // At day 41 it holds days 21..40, none of them up.
    expect(centre[1]).toBe(0)
  })

  test('a label on the window edge is in, and its own bar is out', () => {
    const labels = daily(30, 30)
    // The label stamped exactly at date - span counts; one stamped at the date itself does not.
    expect(priorCentre([31 * DAY], { stamps: labels.stamps, ups: labels.ups }, 30 * DAY)[0]).toBe(1)
    expect(Number.isNaN(priorCentre([1 * DAY], labels, 30 * DAY)[0])).toBe(true)
  })

  test('too few labels in the window draws nothing', () => {
    const labels = daily(MIN_PRIOR_LABELS + 5, MIN_PRIOR_LABELS + 5)
    const short = priorCentre([(MIN_PRIOR_LABELS + 6) * DAY], labels, 3 * DAY)
    expect(Number.isNaN(short[0])).toBe(true)
    const long = priorCentre([(MIN_PRIOR_LABELS + 6) * DAY], labels, 365 * DAY)
    expect(long[0]).toBe(1)
  })
})
